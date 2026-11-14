import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveChecks, TEST_PATH, TEST_QUERY } from '../lib/expect.mjs'
import { runChecks, createApi } from '../lib/run.mjs'
import { renderMarkdown, annotations, hasFailures } from '../lib/report.mjs'

// Nachgebautes Netz: Hostname -> Antwortfolge. Jeder Aufruf nimmt die nächste
// Antwort, die letzte bleibt stehen – so lässt sich „erst Fehler, dann ok“
// (frisches Zertifikat) abbilden.
function fakeNet(routes) {
  const calls = []
  const seen = new Map()
  async function fetch(url, init = {}) {
    const u = new URL(url)
    calls.push({ method: init.method ?? 'GET', url })
    const key = u.hostname === 'api.cloudflare.com' ? `api:${u.pathname}` : `${u.protocol}//${u.hostname}`
    const list = routes[key]
    if (!list) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    const r = list[Math.min(n, list.length - 1)]
    if (r === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    if (u.hostname === 'api.cloudflare.com') {
      return new Response(JSON.stringify({ success: true, errors: [], result: r }), { status: 200 })
    }
    return new Response('', { status: r.status, headers: r.headers ?? {} })
  }
  return { fetch, calls }
}

const site = {
  repo: 'bsommerer/cfd-testsite',
  domains: {
    enabled: true,
    workerName: 'cfd-testsite',
    canonicalDomain: 'test.sommerer.online',
    redirectDomains: ['test-alt.sommerer.online'],
    disableWorkersDev: true,
    protectPreviews: { enabled: true, allowedEmailDomains: ['bs-itservices.de'] },
  },
}
const target = `https://test.sommerer.online${TEST_PATH}?${TEST_QUERY}`
const ACC = 'acc'
const api = p => `api:/client/v4/accounts/${ACC}${p}`

function healthyRoutes() {
  return {
    'https://test.sommerer.online': [{ status: 200, headers: { server: 'cloudflare' } }],
    'http://test.sommerer.online': [{ status: 301, headers: { location: target } }],
    'https://test-alt.sommerer.online': [{ status: 301, headers: { location: target } }],
    'https://cfd-testsite.sub.workers.dev': [{ status: 404 }],
    'https://integration-cfd-testsite.sub.workers.dev': [
      { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } },
    ],
    'https://e7619362-cfd-testsite.sub.workers.dev': [{ status: 403 }],
    [api('/workers/scripts/cfd-testsite/subdomain')]: [{ enabled: false, previews_enabled: true }],
    [api('/workers/scripts/cfd-testsite/versions')]: [
      {
        items: [
          { id: 'e7619362-fc29', metadata: { has_preview: true }, annotations: { 'workers/alias': 'integration' } },
        ],
      },
    ],
  }
}

const opts = (net, extra = {}) => ({
  fetch: net.fetch,
  api: createApi({ token: 't', accountId: ACC, fetch: net.fetch }),
  workersSubdomain: 'sub',
  sleep: async () => {},
  ...extra,
})

test('alles gesund: bestanden, nur GET-Requests', async () => {
  const net = fakeNet(healthyRoutes())
  const { sites } = deriveChecks({ t: site }, {}, { zones: ['sommerer.online'] })
  const report = await runChecks(sites, opts(net))

  const states = report[0].results.map(r => `${r.check.type}:${r.state}`)
  assert.deepEqual(states, ['canonical:pass', 'https:pass', 'redirect:pass', 'workers-dev:pass', 'previews:pass'])
  assert.equal(hasFailures(report), false)
  assert.ok(net.calls.every(c => c.method === 'GET'))
  assert.match(renderMarkdown(report), /5 bestanden, 0 fehlgeschlagen/)
})

