// In-Memory-Nachbau der Workers-Builds-API als `fetch`-Ersatz. Antwortformen
// wie in echten GET-Antworten beobachtet (Trigger, Build-Variablen, Tokens).
// Protokolliert jeden Aufruf, damit Tests prüfen können, dass `plan` nie
// schreibt.

export const ACCOUNT = 'acc123'

export function fakeApi({ scripts = [], triggers = [], env = {}, tokens = [], github = {} } = {}) {
  const state = {
    scripts: structuredClone(scripts),
    triggers: structuredClone(triggers),
    env: structuredClone(env),
    tokens: structuredClone(tokens),
    connections: [],
  }
  const calls = []
  let seq = 0

  const ok = result => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 })
  const notFound = () =>
    new Response(JSON.stringify({ success: false, errors: [{ code: 12000, message: 'Not found' }], result: null }), {
      status: 404,
    })

  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    const u = new URL(url)
    calls.push({ method, path: u.pathname, body })

    if (u.hostname === 'api.github.com') {
      const repo = u.pathname.replace('/repos/', '')
      return github[repo] ? new Response(JSON.stringify(github[repo]), { status: 200 }) : new Response('{}', { status: 404 })
    }

    const p = u.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '')
    let m

    if (method === 'GET' && p === '/workers/scripts') return ok(state.scripts)
    if (method === 'GET' && (m = p.match(/^\/builds\/workers\/([^/]+)\/triggers$/))) {
      return ok(state.triggers.filter(t => t.external_script_id === m[1]))
    }
    if (method === 'GET' && p === '/builds/tokens') return ok(state.tokens)
    if ((m = p.match(/^\/builds\/triggers\/([^/]+)\/environment_variables(?:\/(.+))?$/))) {
      const vars = (state.env[m[1]] ??= {})
      if (method === 'GET') return ok(vars)
      if (method === 'PATCH') {
        for (const [k, v] of Object.entries(body)) vars[k] = { ...v, ...(v.is_secret ? { value: undefined } : {}) }
        return ok(null)
      }
      if (method === 'DELETE') {
        delete vars[decodeURIComponent(m[2])]
        return ok(null)
      }
    }
    if (method === 'PUT' && p === '/builds/repos/connections') {
      const conn = { repo_connection_uuid: `conn-${++seq}`, ...body }
      state.connections.push(conn)
      return ok(conn)
    }
    if (method === 'POST' && p === '/builds/triggers') {
      const conn =
        state.connections.find(c => c.repo_connection_uuid === body.repo_connection_uuid) ??
        state.triggers.find(t => t.repo_connection.repo_connection_uuid === body.repo_connection_uuid)?.repo_connection
      const { repo_connection_uuid, ...rest } = body
      const t = { trigger_uuid: `trg-${++seq}`, ...rest, repo_connection: conn }
      state.triggers.push(t)
      return ok(t)
    }
    if ((m = p.match(/^\/builds\/triggers\/([^/]+)$/))) {
      const i = state.triggers.findIndex(t => t.trigger_uuid === m[1])
      if (i < 0) return notFound()
      if (method === 'PATCH') {
        Object.assign(state.triggers[i], body)
        return ok(state.triggers[i])
      }
      if (method === 'DELETE') {
        state.triggers.splice(i, 1)
        return ok(null)
      }
    }
    return notFound()
  }

  return { fetch, state, calls, writes: () => calls.filter(c => c.method !== 'GET') }
}

// --- Fixture: der reale Ausgangszustand von resume-web (Dashboard-Trigger) ---

export const RESUME_CONN = {
  repo_connection_uuid: 'conn-resume',
  repo_id: '1131165099',
  repo_name: 'resume-web',
  provider_type: 'github',
  provider_account_id: '63158321',
  provider_account_name: 'bsommerer',
}

export const dashboardTrigger = (overrides = {}) => ({
  trigger_uuid: 'trg-dashboard',
  external_script_id: 'tag-resume',
  build_token_uuid: 'tok-resume',
  build_token_name: 'resume-web build token',
  trigger_name: 'tag-resume',
  build_command: '',
  deploy_command: 'npx wrangler deploy',
  root_directory: '/',
  branch_includes: ['main'],
  branch_excludes: [],
  path_includes: ['*'],
  path_excludes: [],
  build_caching_enabled: false,
  repo_connection: RESUME_CONN,
  ...overrides,
})

export const previewTrigger = (overrides = {}) =>
  dashboardTrigger({
    trigger_uuid: 'trg-preview',
    trigger_name: 'preview',
    deploy_command: 'npx wrangler versions upload',
    branch_includes: ['*'],
    branch_excludes: ['main'],
    ...overrides,
  })

export const SCRIPTS = [
  { id: 'resume-web', tag: 'tag-resume' },
  { id: 'kunde-xy', tag: 'tag-kunde' },
]

export const TOKENS = [
  { build_token_uuid: 'tok-resume', build_token_name: 'resume-web build token' },
  { build_token_uuid: 'tok-shared', build_token_name: 'gemeinsam' },
]
