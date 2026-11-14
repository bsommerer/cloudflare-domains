import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSites } from '../lib/config.mjs'
import { createClient } from '../lib/cloudflare.mjs'
import { buildPlan, renderMarkdown, hasChanges, planEnv } from '../lib/plan.mjs'
import { applyPlan } from '../lib/apply.mjs'
import { fakeApi, ACCOUNT, SCRIPTS, TOKENS, dashboardTrigger, previewTrigger } from './fake-api.mjs'

const resumeSite = (builds = {}) => ({
  repo: 'bsommerer/resume-web',
  domains: { enabled: true, workerName: 'resume-web', canonicalDomain: 'cv.bastian-sommerer.de' },
  builds: { enabled: true, ...builds },
})

function setup(raw, api) {
  const { sites, errors } = normalizeSites(raw)
  assert.deepEqual(errors, [])
  const client = createClient({ token: 't', accountId: ACCOUNT, fetch: api.fetch })
  return { sites, client }
}

const op = (plan, slug, role) => plan.sites.find(s => s.slug === slug).triggers.find(a => a.role === role)

test('ohne Sites kein einziger API-Aufruf', async () => {
  const api = fakeApi({ scripts: SCRIPTS })
  const plan = await buildPlan([], createClient({ token: 't', accountId: ACCOUNT, fetch: api.fetch }))
  assert.equal(api.calls.length, 0)
  assert.match(renderMarkdown(plan), /nichts zu tun/)
})

test('Bestandsübernahme: Dashboard-Trigger (Name = Script-Tag) wird übernommen statt verdoppelt', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [dashboardTrigger(), previewTrigger()],
    env: { 'trg-dashboard': { SKIP_DEPENDENCY_INSTALL: { value: '1', is_secret: false } } },
    tokens: TOKENS,
  })
  const { sites, client } = setup(
    { cv: resumeSite({ previews: true, env: { SKIP_DEPENDENCY_INSTALL: '1' } }) },
    api,
  )
  const plan = await buildPlan(sites, client)

  assert.deepEqual(plan.errors, [])
  const prod = op(plan, 'cv', 'production')
  assert.equal(prod.op, 'adopt')
  assert.equal(prod.uuid, 'trg-dashboard')
  assert.deepEqual(prod.changes.map(c => c.field), ['trigger_name'])
  assert.deepEqual(Object.keys(prod.env.set).sort(), ['CFD_MANAGED_ENV', 'SITE_URL'])

  const prev = op(plan, 'cv', 'preview')
  assert.equal(prev.op, 'adopt')
  assert.equal(prev.uuid, 'trg-preview')
  assert.equal(api.writes().length, 0, 'plan darf nie schreiben')

  const md = renderMarkdown(plan)
  assert.match(md, /`cfd:production` übernehmen \(bisher `tag-resume`\)/)
  assert.match(md, /Variable `SITE_URL` = `"https:\/\/cv.bastian-sommerer.de"`/)

  await applyPlan(plan, client)
  assert.equal(api.state.triggers.length, 2, 'nichts doppelt angelegt')
  assert.deepEqual(api.state.triggers.map(t => t.trigger_name).sort(), ['cfd:preview', 'cfd:production'])
  assert.equal(api.writes().filter(c => c.method === 'POST').length, 0)

  // Zweiter Lauf: alles in Ordnung, nichts zu tun.
  const again = await buildPlan(sites, client)
  assert.equal(hasChanges(again), false)
  assert.match(renderMarkdown(again), /Keine Änderungen/)
})

