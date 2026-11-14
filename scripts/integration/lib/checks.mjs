// Auswertung: eine Prüfung aus expect.mjs + beobachtete Antwort(en) -> Ergebnis.
// Rein und ohne Netzwerk; was abgefragt wird, beschreibt `requestsFor`, das
// Abfragen selbst macht run.mjs.
//
// Antwortform (von run.mjs normalisiert):
//   { status, headers: { <kleingeschriebener Name>: Wert }, error? }
// `error` ist gesetzt, wenn gar keine HTTP-Antwort kam (DNS, TLS, Timeout).
//
// Ergebnis: { state: 'pass' | 'fail' | 'skip', detail }

import { TEST_PATH, TEST_QUERY } from './expect.mjs'
import { triggerChanges, planEnv } from '../../reconcile-builds/lib/plan.mjs'

const pass = detail => ({ state: 'pass', detail })
const fail = detail => ({ state: 'fail', detail })
const skip = detail => ({ state: 'skip', detail })

const describe = r => (r.error ? `keine Antwort (${r.error})` : `HTTP ${r.status}`)
const hostOf = url => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Kurzer Titel einer Prüfung für Annotations und Tabelle. */
export function title(c) {
  switch (c.type) {
    case 'canonical':
      return `${c.host} antwortet über HTTPS`
    case 'https':
      return `http://${c.host} -> https://`
    case 'redirect':
      return `${c.host} -> ${c.status} ${hostOf(c.location)}`
    case 'hsts-redirect':
      return `HSTS auf ${c.host}`
    case 'headers':
      return `Security-Header auf ${c.host}`
    case 'workers-dev':
      return `workers.dev von ${c.worker} abgeschaltet`
    case 'previews':
      return `Previews von ${c.worker} hinter Access`
    case 'builds':
      return `Trigger cfd:${c.role} von ${c.worker}`
    default:
      return c.type
  }
}

/** URL, die eine HTTP-Prüfung abfragt (ohne Cloudflare-API). */
export function urlFor(c, { workersSubdomain } = {}) {
  switch (c.type) {
    case 'canonical':
    case 'headers':
      return `https://${c.host}/`
    case 'https':
      return `http://${c.host}${TEST_PATH}?${TEST_QUERY}`
    case 'redirect':
    case 'hsts-redirect':
      return `https://${c.host}${TEST_PATH}?${TEST_QUERY}`
    case 'workers-dev':
      return workersSubdomain ? `https://${c.worker}.${workersSubdomain}.workers.dev/` : null
    default:
      return null
  }
}

export function evaluateCanonical(c, r) {
  if (r.error) return fail(describe(r))
  const server = r.headers.server ?? ''
  if (r.status >= 200 && r.status < 300) {
    if (server.toLowerCase() !== 'cloudflare') return fail(`HTTP ${r.status}, aber \`server: ${server || '(fehlt)'}\` statt cloudflare`)
    return pass(`HTTP ${r.status}, server: cloudflare`)
  }
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.location ?? ''
    // Relative Weiterleitungen und solche auf denselben Host (z. B. auf einen
    // Pfad mit Slash) gehören zur Seite selbst, alles andere nicht.
    const target = hostOf(new URL(loc, `https://${c.host}/`).href)
    if (target === c.host) return pass(`HTTP ${r.status} innerhalb der Domain (${loc})`)
    return fail(`HTTP ${r.status} auf fremde Domain: ${loc}`)
  }
  return fail(describe(r))
}

export function evaluateHttps(c, r) {
  if (r.error) return fail(describe(r))
  const loc = r.headers.location ?? ''
  const want = `https://${c.host}${TEST_PATH}?${TEST_QUERY}`
  if (r.status >= 300 && r.status < 400 && loc === want) return pass(`HTTP ${r.status} -> ${loc}`)
  if (r.status >= 300 && r.status < 400 && loc.startsWith(`https://${c.host}/`)) {
    return fail(`HTTP ${r.status} -> ${loc}, Pfad/Query gingen verloren (erwartet ${want})`)
  }
  return fail(`${describe(r)}${loc ? ` -> ${loc}` : ''}, erwartet Weiterleitung auf ${want}`)
}

export function evaluateRedirect(c, r) {
  if (r.error) return fail(describe(r))
  const loc = r.headers.location ?? ''
  if (r.status === c.status && loc === c.location) return pass(`HTTP ${r.status} -> ${loc}`)
  return fail(`${describe(r)}${loc ? ` -> ${loc}` : ' ohne Location'}, erwartet ${c.status} -> ${c.location}`)
}

export function evaluateHstsRedirect(c, r) {
  if (r.error) return fail(describe(r))
  const v = r.headers['strict-transport-security']
  if (v === c.value) return pass(`${v}`)
  return fail(`Strict-Transport-Security ist ${v === undefined ? 'nicht gesetzt' : `"${v}"`}, erwartet "${c.value}"`)
}

