// Führt die Prüfungen aus expect.mjs live aus. Ausschließlich GET-Requests –
// gegen die Seiten wie gegen die Cloudflare-API –, damit das Skript auch gegen
// Produktivseiten laufen darf.
//
// Frisch angelegte Domains brauchen Zeit (Custom-Domain-Zertifikat, DNS,
// Regel-Verteilung). Eine fehlgeschlagene Prüfung wird deshalb mit
// wachsendem Abstand wiederholt, bis sie besteht oder das Zeitbudget
// (`maxWaitMs`, für alle Prüfungen gemeinsam) aufgebraucht ist.
//
// `fetch` und `sleep` werden hereingereicht, damit die Tests ohne Netz und
// ohne Wartezeit auskommen.

import { createClient as createBuildsClient } from '../../reconcile-builds/lib/cloudflare.mjs'
import {
  evaluators,
  evaluatePreview,
  evaluateBuilds,
  previewUrls,
  title,
  urlFor,
  fail,
  skip,
} from './checks.mjs'

const CF_API = 'https://api.cloudflare.com/client/v4'
const USER_AGENT = 'cloudflare-domains-integration'

/** Ein GET ohne Weiterleitungen zu folgen; normalisiert auf { status, headers, error }. */
export async function probe(url, { fetch = globalThis.fetch, timeoutMs = 15000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const headers = {}
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    // Den Inhalt brauchen wir nicht; abbrechen statt herunterladen.
    await res.body?.cancel?.().catch(() => {})
    return { status: res.status, headers }
  } catch (err) {
    return { status: 0, headers: {}, error: err.cause?.code ?? err.name ?? String(err) }
  }
}

/** Minimaler, rein lesender Client für die Teile der Cloudflare-API, die die Prüfungen brauchen. */
export function createApi({ token, accountId, fetch = globalThis.fetch }) {
  async function get(path, { account = true } = {}) {
    const res = await fetch(`${CF_API}${account ? `/accounts/${accountId}` : ''}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.success === false) {
      const errs = (json.errors ?? []).map(e => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ')
      throw new Error(`Cloudflare GET ${path} -> ${res.status} ${errs}`.trim())
    }
    return json.result
  }
  const builds = createBuildsClient({ token, accountId, fetch })
  return {
    async zones() {
      // Die Zonen-API liefert höchstens 50 je Seite.
      const names = []
      for (let page = 1; ; page++) {
        const r = await get(`/zones?account.id=${accountId}&per_page=50&page=${page}`, { account: false })
        names.push(...r.map(z => z.name))
        if (r.length < 50) return names
      }
    },
    workersSubdomain: () => get('/workers/subdomain').then(r => r.subdomain),
    scriptSubdomain: w => get(`/workers/scripts/${w}/subdomain`),
    versions: w => get(`/workers/scripts/${w}/versions?per_page=20`).then(r => r.items ?? []),
    listScripts: builds.listScripts,
    listTriggers: builds.listTriggers,
    listEnv: builds.listEnv,
  }
}

/** Führt eine Prüfung einmal aus. */
async function attempt(c, ctx) {
  const evaluate = evaluators[c.type]
  if (evaluate) {
    const url = urlFor(c, ctx)
    if (!url) return skip('workers.dev-Subdomain des Accounts unbekannt (Cloudflare-Token oder --workers-subdomain fehlt)')
    return evaluate(c, await probe(url, ctx))
  }

  if (!ctx.api) return skip('braucht die Cloudflare-API (CLOUDFLARE_API_TOKEN und CLOUDFLARE_ACCOUNT_ID)')

  if (c.type === 'previews') {
    if (!ctx.workersSubdomain) return skip('workers.dev-Subdomain des Accounts unbekannt')
    const sub = await ctx.api.scriptSubdomain(c.worker)
    if (sub.previews_enabled === false) {
      return c.engineKeepsOn
        ? fail('Preview-URLs sind abgeschaltet, obwohl die Engine sie bei disableWorkersDev + protectPreviews anlässt')
        : skip('Preview-URLs sind am Worker abgeschaltet (preview_urls) – nichts zu schützen')
    }
    const urls = previewUrls(c.worker, ctx.workersSubdomain, await ctx.api.versions(c.worker))
    if (!urls) return skip('keine Version mit Preview vorhanden')
    const results = []
    for (const url of urls) results.push(evaluatePreview(url, await probe(url, ctx)))
    const failed = results.filter(r => r.state === 'fail')
    return { state: failed.length ? 'fail' : 'pass', detail: results.map(r => r.detail).join('; ') }
  }

  if (c.type === 'builds') {
    const scripts = (ctx.scripts ??= await ctx.api.listScripts())
    const tag = scripts.find(s => s.id === c.worker)?.tag
    if (!tag) return fail(`Worker ${c.worker} existiert nicht`)
    const triggers = await ctx.api.listTriggers(tag)
    const own = triggers.find(t => t.trigger_name === c.desired.trigger_name)
    const env = own ? await ctx.api.listEnv(own.trigger_uuid) : null
    return evaluateBuilds(c, triggers, env)
  }

  return fail(`unbekannter Prüftyp ${c.type}`)
}

/** Prüfung mit Wiederholungen bis zum gemeinsamen Zeitbudget. */
async function runCheck(c, ctx) {
  let delay = ctx.baseDelayMs
  let tries = 0
  for (;;) {
    tries++
    let result
    try {
      result = await attempt(c, ctx)
    } catch (err) {
      result = fail(err.message)
    }
    if (result.state !== 'fail' || ctx.now() + delay > ctx.deadline) return { ...result, tries }
    ctx.log(`… ${title(c)}: ${result.detail} – neuer Versuch in ${Math.round(delay / 1000)} s`)
    await ctx.sleep(delay)
    delay = Math.min(delay * 2, ctx.maxDelayMs)
  }
}

/**
 * @param {{slug, checks}[]} sites  Ergebnis von deriveChecks()
 * @param {object} opts
 * @returns {Promise<{slug, results: {check, title, state, detail, tries}[]}[]>}
 */
export async function runChecks(sites, opts = {}) {
  const ctx = {
    fetch: opts.fetch ?? globalThis.fetch,
    sleep: opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    now: opts.now ?? Date.now,
    log: opts.log ?? (() => {}),
    api: opts.api ?? null,
    workersSubdomain: opts.workersSubdomain ?? null,
    baseDelayMs: opts.baseDelayMs ?? 5000,
    maxDelayMs: opts.maxDelayMs ?? 60000,
    timeoutMs: opts.timeoutMs ?? 15000,
  }
  ctx.deadline = ctx.now() + (opts.maxWaitMs ?? 600000)

  // Parallel, aber begrenzt – die Seiten sollen keine Lastspitze sehen.
  const jobs = sites.flatMap(s => s.checks.map(c => ({ slug: s.slug, c })))
  const out = new Array(jobs.length)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      const r = await runCheck(jobs[i].c, ctx)
      out[i] = { slug: jobs[i].slug, check: jobs[i].c, title: title(jobs[i].c), ...r }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker))

  return sites.map(s => ({ slug: s.slug, results: out.filter(r => r.slug === s.slug) }))
}