test('anlegen: neuer Worker, Repo-Verbindung an anderem Worker wird wiederverwendet', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [dashboardTrigger()],
    tokens: [...TOKENS, { build_token_uuid: 'tok-kunde', build_token_name: 'kunde-xy build token' }],
  })
  const raw = {
    kunde: {
      repo: 'bsommerer/resume-web',
      domains: { enabled: true, workerName: 'kunde-xy', canonicalDomain: 'kunde-xy.de' },
      builds: { enabled: true, previews: true },
    },
  }
  const { sites, client } = setup(raw, api)
  const plan = await buildPlan(sites, client)

  assert.deepEqual(plan.errors, [])
  assert.equal(op(plan, 'kunde', 'production').op, 'create')
  assert.equal(op(plan, 'kunde', 'preview').op, 'create')
  assert.deepEqual(plan.sites[0].repoConnection, { uuid: 'conn-resume' })
  assert.equal(plan.sites[0].buildTokenUuid, 'tok-kunde')

  await applyPlan(plan, client)
  const created = api.state.triggers.filter(t => t.external_script_id === 'tag-kunde')
  assert.equal(created.length, 2)
  const prod = created.find(t => t.trigger_name === 'cfd:production')
  assert.equal(prod.build_token_uuid, 'tok-kunde')
  assert.deepEqual(prod.branch_includes, ['main'])
  const prev = created.find(t => t.trigger_name === 'cfd:preview')
  assert.deepEqual(prev.branch_excludes, ['main'])
  assert.equal(prev.deploy_command, 'npx wrangler versions upload')
  assert.equal(api.state.env[prod.trigger_uuid].SITE_URL.value, 'https://kunde-xy.de')
})

test('anlegen: Repo-Verbindung über GitHub-IDs, Build-Token aus builds.buildTokenName', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    tokens: TOKENS,
    github: { 'bsommerer/kunde-xy': { id: 42, name: 'kunde-xy', owner: { id: 7, login: 'bsommerer' } } },
  })
  const raw = {
    kunde: { repo: 'bsommerer/kunde-xy', builds: { enabled: true, workerName: 'kunde-xy', buildTokenName: 'gemeinsam' } },
  }
  const { sites, client } = setup(raw, api)
  const plan = await buildPlan(sites, client)

  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.sites[0].repoConnection.create, {
    provider_type: 'github',
    provider_account_id: '7',
    provider_account_name: 'bsommerer',
    repo_id: '42',
    repo_name: 'kunde-xy',
  })
  assert.equal(plan.sites[0].buildTokenUuid, 'tok-shared')
  assert.match(renderMarkdown(plan), /Repo-Verbindung zu `bsommerer\/kunde-xy` anlegen/)

  await applyPlan(plan, client)
  const put = api.writes().find(c => c.method === 'PUT')
  assert.equal(put.path, `/client/v4/accounts/${ACCOUNT}/builds/repos/connections`)
  const post = api.writes().find(c => c.method === 'POST')
  assert.equal(post.body.repo_connection_uuid, api.state.connections[0].repo_connection_uuid)
})

test('Fehler bei fehlender Repo-Verbindung (privates Repo ohne GitHub-Zugriff)', async () => {
  const api = fakeApi({ scripts: SCRIPTS, tokens: TOKENS })
  const raw = { kunde: { repo: 'bsommerer/geheim', builds: { enabled: true, workerName: 'kunde-xy', buildTokenName: 'gemeinsam' } } }
  const { sites, client } = setup(raw, api)
  const plan = await buildPlan(sites, client)

  assert.equal(plan.errors.length, 1)
  assert.match(plan.errors[0], /keine Repo-Verbindung für bsommerer\/geheim/)
  assert.match(plan.errors[0], /BUILDS_GITHUB_TOKEN/)
  assert.match(renderMarkdown(plan), /es wird nichts geändert/)
  await assert.rejects(applyPlan(plan, client), /Plan enthält Fehler/)
  assert.equal(api.writes().length, 0)
})

