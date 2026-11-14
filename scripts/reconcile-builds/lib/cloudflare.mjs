// Dünner Client für die Workers-Builds-API und die GitHub-Repo-Abfrage.
// `fetch` wird hereingereicht, damit die Tests ohne Netz auskommen.
//
// Die Builds-API hat (Stand Provider cloudflare 5.22) keine Terraform-Resource,
// deshalb läuft der Abgleich hier direkt gegen die REST-API.

const CF_API = 'https://api.cloudflare.com/client/v4'
const GH_API = 'https://api.github.com'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export function createClient({ token, accountId, githubToken = '', fetch = globalThis.fetch }) {
  const acc = `/accounts/${accountId}`

  async function cf(method, path, body) {
    const res = await fetch(`${CF_API}${acc}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.success === false) {
      const errs = (json.errors || []).map(e => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ')
      let hint = ''
      if (res.status === 403 || res.status === 401) {
        hint = ' – fehlt dem Token "Workers Builds Configuration: Edit" bzw. "Workers Scripts: Read"?'
      }
      throw new ApiError(`Cloudflare ${method} ${path} -> ${res.status} ${errs}${hint}`.trim(), res.status)
    }
    return json.result
  }

  return {
    /** Alle Worker-Scripts als { id (= Name), tag }. */
    async listScripts() {
      const result = await cf('GET', '/workers/scripts')
      return (result ?? []).map(s => ({ id: s.id, tag: s.tag }))
    },

    listTriggers: tag => cf('GET', `/builds/workers/${tag}/triggers`).then(r => r ?? []),
    listBuildTokens: () => cf('GET', '/builds/tokens').then(r => r ?? []),
    listEnv: uuid => cf('GET', `/builds/triggers/${uuid}/environment_variables`).then(r => r ?? {}),

    upsertRepoConnection: body => cf('PUT', '/builds/repos/connections', body),
    createTrigger: body => cf('POST', '/builds/triggers', body),
    updateTrigger: (uuid, body) => cf('PATCH', `/builds/triggers/${uuid}`, body),
    deleteTrigger: uuid => cf('DELETE', `/builds/triggers/${uuid}`),
    setEnv: (uuid, vars) => cf('PATCH', `/builds/triggers/${uuid}/environment_variables`, vars),
    deleteEnv: (uuid, key) => cf('DELETE', `/builds/triggers/${uuid}/environment_variables/${encodeURIComponent(key)}`),

    /**
     * GitHub-IDs eines Repos, wie sie die Repo-Verbindung braucht. Private
     * Repos sind nur mit Token sichtbar; ohne Zugriff antwortet GitHub mit 404.
     * @returns {Promise<null | {repo_id, repo_name, provider_account_id, provider_account_name}>}
     */
    async lookupGithubRepo(repo) {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cloudflare-domains-reconcile-builds' }
      if (githubToken) headers.Authorization = `Bearer ${githubToken}`
      const res = await fetch(`${GH_API}/repos/${repo}`, { headers })
      if (res.status === 404) return null
      if (!res.ok) throw new ApiError(`GitHub GET /repos/${repo} -> ${res.status}`, res.status)
      const r = await res.json()
      return {
        provider_type: 'github',
        provider_account_id: String(r.owner.id),
        provider_account_name: r.owner.login,
        repo_id: String(r.id),
        repo_name: r.name,
      }
    },
  }
}
