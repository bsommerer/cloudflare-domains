// Liest den `builds`-Block der Site-Dateien und bringt ihn auf eine feste Form.
// Kein Netzwerk, keine Seiteneffekte außer dem Lesen der Dateien – die
// eigentliche Normalisierung (`normalizeSites`) ist eine reine Funktion.
//
// Der Vertrag ist derselbe wie beim `domains`-Block: fehlt `builds` oder steht
// dort nicht `"enabled": true`, ist dieses Skript für die Site nicht zuständig.
// `"enabled": false` auf Site-Ebene sticht alles.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

export const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const WORKER_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// Felder, die das Schema für `builds` kennt. Alles andere ist ein Tippfehler.
const KNOWN_FIELDS = new Set([
  'enabled',
  'workerName',
  'productionBranch',
  'buildCommand',
  'deployCommand',
  'rootDirectory',
  'buildCaching',
  'previews',
  'previewDeployCommand',
  'buildTokenName',
  'env',
])

export const BUILD_DEFAULTS = Object.freeze({
  productionBranch: 'main',
  buildCommand: '',
  deployCommand: 'npx wrangler deploy',
  rootDirectory: '/',
  buildCaching: false,
  previews: false,
  previewDeployCommand: 'npx wrangler versions upload',
  buildTokenName: null,
})

/**
 * Site-Dateien + `_defaults.json` -> gewünschter Zustand je Site.
 *
 * `_defaults.json` wird wie bei `domains` flach unter den Block gemischt (Site
 * gewinnt). Einzige Ausnahme ist `env`: dort wird schlüsselweise gemischt,
 * damit eine Site, die eine eigene Variable setzt, nicht stillschweigend die
 * gemeinsamen Variablen aus den Defaults verliert.
 *
 * @returns {{ sites: object[], errors: string[] }}
 */
export function normalizeSites(rawSites, defaults = {}) {
  const sites = []
  const errors = []
  const d = isObject(defaults?.builds) ? defaults.builds : {}

  for (const slug of Object.keys(rawSites).sort()) {
    const site = rawSites[slug]
    if (!isObject(site) || site.enabled === false) continue
    if (!isObject(site.builds)) continue

    const b = { ...d, ...site.builds, env: { ...(d.env ?? {}), ...(site.builds.env ?? {}) } }
    if (b.enabled !== true) continue

    const fail = msg => errors.push(`${slug}: ${msg}`)

    for (const k of Object.keys(site.builds)) {
      if (!KNOWN_FIELDS.has(k)) fail(`unbekanntes Feld builds.${k}`)
    }

    if (typeof site.repo !== 'string' || !REPO_PATTERN.test(site.repo)) {
      fail('`repo` fehlt oder hat nicht die Form "<owner>/<name>" – Workers Builds braucht das GitHub-Repo.')
      continue
    }

    const domainsActive = isObject(site.domains) && site.domains.enabled === true
    const workerName = b.workerName ?? (domainsActive ? site.domains.workerName : undefined)
    if (typeof workerName !== 'string' || !WORKER_PATTERN.test(workerName)) {
      fail('kein Worker-Name – entweder `domains.workerName` oder `builds.workerName` setzen.')
      continue
    }

    const cfg = { ...BUILD_DEFAULTS }
    for (const k of Object.keys(BUILD_DEFAULTS)) if (b[k] !== undefined) cfg[k] = b[k]

    for (const k of ['productionBranch', 'deployCommand', 'rootDirectory', 'previewDeployCommand']) {
      if (typeof cfg[k] !== 'string' || cfg[k] === '') fail(`builds.${k} muss ein nicht-leerer String sein.`)
    }
    if (typeof cfg.buildCommand !== 'string') fail('builds.buildCommand muss ein String sein (leer = kein Build-Schritt).')
    if (typeof cfg.previews !== 'boolean') fail('builds.previews muss true oder false sein.')
    if (typeof cfg.buildCaching !== 'boolean') fail('builds.buildCaching muss true oder false sein.')
    if (cfg.buildTokenName !== null && typeof cfg.buildTokenName !== 'string') fail('builds.buildTokenName muss ein String sein.')

    // SITE_URL kommt automatisch aus der kanonischen Domain, lässt sich aber
    // in `env` überschreiben.
    const env = {}
    if (domainsActive && typeof site.domains.canonicalDomain === 'string') {
      env.SITE_URL = `https://${site.domains.canonicalDomain.toLowerCase()}`
    }
    for (const [k, v] of Object.entries(b.env)) {
      if (!ENV_KEY_PATTERN.test(k)) fail(`builds.env: ungültiger Variablenname "${k}".`)
      else if (k === MANAGED_ENV_MARKER) fail(`builds.env: "${k}" ist für die Buchführung des Abgleichs reserviert.`)
      else if (typeof v !== 'string') fail(`builds.env.${k} muss ein String sein – Secrets gehören nicht in Git.`)
      else env[k] = v
    }

    sites.push({ slug, repo: site.repo, workerName, ...cfg, env })
  }

  // Ein Worker kann nur eine Build-Konfiguration haben.
  const byWorker = new Map()
  for (const s of sites) byWorker.set(s.workerName, [...(byWorker.get(s.workerName) ?? []), s.slug])
  for (const [w, slugs] of byWorker) {
    if (slugs.length > 1) errors.push(`Worker "${w}" hat Build-Konfigurationen in mehreren Sites: ${slugs.join(', ')}.`)
  }

  return { sites, errors }
}

// Name der Build-Variable, in der das Skript festhält, welche Variablen es
// selbst gesetzt hat. Nur diese darf es später wieder entfernen.
export const MANAGED_ENV_MARKER = 'CFD_MANAGED_ENV'

/** Liest `<dir>/*.json` und `<dir>/_defaults.json`. */
export function readSitesDir(dir) {
  const raw = {}
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_defaults.json')) {
    raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  }
  const defaultsPath = join(dir, '_defaults.json')
  const defaults = existsSync(defaultsPath) ? JSON.parse(readFileSync(defaultsPath, 'utf8')) : {}
  return normalizeSites(raw, defaults)
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
