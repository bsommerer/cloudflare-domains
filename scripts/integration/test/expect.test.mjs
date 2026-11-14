import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveChecks, securityHeaders, isZoneApex, SECURITY_DEFAULTS, TEST_PATH, TEST_QUERY } from '../lib/expect.mjs'

const defaults = {
  domains: { redirectWWW: true, redirectStatusCode: 301, preserveQueryString: true, alwaysUseHttps: true },
}

const testsite = {
  repo: 'bsommerer/cfd-testsite',
  domains: {
    enabled: true,
    workerName: 'cfd-testsite',
    canonicalDomain: 'test.sommerer.online',
    redirectDomains: ['test-alt.sommerer.online'],
    disableWorkersDev: true,
    securityHeaders: true,
    protectPreviews: { enabled: true, allowedEmailDomains: ['bs-itservices.de'] },
  },
  builds: { enabled: true, previews: true },
  integration: { expectHeaders: { 'Referrer-Policy': 'no-referrer' } },
}

const ZONES = ['sommerer.online', 'bastian-sommerer.de', 'example.co.uk']
const byType = (checks, type) => checks.filter(c => c.type === type)

test('Testseite: alle Features ergeben die erwarteten Prüfungen', () => {
  const { sites, errors } = deriveChecks({ t: testsite }, defaults, { zones: ZONES })
  assert.deepEqual(errors, [])
  const { checks } = sites[0]

  assert.deepEqual(byType(checks, 'canonical'), [{ type: 'canonical', host: 'test.sommerer.online' }])
  assert.equal(byType(checks, 'https').length, 1)

  // Subdomains bekommen keine www-Variante, nur Apex-Domains.
  const redirects = byType(checks, 'redirect')
  assert.deepEqual(redirects.map(c => c.host), ['test-alt.sommerer.online'])
  assert.equal(redirects[0].status, 301)
  assert.equal(redirects[0].location, `https://test.sommerer.online${TEST_PATH}?${TEST_QUERY}`)

  assert.deepEqual(byType(checks, 'hsts-redirect'), [
    { type: 'hsts-redirect', host: 'test-alt.sommerer.online', value: 'max-age=31536000' },
  ])

  const [headers] = byType(checks, 'headers')
  assert.deepEqual(headers.engine, SECURITY_DEFAULTS)
  assert.equal(headers.override, false)
  assert.deepEqual(headers.exact, { 'Referrer-Policy': 'no-referrer' })

  assert.deepEqual(byType(checks, 'workers-dev'), [{ type: 'workers-dev', worker: 'cfd-testsite' }])
  assert.deepEqual(byType(checks, 'previews'), [{ type: 'previews', worker: 'cfd-testsite', engineKeepsOn: true }])

  const builds = byType(checks, 'builds')
  assert.deepEqual(builds.map(b => b.desired.trigger_name), ['cfd:production', 'cfd:preview'])
  assert.deepEqual(builds[1].desired.branch_excludes, ['main'])
  assert.equal(builds[0].env.SITE_URL, 'https://test.sommerer.online')
})

test('redirectWWW: www nur für Apex-Domains, auch für Redirect-Domains, nicht für Subdomains', () => {
  const raw = {
    cv: {
      domains: {
        enabled: true,
        workerName: 'resume-web',
        canonicalDomain: 'cv.bastian-sommerer.de',
        redirectDomains: ['sommerer.online', 'cv.sommerer.online'],
      },
    },
  }
  const { sites } = deriveChecks(raw, defaults, { zones: ZONES })
  assert.deepEqual(
    byType(sites[0].checks, 'redirect').map(c => c.host),
    ['sommerer.online', 'cv.sommerer.online', 'www.sommerer.online'],
  )
})

test('redirectWWW: keine www-Variante, wenn sie selbst kanonisch ist', () => {
  const raw = { a: { domains: { enabled: true, workerName: 'a', canonicalDomain: 'www.example.de' } } }
  const { sites } = deriveChecks(raw, defaults, { zones: ['example.de'] })
  assert.equal(byType(sites[0].checks, 'redirect').length, 0)
})

