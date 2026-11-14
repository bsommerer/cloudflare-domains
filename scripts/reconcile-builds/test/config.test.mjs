import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { normalizeSites, readSitesDir, BUILD_DEFAULTS } from '../lib/config.mjs'

const site = (builds, extra = {}) => ({
  repo: 'bsommerer/resume-web',
  domains: { enabled: true, workerName: 'resume-web', canonicalDomain: 'cv.bastian-sommerer.de' },
  builds: { enabled: true, ...builds },
  ...extra,
})

test('ohne builds-Block oder ohne enabled ist das Skript nicht zuständig', () => {
  const { sites, errors } = normalizeSites({
    a: { domains: { enabled: true, workerName: 'a', canonicalDomain: 'a.de' } },
    b: site({ enabled: false }),
    c: site({}, { enabled: false }),
  })
  assert.deepEqual(sites, [])
  assert.deepEqual(errors, [])
})

test('Defaults, Worker aus domains und SITE_URL aus der kanonischen Domain', () => {
  const { sites, errors } = normalizeSites({ cv: site({}) })
  assert.deepEqual(errors, [])
  assert.equal(sites[0].workerName, 'resume-web')
  assert.equal(sites[0].deployCommand, BUILD_DEFAULTS.deployCommand)
  assert.equal(sites[0].previews, false)
  assert.deepEqual(sites[0].env, { SITE_URL: 'https://cv.bastian-sommerer.de' })
})

test('_defaults.json wird flach gemischt, env schlüsselweise; Site gewinnt', () => {
  const defaults = { builds: { previews: true, env: { SKIP_DEPENDENCY_INSTALL: '1', A: 'x' } } }
  const { sites } = normalizeSites({ cv: site({ previews: false, env: { A: 'y', SITE_URL: 'https://anders.de' } }) }, defaults)
  assert.equal(sites[0].previews, false)
  assert.deepEqual(sites[0].env, { SITE_URL: 'https://anders.de', SKIP_DEPENDENCY_INSTALL: '1', A: 'y' })
})

test('enabled darf aus _defaults.json kommen', () => {
  const { sites } = normalizeSites({ cv: { ...site({}), builds: {} } }, { builds: { enabled: true } })
  assert.equal(sites.length, 1)
})

test('builds.workerName für Sites ohne domains-Block', () => {
  const { sites, errors } = normalizeSites({ x: { repo: 'o/r', builds: { enabled: true, workerName: 'nur-builds' } } })
  assert.deepEqual(errors, [])
  assert.equal(sites[0].workerName, 'nur-builds')
  assert.deepEqual(sites[0].env, {})
})

test('Fehler: fehlendes repo, fehlender Worker, Tippfehler, Secret-artige Werte, doppelter Worker', () => {
  const { errors } = normalizeSites({
    a: { builds: { enabled: true, workerName: 'a' } },
    b: { repo: 'o/r', builds: { enabled: true } },
    c: site({ deployComand: 'x' }),
    d: site({ env: { TOKEN: { secret: true }, 'kaputt-name': '1', CFD_MANAGED_ENV: 'x' } }),
  })
  assert.match(errors.join('\n'), /a: `repo` fehlt/)
  assert.match(errors.join('\n'), /b: kein Worker-Name/)
  assert.match(errors.join('\n'), /c: unbekanntes Feld builds.deployComand/)
  assert.match(errors.join('\n'), /d: builds.env.TOKEN muss ein String sein/)
  assert.match(errors.join('\n'), /d: builds.env: ungültiger Variablenname "kaputt-name"/)
  assert.match(errors.join('\n'), /d: builds.env: "CFD_MANAGED_ENV" ist .*reserviert/)
  assert.match(errors.join('\n'), /Worker "resume-web" hat Build-Konfigurationen in mehreren Sites: c, d/)
})

test('die Beispiel-Sites aus examples/sites-config sind gültig', () => {
  const dir = fileURLToPath(new URL('../../../examples/sites-config/sites', import.meta.url))
  const { sites, errors } = readSitesDir(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual(
    sites.map(s => [s.slug, s.workerName, s.repo, s.env.SITE_URL]),
    [['kunde-xy', 'kunde-xy', 'kunde-xy-org/kunde-xy-website', 'https://kunde-xy.de']],
  )
})
