import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCanonical,
  evaluateHttps,
  evaluateRedirect,
  evaluateHstsRedirect,
  evaluateHeaders,
  evaluateWorkersDev,
  evaluatePreview,
  evaluateBuilds,
  previewUrls,
  urlFor,
} from '../lib/checks.mjs'
import { SECURITY_DEFAULTS, TEST_PATH, TEST_QUERY } from '../lib/expect.mjs'
import { desiredTrigger } from '../../reconcile-builds/lib/plan.mjs'

const res = (status, headers = {}) => ({ status, headers })
const down = { status: 0, headers: {}, error: 'ENOTFOUND' }
const host = 'test.sommerer.online'
const target = `https://${host}${TEST_PATH}?${TEST_QUERY}`

test('kanonisch: 2xx von Cloudflare, Weiterleitung nur innerhalb der Domain', () => {
  const c = { type: 'canonical', host }
  assert.equal(evaluateCanonical(c, res(200, { server: 'cloudflare' })).state, 'pass')
  assert.equal(evaluateCanonical(c, res(200, { server: 'nginx' })).state, 'fail')
  assert.equal(evaluateCanonical(c, res(301, { location: '/de/' })).state, 'pass')
  assert.equal(evaluateCanonical(c, res(301, { location: 'https://cv.bastian-sommerer.de/' })).state, 'fail')
  assert.equal(evaluateCanonical(c, res(522)).state, 'fail')
  assert.equal(evaluateCanonical(c, down).state, 'fail')
})

test('http -> https mit Pfad und Query', () => {
  const c = { type: 'https', host }
  assert.equal(evaluateHttps(c, res(301, { location: target })).state, 'pass')
  assert.match(evaluateHttps(c, res(301, { location: `https://${host}/` })).detail, /Pfad\/Query/)
  assert.equal(evaluateHttps(c, res(200)).state, 'fail')
})

test('Weiterleitung: Status und Ziel exakt', () => {
  const c = { type: 'redirect', host: 'test-alt.sommerer.online', status: 301, location: target }
  assert.equal(evaluateRedirect(c, res(301, { location: target })).state, 'pass')
  assert.equal(evaluateRedirect(c, res(302, { location: target })).state, 'fail')
  // Die frühere manuelle Regel in sommerer.online verwarf den Pfad.
  assert.equal(evaluateRedirect(c, res(301, { location: `https://${host}` })).state, 'fail')
  assert.equal(evaluateRedirect(c, res(200)).state, 'fail')
  assert.equal(evaluateRedirect(c, down).state, 'fail')
})

test('HSTS auf der Weiterleitung', () => {
  const c = { type: 'hsts-redirect', host: 'x', value: 'max-age=31536000' }
  assert.equal(evaluateHstsRedirect(c, res(301, { 'strict-transport-security': 'max-age=31536000' })).state, 'pass')
  assert.match(evaluateHstsRedirect(c, res(301)).detail, /nicht gesetzt/)
})

test('Header: Vorrang der Seite ohne overrideExisting, exakte Repo-Header', () => {
  const c = { type: 'headers', host, engine: SECURITY_DEFAULTS, override: false, exact: { 'Referrer-Policy': 'no-referrer' } }
  const all = Object.fromEntries(Object.entries(SECURITY_DEFAULTS).map(([k, v]) => [k.toLowerCase(), v]))

  // Engine hätte strict-origin-when-cross-origin gesetzt – die Seite gewinnt.
  const ok = evaluateHeaders(c, res(200, { ...all, 'referrer-policy': 'no-referrer' }))
  assert.equal(ok.state, 'pass', ok.detail)

  const overwritten = evaluateHeaders(c, res(200, all))
  assert.equal(overwritten.state, 'fail')
  assert.match(overwritten.detail, /Referrer-Policy ist "strict-origin-when-cross-origin", erwartet "no-referrer"/)

  const missing = evaluateHeaders(c, res(200, { 'referrer-policy': 'no-referrer' }))
  assert.match(missing.detail, /Strict-Transport-Security fehlt/)

  // Fremder Wert ohne exakte Erwartung: kein Fehler, nur Hinweis.
  const own = evaluateHeaders({ ...c, exact: {} }, res(200, { ...all, 'x-frame-options': 'DENY' }))
  assert.equal(own.state, 'pass')
  assert.match(own.detail, /Vorrang/)

  // Mit overrideExisting muss der Engine-Wert gewinnen.
  assert.equal(evaluateHeaders({ ...c, exact: {}, override: true }, res(200, { ...all, 'x-frame-options': 'DENY' })).state, 'fail')
  assert.equal(evaluateHeaders(c, res(404, all)).state, 'fail')
})

test('workers.dev: alles außer 2xx/3xx gilt als abgeschaltet', () => {
  const c = { type: 'workers-dev', worker: 'w' }
  assert.equal(evaluateWorkersDev(c, res(404)).state, 'pass')
  assert.equal(evaluateWorkersDev(c, down).state, 'pass')
  assert.equal(evaluateWorkersDev(c, res(200)).state, 'fail')
  assert.equal(urlFor(c, { workersSubdomain: 'bs-it-services' }), 'https://w.bs-it-services.workers.dev/')
  assert.equal(urlFor(c, {}), null)
})

test('Preview: Access-Login oder 401/403, sonst Fehler', () => {
  const u = 'https://integration-w.sub.workers.dev/'
  assert.equal(evaluatePreview(u, res(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' })).state, 'pass')
  assert.equal(evaluatePreview(u, res(403)).state, 'pass')
  assert.equal(evaluatePreview(u, res(200)).state, 'fail')
  assert.equal(evaluatePreview(u, res(302, { location: 'https://evil.example/' })).state, 'fail')
})

test('Preview-URLs aus dem Versionsverlauf', () => {
  const versions = [
    { id: 'aaaaaaaa-1111', metadata: { has_preview: false } },
    { id: 'bbbbbbbb-2222', metadata: { has_preview: true }, annotations: {} },
    { id: 'cccccccc-3333', metadata: { has_preview: true }, annotations: { 'workers/alias': 'integration' } },
  ]
  assert.deepEqual(previewUrls('w', 'sub', versions), [
    'https://integration-w.sub.workers.dev/',
    'https://bbbbbbbb-w.sub.workers.dev/',
  ])
  assert.equal(previewUrls('w', 'sub', [{ id: 'x', metadata: { has_preview: false } }]), null)
  assert.equal(previewUrls('w', 'sub', []), null)
})

test('Builds: Trigger und Variablen wie konfiguriert', () => {
  const site = {
    productionBranch: 'main',
    buildCommand: '',
    deployCommand: 'npx wrangler deploy',
    rootDirectory: '/',
    buildCaching: false,
    previewDeployCommand: 'npx wrangler versions upload',
  }
  const desired = desiredTrigger(site, 'preview')
  const c = { type: 'builds', worker: 'w', role: 'preview', desired, env: { SITE_URL: 'https://x.de' } }
  const env = {
    SITE_URL: { value: 'https://x.de', is_secret: false },
    CFD_MANAGED_ENV: { value: 'SITE_URL', is_secret: false },
  }

  assert.equal(evaluateBuilds(c, [{ ...desired, trigger_uuid: 'u' }], env).state, 'pass')
  assert.match(evaluateBuilds(c, [], env).detail, /fehlt/)
  assert.match(evaluateBuilds(c, [{ ...desired, deploy_command: 'npx wrangler deploy' }], env).detail, /deploy_command/)
  assert.match(evaluateBuilds(c, [desired], { ...env, SITE_URL: { value: 'alt', is_secret: false } }).detail, /SITE_URL/)
})