test('Zonen-Apex: mit Zonenliste exakt, ohne Zonenliste genähert', () => {
  assert.equal(isZoneApex('example.co.uk', ZONES), true)
  assert.equal(isZoneApex('example.co.uk', null), false)
  assert.equal(isZoneApex('sommerer.online', null), true)
  assert.equal(isZoneApex('test.sommerer.online', ZONES), false)
})

test('Site-Einstellungen gewinnen über Defaults; Status-Code und Query', () => {
  const raw = {
    a: {
      domains: {
        enabled: true,
        workerName: 'a',
        canonicalDomain: 'A.example.de',
        redirectDomains: ['Alt.example.de'],
        redirectWWW: false,
        redirectStatusCode: 308,
        preserveQueryString: false,
        alwaysUseHttps: false,
      },
    },
  }
  const { sites } = deriveChecks(raw, defaults, { zones: ['example.de'] })
  const { checks } = sites[0]
  assert.equal(byType(checks, 'https').length, 0)
  assert.deepEqual(byType(checks, 'redirect'), [
    { type: 'redirect', host: 'alt.example.de', status: 308, location: `https://a.example.de${TEST_PATH}` },
  ])
})

test('nicht zuständig: Site aus, domains aus, enabled nur in Defaults, integration aus', () => {
  const d = { workerName: 'x', canonicalDomain: 'x.de' }
  const raw = {
    aus: { enabled: false, domains: { enabled: true, ...d } },
    domainsAus: { domains: { enabled: false, ...d } },
    nurDefaults: { domains: d },
    ohneTest: { integration: { enabled: false }, domains: { enabled: true, ...d } },
  }
  const { sites } = deriveChecks(raw, { domains: { ...defaults.domains, enabled: true } }, { zones: ['x.de'] })
  assert.deepEqual(sites, [])
})

test('protectPreviews wird feldweise mit den Defaults gemischt', () => {
  const raw = { a: { domains: { enabled: true, workerName: 'a', canonicalDomain: 'a.de', protectPreviews: { allowedEmails: ['x@a.de'] } } } }
  const on = { domains: { protectPreviews: { enabled: true } } }
  assert.equal(byType(deriveChecks(raw, on).sites[0].checks, 'previews').length, 1)
  assert.equal(byType(deriveChecks(raw, {}).sites[0].checks, 'previews').length, 0)
})

test('--site filtert, unbekannter Slug ist ein Fehler', () => {
  const raw = { t: testsite, b: { domains: { enabled: true, workerName: 'b', canonicalDomain: 'b.de' } } }
  assert.deepEqual(deriveChecks(raw, defaults, { only: ['b'] }).sites.map(s => s.slug), ['b'])
  assert.match(deriveChecks(raw, defaults, { only: ['nope'] }).errors[0], /nope/)
})

test('builds ohne previews: nur der Produktions-Trigger; Fehler im builds-Block werden gemeldet', () => {
  const raw = { t: { ...testsite, builds: { enabled: true } } }
  assert.deepEqual(byType(deriveChecks(raw, defaults).sites[0].checks, 'builds').map(b => b.role), ['production'])

  const kaputt = { t: { ...testsite, builds: { enabled: true, tippfehler: 1 } } }
  assert.match(deriveChecks(kaputt, defaults).errors[0], /builds.tippfehler/)
})

test('securityHeaders: Feinsteuerung wie in modules/site-plan', () => {
  assert.equal(securityHeaders(false), null)
  assert.equal(securityHeaders({ enabled: false }), null)
  assert.deepEqual(securityHeaders(true).headers, SECURITY_DEFAULTS)

  const s = securityHeaders({
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: 'no-referrer',
    permissionsPolicy: false,
    contentTypeOptions: false,
    frameOptions: 'DENY',
    overrideExisting: true,
  })
  assert.deepEqual(s, {
    override: true,
    headers: {
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    },
  })
  assert.equal('Strict-Transport-Security' in securityHeaders({ hsts: false }).headers, false)
  assert.equal('Strict-Transport-Security' in securityHeaders({ hsts: { enabled: false } }).headers, false)
})

test('HSTS-Prüfung auf Redirect-Domains nur, wenn HSTS an ist', () => {
  const raw = { t: { ...testsite, domains: { ...testsite.domains, securityHeaders: { hsts: false } } } }
  assert.equal(byType(deriveChecks(raw, defaults, { zones: ZONES }).sites[0].checks, 'hsts-redirect').length, 0)
})