test('Fehler ohne Build-Token und bei unbekanntem Worker', async () => {
  const api = fakeApi({ scripts: SCRIPTS, triggers: [dashboardTrigger()], tokens: TOKENS })
  const raw = {
    a: { repo: 'bsommerer/resume-web', builds: { enabled: true, workerName: 'kunde-xy' } },
    b: { repo: 'bsommerer/resume-web', builds: { enabled: true, workerName: 'gibt-es-nicht' } },
  }
  const { sites, client } = setup(raw, api)
  const plan = await buildPlan(sites, client)
  assert.match(plan.errors.join('\n'), /a: kein Build-Token für Worker "kunde-xy"/)
  assert.match(plan.errors.join('\n'), /b: Worker "gibt-es-nicht" existiert nicht/)
})

test('aktualisieren: geänderte Befehle und Variablen am eigenen Trigger', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [dashboardTrigger({ trigger_name: 'cfd:production' })],
    env: {
      'trg-dashboard': {
        CFD_MANAGED_ENV: { value: 'ALT,SITE_URL', is_secret: false },
        SITE_URL: { value: 'https://cv.bastian-sommerer.de', is_secret: false },
        ALT: { value: 'x', is_secret: false },
        FREMD: { value: 'bleibt', is_secret: false },
        API_KEY: { is_secret: true },
      },
    },
    tokens: TOKENS,
  })
  const { sites, client } = setup({ cv: resumeSite({ buildCommand: 'npm run build', env: { NEU: '1', API_KEY: 'klartext' } }) }, api)
  const plan = await buildPlan(sites, client)

  const prod = op(plan, 'cv', 'production')
  assert.equal(prod.op, 'update')
  assert.deepEqual(prod.changes, [{ field: 'build_command', from: '', to: 'npm run build' }])
  assert.deepEqual(prod.env.set, { NEU: '1', CFD_MANAGED_ENV: 'NEU,SITE_URL' })
  assert.deepEqual(prod.env.remove, ['ALT'], 'nur vom Abgleich gesetzte Variablen werden entfernt')
  assert.deepEqual(prod.env.skippedSecrets, ['API_KEY'])
  assert.match(plan.sites[0].warnings.join('\n'), /API_KEY ist als Secret gesetzt/)

  await applyPlan(plan, client)
  const vars = api.state.env['trg-dashboard']
  assert.equal(vars.FREMD.value, 'bleibt')
  assert.equal(vars.API_KEY.is_secret, true)
  assert.equal(vars.ALT, undefined)
  assert.equal(api.state.triggers[0].build_command, 'npm run build')
})

test('nichts tun, wenn alles stimmt', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [dashboardTrigger({ trigger_name: 'cfd:production' })],
    env: {
      'trg-dashboard': {
        CFD_MANAGED_ENV: { value: 'SITE_URL', is_secret: false },
        SITE_URL: { value: 'https://cv.bastian-sommerer.de', is_secret: false },
      },
    },
  })
  const { sites, client } = setup({ cv: resumeSite() }, api)
  const plan = await buildPlan(sites, client)
  assert.equal(op(plan, 'cv', 'production').op, 'keep')
  assert.equal(hasChanges(plan), false)
  await applyPlan(plan, client)
  assert.equal(api.writes().length, 0)
})

test('fremde Trigger werden ignoriert: anderes Repo, anderer Branch', async () => {
  const fremd = dashboardTrigger({
    trigger_uuid: 'trg-fremd',
    trigger_name: 'handgemacht',
    repo_connection: { ...dashboardTrigger().repo_connection, repo_name: 'anderes-repo' },
  })
  const staging = dashboardTrigger({ trigger_uuid: 'trg-staging', trigger_name: 'staging', branch_includes: ['staging'] })
  const api = fakeApi({ scripts: SCRIPTS, triggers: [fremd, staging, dashboardTrigger({ trigger_uuid: 'trg-x', trigger_name: 'x', repo_connection: { ...dashboardTrigger().repo_connection, repo_name: 'other' }, external_script_id: 'tag-kunde' })], tokens: TOKENS })
  const { sites, client } = setup({ cv: resumeSite() }, api)
  const plan = await buildPlan(sites, client)

  assert.deepEqual(plan.errors, [])
  assert.equal(op(plan, 'cv', 'production').op, 'create')
  assert.match(plan.sites[0].warnings.join('\n'), /Fremder Trigger "handgemacht"/)
  assert.match(plan.sites[0].warnings.join('\n'), /Fremder Trigger "staging"/)

  await applyPlan(plan, client)
  const untouched = api.writes().filter(c => /trg-(fremd|staging|x)/.test(c.path))
  assert.deepEqual(untouched, [])
  assert.equal(api.state.triggers.find(t => t.trigger_uuid === 'trg-fremd').trigger_name, 'handgemacht')
})