test('frische Domain: Wiederholung mit Backoff, bis das Zertifikat da ist', async () => {
  const routes = healthyRoutes()
  routes['https://test.sommerer.online'] = ['down', 'down', { status: 200, headers: { server: 'cloudflare' } }]
  const net = fakeNet(routes)
  const sleeps = []
  const { sites } = deriveChecks({ t: site }, {}, { zones: ['sommerer.online'] })
  const report = await runChecks(sites, opts(net, { sleep: async ms => sleeps.push(ms), baseDelayMs: 1000 }))

  const canonical = report[0].results.find(r => r.check.type === 'canonical')
  assert.equal(canonical.state, 'pass')
  assert.equal(canonical.tries, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test('Zeitbudget aufgebraucht: Fehler mit Annotation, kein endloses Warten', async () => {
  const routes = healthyRoutes()
  routes['https://test-alt.sommerer.online'] = [{ status: 301, headers: { location: 'https://test.sommerer.online' } }]
  const net = fakeNet(routes)
  let t = 0
  const { sites } = deriveChecks({ t: site }, {}, { zones: ['sommerer.online'] })
  const report = await runChecks(sites, opts(net, {
    now: () => t,
    sleep: async ms => (t += ms),
    baseDelayMs: 1000,
    maxWaitMs: 5000,
  }))

  const r = report[0].results.find(x => x.check.type === 'redirect')
  assert.equal(r.state, 'fail')
  assert.ok(r.tries >= 2 && r.tries <= 4, `tries=${r.tries}`)
  assert.equal(hasFailures(report), true)
  assert.match(annotations(report).join('\n'), /^::error title=t%3A test-alt.sommerer.online -> 301/m)
})

test('Preview ohne Schutz ist ein Fehler, ohne Preview übersprungen', async () => {
  const routes = healthyRoutes()
  routes['https://integration-cfd-testsite.sub.workers.dev'] = [{ status: 200 }]
  const { sites } = deriveChecks({ t: site }, {}, { zones: ['sommerer.online'] })
  let report = await runChecks(sites, opts(fakeNet(routes), { maxWaitMs: 0 }))
  assert.equal(report[0].results.find(r => r.check.type === 'previews').state, 'fail')

  const none = healthyRoutes()
  none[api('/workers/scripts/cfd-testsite/versions')] = [{ items: [{ id: 'x', metadata: { has_preview: false } }] }]
  report = await runChecks(sites, opts(fakeNet(none)))
  const p = report[0].results.find(r => r.check.type === 'previews')
  assert.equal(p.state, 'skip')
  assert.match(annotations(report).join('\n'), /::notice title=.*übersprungen/)
})

test('Previews abgeschaltet: Fehler, wenn die Engine sie anlassen müsste, sonst übersprungen', async () => {
  const routes = healthyRoutes()
  routes[api('/workers/scripts/cfd-testsite/subdomain')] = [{ enabled: false, previews_enabled: false }]
  let { sites } = deriveChecks({ t: site }, {}, { zones: ['sommerer.online'] })
  let report = await runChecks(sites, opts(fakeNet(routes), { maxWaitMs: 0 }))
  assert.equal(report[0].results.find(r => r.check.type === 'previews').state, 'fail')

  const ohne = { ...site, domains: { ...site.domains, disableWorkersDev: false } }
  ;({ sites } = deriveChecks({ t: ohne }, {}, { zones: ['sommerer.online'] }))
  report = await runChecks(sites, opts(fakeNet(routes)))
  assert.equal(report[0].results.find(r => r.check.type === 'previews').state, 'skip')
})

test('ohne Cloudflare-API: Previews übersprungen statt Fehler', async () => {
  const net = fakeNet(healthyRoutes())
  const { sites } = deriveChecks({ t: site }, {}, { zones: ['sommerer.online'] })
  const report = await runChecks(sites, { fetch: net.fetch, workersSubdomain: null, sleep: async () => {} })
  const by = Object.fromEntries(report[0].results.map(r => [r.check.type, r.state]))
  assert.equal(by.previews, 'skip')
  assert.equal(by['workers-dev'], 'skip')
  assert.equal(hasFailures(report), false)
})