export function evaluateHeaders(c, r) {
  if (r.error) return fail(describe(r))
  if (r.status < 200 || r.status >= 300) return fail(`${describe(r)} – Header nur auf einer 2xx-Antwort aussagekräftig`)

  const problems = []
  const notes = []
  const exactKeys = new Set(Object.keys(c.exact).map(k => k.toLowerCase()))

  for (const [name, want] of Object.entries(c.exact)) {
    const got = r.headers[name.toLowerCase()]
    if (got !== want) {
      problems.push(`${name} ist ${got === undefined ? 'nicht gesetzt' : `"${got}"`}, erwartet "${want}" (vom Repo gesetzt)`)
    } else notes.push(`${name}: ${got} (Repo)`)
  }

  for (const [name, want] of Object.entries(c.engine)) {
    if (exactKeys.has(name.toLowerCase())) continue
    const got = r.headers[name.toLowerCase()]
    if (got === undefined) problems.push(`${name} fehlt`)
    else if (got === want) notes.push(`${name} ok`)
    // Ohne overrideExisting hat ein Header der Seite Vorrang – ein anderer
    // Wert ist dann kein Fehler, sondern Absicht des Repos.
    else if (c.override) problems.push(`${name} ist "${got}", erwartet "${want}" (overrideExisting)`)
    else notes.push(`${name}: "${got}" (von der Seite, Vorrang vor der Engine)`)
  }

  return problems.length ? fail(problems.join('; ')) : pass(notes.join('; '))
}

export function evaluateWorkersDev(c, r) {
  // Kein DNS-Eintrag oder Verbindungsfehler: erst recht nicht erreichbar.
  if (r.error) return pass(describe(r))
  if (r.status >= 200 && r.status < 400) return fail(`HTTP ${r.status} – workers.dev liefert die Seite noch aus`)
  return pass(`HTTP ${r.status}`)
}

/**
 * Preview-URL ohne Anmeldung: Access leitet auf die Login-Seite
 * (*.cloudflareaccess.com) um oder lehnt ab.
 */
export function evaluatePreview(url, r) {
  if (r.error) return fail(`${url}: ${describe(r)}`)
  const loc = r.headers.location ?? ''
  if (r.status >= 300 && r.status < 400 && hostOf(loc).endsWith('.cloudflareaccess.com')) {
    return pass(`${url}: HTTP ${r.status} -> ${hostOf(loc)}`)
  }
  if (r.status === 401 || r.status === 403) return pass(`${url}: HTTP ${r.status}`)
  return fail(`${url}: ${describe(r)}${loc ? ` -> ${loc}` : ''} – ohne Login erreichbar oder unerwartet`)
}

/**
 * Preview-URLs aus dem Versionsverlauf eines Workers: die jüngste Version mit
 * Preview und – falls gesetzt – ihr Alias. Liefert `null`, wenn es keine gibt.
 */
export function previewUrls(worker, subdomain, versions) {
  const v = (versions ?? []).find(x => x.metadata?.has_preview === true)
  if (!v) return null
  const urls = [`https://${v.id.slice(0, 8)}-${worker}.${subdomain}.workers.dev/`]
  const alias = (versions ?? []).find(x => x.metadata?.has_preview === true && x.annotations?.['workers/alias'])
  if (alias) urls.unshift(`https://${alias.annotations['workers/alias']}-${worker}.${subdomain}.workers.dev/`)
  return urls
}

export function evaluateBuilds(c, triggers, env) {
  const own = (triggers ?? []).filter(t => t.trigger_name === c.desired.trigger_name)
  if (own.length === 0) return fail(`Trigger ${c.desired.trigger_name} fehlt`)
  if (own.length > 1) return fail(`Trigger ${c.desired.trigger_name} gibt es ${own.length}-mal`)
  const changes = triggerChanges(own[0], c.desired)
  const problems = changes.map(ch => `${ch.field}: ${JSON.stringify(ch.from)} statt ${JSON.stringify(ch.to)}`)
  if (env) {
    const { set } = planEnv(env, c.env)
    for (const k of Object.keys(set)) problems.push(`Variable ${k} weicht ab`)
  }
  return problems.length ? fail(problems.join('; ')) : pass(`${c.desired.deploy_command} (${c.desired.branch_includes.join(', ')}${c.desired.branch_excludes.length ? ` ohne ${c.desired.branch_excludes.join(', ')}` : ''})`)
}

export const evaluators = {
  canonical: evaluateCanonical,
  https: evaluateHttps,
  redirect: evaluateRedirect,
  'hsts-redirect': evaluateHstsRedirect,
  headers: evaluateHeaders,
  'workers-dev': evaluateWorkersDev,
}

export { pass, fail, skip }