test('mehrdeutige Übernahme bricht ab statt zu raten', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [dashboardTrigger(), dashboardTrigger({ trigger_uuid: 'trg-zwei', trigger_name: 'zweiter' })],
    tokens: TOKENS,
  })
  const { sites, client } = setup({ cv: resumeSite() }, api)
  const plan = await buildPlan(sites, client)
  assert.match(plan.errors.join('\n'), /mehrere bestehende Trigger kommen für "cfd:production" in Frage/)
})

test('Repo-Wechsel: eigener Trigger wird ersetzt', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [dashboardTrigger({ trigger_name: 'cfd:production' })],
    tokens: TOKENS,
    github: { 'bsommerer/neu': { id: 9, name: 'neu', owner: { id: 63158321, login: 'bsommerer' } } },
  })
  const site = { ...resumeSite(), repo: 'bsommerer/neu' }
  const { sites, client } = setup({ cv: site }, api)
  const plan = await buildPlan(sites, client)
  assert.equal(op(plan, 'cv', 'production').op, 'replace')
  await applyPlan(plan, client)
  assert.equal(api.state.triggers.length, 1)
  assert.equal(api.state.triggers[0].repo_connection.repo_name, 'neu')
  assert.equal(api.state.triggers[0].build_token_uuid, 'tok-resume')
})

test('previews: false löscht nur den eigenen cfd:preview, verwaiste nur mit Flag', async () => {
  const api = fakeApi({
    scripts: SCRIPTS,
    triggers: [
      dashboardTrigger({ trigger_name: 'cfd:production' }),
      previewTrigger({ trigger_name: 'cfd:preview' }),
      dashboardTrigger({ trigger_uuid: 'trg-orphan', trigger_name: 'cfd:production', external_script_id: 'tag-kunde' }),
    ],
    tokens: TOKENS,
  })
  const { sites, client } = setup({ cv: resumeSite({ previews: false }) }, api)
  const plan = await buildPlan(sites, client)

  assert.equal(op(plan, 'cv', 'preview').op, 'delete')
  assert.deepEqual(plan.orphans, [{ worker: 'kunde-xy', uuid: 'trg-orphan', name: 'cfd:production' }])
  assert.match(renderMarkdown(plan), /bleibt \(Löschen nur mit `--allow-delete`\)/)

  await applyPlan(plan, client)
  assert.ok(api.state.triggers.some(t => t.trigger_uuid === 'trg-orphan'), 'ohne Flag bleibt der verwaiste Trigger')
  assert.ok(!api.state.triggers.some(t => t.trigger_uuid === 'trg-preview'))

  await applyPlan(await buildPlan(sites, client), client, { allowDelete: true })
  assert.ok(!api.state.triggers.some(t => t.trigger_uuid === 'trg-orphan'))
})

test('planEnv: ohne Konfiguration verschwinden nur eigene Variablen und der Marker', () => {
  const r = planEnv(
    {
      CFD_MANAGED_ENV: { value: 'A', is_secret: false },
      A: { value: '1', is_secret: false },
      B: { value: '2', is_secret: false },
    },
    {},
  )
  assert.deepEqual(r, { set: {}, remove: ['A', 'CFD_MANAGED_ENV'], skippedSecrets: [] })
})
