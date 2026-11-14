// Leitet aus den Site-Dateien ab, was live zu sehen sein muss. Reine Funktion,
// kein Netzwerk: dieselben Eingaben wie Terraform (Site-Dateien +
// `_defaults.json`), dieselbe Misch-Logik, und als Ergebnis eine Liste von
// Prüfungen je Site, die der Runner (run.mjs) gegen das Netz ausführt.
//
// Die Regeln spiegeln modules/site-plan wider. Wo es geht, wird Code der
// anderen Skripte wiederverwendet: das flache Mischen der Defaults aus
// check-wrangler, die Normalisierung des `builds`-Blocks und die Soll-Trigger
// aus reconcile-builds.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { mergeDefaults } from '../../check-wrangler/check.mjs'
import { normalizeSites as normalizeBuilds } from '../../reconcile-builds/lib/config.mjs'
import { desiredTrigger, ROLES } from '../../reconcile-builds/lib/plan.mjs'

// Pfad und Query, mit denen Weiterleitungen geprüft werden. Bewusst ohne
// Sonderzeichen, damit kein Kodierungsunterschied als Fehler zählt.
export const TEST_PATH = '/cfd-integrationstest/pfad'
export const TEST_QUERY = 'cfd=1&q=test'

// Werte wie in modules/site-plan/security_headers.tf.
export const SECURITY_DEFAULTS = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
})

const HSTS = 'Strict-Transport-Security'

/** Liest `<dir>/*.json` und `<dir>/_defaults.json` ungemischt. */
export function readSitesDir(dir) {
  const raw = {}
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_defaults.json').sort()) {
    raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  }
  const p = join(dir, '_defaults.json')
  const defaults = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  return { raw, defaults }
}

/**
 * Ist `domain` der Apex seiner Zone? Mit Zonenliste exakt wie die Engine
 * (Zone = längster passender Suffix), ohne Zonenliste als Näherung „genau zwei
 * Labels“ – die passt für .de/.com/.online, nicht für co.uk.
 */
export function isZoneApex(domain, zones) {
  if (zones) return zones.includes(domain)
  return domain.split('.').length === 2
}

/** Die Header, die die Engine für eine Site setzt (leer = abgeschaltet). */
export function securityHeaders(raw) {
  const obj = raw !== null && typeof raw === 'object'
  const enabled = obj ? raw.enabled !== false : raw === true
  if (!enabled) return null

  const cfg = obj ? raw : {}
  const headers = {}

  const hsts = cfg.hsts
  const hstsOn = hsts !== null && typeof hsts === 'object' ? hsts.enabled !== false : hsts !== false
  if (hstsOn) {
    const h = typeof hsts === 'object' && hsts !== null ? hsts : {}
    headers[HSTS] = [
      `max-age=${h.maxAge ?? 31536000}`,
      ...(h.includeSubDomains === true ? ['includeSubDomains'] : []),
      ...(h.preload === true ? ['preload'] : []),
    ].join('; ')
  }
  const text = (field, name) => {
    const v = cfg[field]
    if (v === false) return
    headers[name] = v === undefined || v === null ? SECURITY_DEFAULTS[name] : String(v)
  }
  text('referrerPolicy', 'Referrer-Policy')
  text('permissionsPolicy', 'Permissions-Policy')
  if (cfg.contentTypeOptions !== false) headers['X-Content-Type-Options'] = 'nosniff'
  text('frameOptions', 'X-Frame-Options')

  return { headers, override: cfg.overrideExisting === true }
}

/**
 * Site-Dateien -> Prüfungen.
 *
 * @param {object} raw       slug -> Inhalt der Site-Datei
 * @param {object} defaults  Inhalt von `_defaults.json`
 * @param {object} opts
 * @param {string[]} [opts.zones]  Zonennamen des Accounts (für redirectWWW)
 * @param {string[]} [opts.only]   nur diese Slugs
 * @returns {{ sites: {slug, checks}[], errors: string[] }}
 */
export function deriveChecks(raw, defaults = {}, { zones = null, only = null } = {}) {
  const errors = []
  const sites = []
  const zoneList = zones ? zones.map(z => z.toLowerCase()) : null

  if (only) {
    for (const s of only) if (!(s in raw)) errors.push(`--site ${s}: keine Datei ${s}.json`)
  }

  const builds = normalizeBuilds(raw, defaults)
  errors.push(...builds.errors)
  const buildsBySlug = new Map(builds.sites.map(b => [b.slug, b]))

  for (const slug of Object.keys(raw).sort()) {
    if (only && !only.includes(slug)) continue
    const site = raw[slug]
    if (site.enabled === false || site.integration?.enabled === false) continue

    const checks = []
    const b = buildsBySlug.get(slug)

    // Wie modules/site-plan: zuständig nur, wenn die Site-Datei selbst
    // `domains.enabled = true` setzt – ein `enabled` in den Defaults zählt nicht.
    if (site.domains?.enabled === true) {
      const d = mergeDefaults(defaults, site).domains
      const canonical = String(d.canonicalDomain).toLowerCase()
      const declared = (d.redirectDomains ?? []).map(x => x.toLowerCase())
      const www =
        d.redirectWWW === true
          ? [canonical, ...declared]
              .filter(x => !x.startsWith('www.') && isZoneApex(x, zoneList) && `www.${x}` !== canonical)
              .map(x => `www.${x}`)
          : []
      const redirects = [...new Set([...declared, ...www])]
      const status = d.redirectStatusCode ?? 301
      const preserveQuery = d.preserveQueryString !== false
      const sec = securityHeaders(d.securityHeaders ?? false)

      checks.push({ type: 'canonical', host: canonical })
      if (d.alwaysUseHttps !== false) checks.push({ type: 'https', host: canonical })

      for (const host of redirects) {
        const target = `https://${canonical}${TEST_PATH}${preserveQuery ? `?${TEST_QUERY}` : ''}`
        checks.push({ type: 'redirect', host, status, location: target })
        if (sec?.headers[HSTS]) checks.push({ type: 'hsts-redirect', host, value: sec.headers[HSTS] })
      }

      // Header, die das Repo selbst setzt und die die Engine nicht anfassen
      // darf (optional, `integration.expectHeaders` in der Site-Datei).
      const expectHeaders = site.integration?.expectHeaders ?? {}
      if (sec || Object.keys(expectHeaders).length > 0) {
        checks.push({
          type: 'headers',
          host: canonical,
          engine: sec?.headers ?? {},
          override: sec?.override ?? false,
          exact: expectHeaders,
        })
      }

      if (d.disableWorkersDev === true) checks.push({ type: 'workers-dev', worker: d.workerName })

      // protectPreviews wird wie in modules/site-plan/access.tf feldweise mit
      // den Defaults gemischt.
      const pp = { ...(defaults.domains?.protectPreviews ?? {}), ...(site.domains.protectPreviews ?? {}) }
      // Mit disableWorkersDev schaltet die Engine die Previews ausdrücklich an
      // (main.tf); abgeschaltete Previews sind dann ein Fehler, sonst eine
      // Entscheidung der wrangler.toml (`preview_urls`).
      if (pp.enabled === true) {
        checks.push({ type: 'previews', worker: d.workerName, engineKeepsOn: d.disableWorkersDev === true })
      }
    }

    if (b) {
      for (const role of ROLES) {
        if (role === 'preview' && !b.previews) continue
        checks.push({ type: 'builds', worker: b.workerName, role, desired: desiredTrigger(b, role), env: b.env })
      }
    }

    if (checks.length > 0) sites.push({ slug, checks })
  }

  return { sites, errors }
}
