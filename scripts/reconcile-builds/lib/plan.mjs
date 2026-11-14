// Planung des Abgleichs: liest den Ist-Zustand über den Client und entscheidet,
// was mit den Build-Triggern und Build-Variablen passieren soll. Schreibt nie –
// das macht ausschließlich apply.mjs mit dem fertigen Plan.
//
// Eigentumsregel wie beim Turnstile-Abgleich (`cfcf:`): verwaltet werden nur
// Trigger, deren Name mit `cfd:` beginnt. Einzige Ausnahme ist die
// Bestandsübernahme – ein im Dashboard angelegter Trigger mit demselben Repo
// und demselben Branch-Muster wird umbenannt statt verdoppelt. Alle übrigen
// Trigger sind für diesen Abgleich unsichtbar, bis auf einen Hinweis im Plan.

import { MANAGED_ENV_MARKER } from './config.mjs'

export const MANAGED_PREFIX = 'cfd:'
export const ROLES = ['production', 'preview']
export const triggerName = role => `${MANAGED_PREFIX}${role}`

// Felder, die der Abgleich am Trigger setzt und vergleicht.
const TRIGGER_FIELDS = [
  'trigger_name',
  'build_command',
  'deploy_command',
  'root_directory',
  'branch_includes',
  'branch_excludes',
  'path_includes',
  'path_excludes',
  'build_caching_enabled',
]

/** Soll-Zustand eines Triggers aus der Site-Konfiguration. */
export function desiredTrigger(site, role) {
  const production = role === 'production'
  return {
    trigger_name: triggerName(role),
    build_command: site.buildCommand,
    deploy_command: production ? site.deployCommand : site.previewDeployCommand,
    root_directory: site.rootDirectory,
    // Vorschau = jeder Branch außer dem Produktionsbranch. Genau so legt auch
    // das Dashboard "Builds für Nicht-Produktions-Branches" an.
    branch_includes: production ? [site.productionBranch] : ['*'],
    branch_excludes: production ? [] : [site.productionBranch],
    path_includes: ['*'],
    path_excludes: [],
    build_caching_enabled: site.buildCaching,
  }
}

const repoOf = t =>
  t.repo_connection ? `${t.repo_connection.provider_account_name}/${t.repo_connection.repo_name}`.toLowerCase() : ''
const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i])
const isManaged = t => typeof t.trigger_name === 'string' && t.trigger_name.startsWith(MANAGED_PREFIX)

/** Erkennt einen vom Dashboard angelegten Trigger, der diese Rolle schon erfüllt. */
function adoptable(t, site, role) {
  if (isManaged(t) || repoOf(t) !== site.repo.toLowerCase()) return false
  if (role === 'production') return sameList(t.branch_includes, [site.productionBranch])
  return sameList(t.branch_includes, ['*']) && (t.branch_excludes ?? []).includes(site.productionBranch)
}

export function triggerChanges(current, desired) {
  const changes = []
  for (const f of TRIGGER_FIELDS) {
    const a = current[f]
    const b = desired[f]
    // Fehlende Felder zählen wie ihr Leerwert – die API lässt sie teils weg.
    const equal = Array.isArray(b)
      ? sameList(a ?? [], b)
      : (a ?? (typeof b === 'string' ? '' : typeof b === 'boolean' ? false : a)) === b
    if (!equal) changes.push({ field: f, from: a, to: b })
  }
  return changes
}

/**
 * Build-Variablen abgleichen. Gesetzt und aktualisiert wird, was in der
 * Konfiguration steht; entfernt wird nur, was laut Marker-Variable früher vom
 * Abgleich selbst gesetzt wurde. Secrets werden weder überschrieben noch
 * gelöscht – auch nicht, wenn sie denselben Namen tragen.
 */
export function planEnv(current, desired) {
  const set = {}
  const remove = []
  const skippedSecrets = []

  for (const [k, v] of Object.entries(desired)) {
    const cur = current[k]
    if (cur?.is_secret) {
      skippedSecrets.push(k)
      continue
    }
    if (!cur || cur.value !== v) set[k] = v
  }

  const managed = Object.keys(desired).filter(k => !skippedSecrets.includes(k)).sort()
  const marker = current[MANAGED_ENV_MARKER]
  const previously = typeof marker?.value === 'string' && marker.value ? marker.value.split(',') : []
  for (const k of previously) {
    if (!(k in desired) && current[k] && !current[k].is_secret) remove.push(k)
  }

  const markerValue = managed.join(',')
  if (managed.length > 0) {
    if (marker?.value !== markerValue && !marker?.is_secret) set[MANAGED_ENV_MARKER] = markerValue
  } else if (marker && !marker.is_secret) {
    remove.push(MANAGED_ENV_MARKER)
  }

  return { set, remove: remove.sort(), skippedSecrets }
}

/**
 * Ist-Zustand lesen und den Plan berechnen. Nur GET-Aufrufe.
 *
 * @param {object[]} sites   Ergebnis von normalizeSites()
 * @param {object}   client  createClient()
 */
export async function buildPlan(sites, client) {
  const plan = { sites: [], orphans: [], errors: [] }
  if (sites.length === 0) return plan

  const scripts = await client.listScripts()
  const tagOf = new Map(scripts.map(s => [s.id, s.tag]))

  // Trigger aller Worker: für verwaiste cfd-Trigger und um eine bestehende
  // Repo-Verbindung wiederzuverwenden, auch wenn sie an einem anderen Worker
  // hängt. Ein GET pro Worker.
  const triggersOf = new Map()
  for (const s of scripts) triggersOf.set(s.id, await client.listTriggers(s.tag))
  const allTriggers = [...triggersOf.values()].flat()

  let tokens = null
  const buildTokens = async () => (tokens ??= await client.listBuildTokens())

  const wanted = new Set(sites.map(s => s.workerName))

  for (const site of sites) {
    const entry = {
      slug: site.slug,
      worker: site.workerName,
      repo: site.repo,
      scriptTag: tagOf.get(site.workerName) ?? null,
      repoConnection: null,
      buildTokenUuid: null,
      triggers: [],
      warnings: [],
    }
    const fail = msg => plan.errors.push(`${site.slug}: ${msg}`)

    if (!entry.scriptTag) {
      fail(
        `Worker "${site.workerName}" existiert nicht im Account. Workers Builds hängt an einem bestehenden ` +
          'Worker – ihn einmal per `wrangler deploy` ausrollen (oder Tippfehler in workerName prüfen).',
      )
      continue
    }

    const triggers = triggersOf.get(site.workerName) ?? []
    const claimed = new Set()

    for (const role of ROLES) {
      const want = role === 'production' || site.previews
      const desired = desiredTrigger(site, role)
      const managed = triggers.filter(t => t.trigger_name === triggerName(role))

      if (managed.length > 1) {
        fail(`mehrere Trigger namens "${triggerName(role)}" am Worker – bitte im Dashboard bereinigen.`)
        continue
      }
      const [own] = managed
      if (own) claimed.add(own.trigger_uuid)

      if (!want) {
        // `previews: false` ist ein ausdrücklicher Wunsch, kein verwaister
        // Trigger – deshalb ohne Lösch-Flag. Nur der eigene `cfd:`-Trigger.
        if (own) entry.triggers.push({ role, op: 'delete', uuid: own.trigger_uuid, name: own.trigger_name })
        continue
      }

      let action
      if (own && repoOf(own) !== site.repo.toLowerCase()) {
        // Das Repo eines Triggers lässt sich nicht umhängen: löschen und neu.
        action = { role, op: 'replace', uuid: own.trigger_uuid, from: repoOf(own), desired }
      } else if (own) {
        const changes = triggerChanges(own, desired)
        action = { role, op: changes.length ? 'update' : 'keep', uuid: own.trigger_uuid, changes, desired }
      } else {
        const candidates = triggers.filter(t => !claimed.has(t.trigger_uuid) && adoptable(t, site, role))
        if (candidates.length > 1) {
          fail(
            `mehrere bestehende Trigger kommen für "${triggerName(role)}" in Frage ` +
              `(${candidates.map(t => t.trigger_name).join(', ')}) – einen davon im Dashboard löschen.`,
          )
          continue
        }
        if (candidates.length === 1) {
          const [c] = candidates
          claimed.add(c.trigger_uuid)
          action = { role, op: 'adopt', uuid: c.trigger_uuid, adoptedName: c.trigger_name, changes: triggerChanges(c, desired), desired }
        } else {
          action = { role, op: 'create', desired }
        }
      }

      const fresh = action.op === 'create' || action.op === 'replace'
      const currentEnv = fresh ? {} : await client.listEnv(action.uuid)
      action.env = planEnv(currentEnv, site.env)
      for (const k of action.env.skippedSecrets) {
        entry.warnings.push(`${triggerName(role)}: Variable ${k} ist als Secret gesetzt und wird nicht überschrieben.`)
      }
      entry.triggers.push(action)
    }

    for (const t of triggers) {
      if (claimed.has(t.trigger_uuid)) continue
      if (isManaged(t)) {
        if (!ROLES.some(r => t.trigger_name === triggerName(r))) {
          plan.orphans.push({ worker: site.workerName, uuid: t.trigger_uuid, name: t.trigger_name })
        }
        continue
      }
      entry.warnings.push(
        `Fremder Trigger "${t.trigger_name}" (Branches ${JSON.stringify(t.branch_includes ?? [])}) bleibt unverändert` +
          ' – baut er denselben Branch, wird doppelt deployt.',
      )
    }

    // Repo-Verbindung und Build-Token braucht nur, wer einen Trigger anlegt.
    if (entry.triggers.some(a => a.op === 'create' || a.op === 'replace')) {
      await resolveRepoConnection(entry, site, allTriggers, client, fail)
      await resolveBuildToken(entry, site, triggers, buildTokens, fail)
    }

    plan.sites.push(entry)
  }

  for (const [worker, triggers] of triggersOf) {
    if (wanted.has(worker)) continue
    for (const t of triggers) {
      if (isManaged(t)) plan.orphans.push({ worker, uuid: t.trigger_uuid, name: t.trigger_name })
    }
  }

  return plan
}

async function resolveRepoConnection(entry, site, allTriggers, client, fail) {
  const existing = allTriggers.find(t => repoOf(t) === site.repo.toLowerCase())
  if (existing) {
    entry.repoConnection = { uuid: existing.repo_connection.repo_connection_uuid }
    return
  }
  // Noch keine Verbindung im Account: die IDs, die Cloudflare dafür will,
  // kennt nur GitHub. Das Anlegen selbst (PUT, idempotent) passiert im Apply.
  const ids = await client.lookupGithubRepo(site.repo)
  if (!ids) {
    fail(
      `keine Repo-Verbindung für ${site.repo} im Account, und GitHub kennt das Repo nicht (privat?). ` +
        'Entweder die Cloudflare-GitHub-App auf das Repo berechtigen und den Worker einmal im Dashboard ' +
        '(Settings → Builds → Connect) verbinden, oder dem Workflow ein `BUILDS_GITHUB_TOKEN` mit ' +
        'Lesezugriff (Metadata: Read) auf das Repo mitgeben.',
    )
    return
  }
  entry.repoConnection = { create: ids }
}

async function resolveBuildToken(entry, site, triggers, buildTokens, fail) {
  const tokens = await buildTokens()
  if (site.buildTokenName) {
    const t = tokens.find(t => t.build_token_name === site.buildTokenName)
    if (t) entry.buildTokenUuid = t.build_token_uuid
    else fail(`Build-Token "${site.buildTokenName}" (builds.buildTokenName) gibt es im Account nicht.`)
    return
  }
  const fromTrigger = triggers.find(t => t.build_token_uuid)
  if (fromTrigger) {
    entry.buildTokenUuid = fromTrigger.build_token_uuid
    return
  }
  const byName = tokens.find(t => t.build_token_name === `${site.workerName} build token`)
  if (byName) {
    entry.buildTokenUuid = byName.build_token_uuid
    return
  }
  // Ein Build-Token per API anzulegen hieße, ein Cloudflare-API-Token samt
  // Secret zu erzeugen – das bleibt bewusst Handarbeit.
  fail(
    `kein Build-Token für Worker "${site.workerName}". Entweder den Worker einmal im Dashboard mit dem Repo ` +
      'verbinden (legt "<worker> build token" an) oder in `builds.buildTokenName` – gern in _defaults.json – ' +
      `den Namen eines bestehenden Build-Tokens angeben. Vorhanden: ${tokens.map(t => `"${t.build_token_name}"`).join(', ') || 'keine'}.`,
  )
}

export function hasChanges(plan, { allowDelete = false } = {}) {
  return (
    plan.sites.some(
      s =>
        s.repoConnection?.create ||
        s.triggers.some(a => a.op !== 'keep' || Object.keys(a.env?.set ?? {}).length || a.env?.remove.length),
    ) ||
    (allowDelete && plan.orphans.length > 0)
  )
}

/** Plan als Markdown – für Job-Summary und PR-Kommentar. Enthält keine Secrets. */
export function renderMarkdown(plan, { mode = 'plan', allowDelete = false } = {}) {
  const out = []
  out.push(`### Workers Builds – ${mode === 'apply' ? 'angewendet' : 'Plan'}`, '')

  if (plan.errors.length) {
    out.push('**Fehler – es wird nichts geändert:**', '')
    for (const e of plan.errors) out.push(`- ❌ ${e}`)
    out.push('')
  }

  if (plan.sites.length === 0 && plan.orphans.length === 0 && plan.errors.length === 0) {
    out.push('Keine Site mit `builds`-Block – nichts zu tun.')
    return out.join('\n')
  }

  const sym = { create: '➕', adopt: '🔁', update: '✏️', replace: '♻️', delete: '➖', keep: '✅' }
  const label = {
    create: 'anlegen',
    adopt: 'übernehmen',
    update: 'aktualisieren',
    replace: 'neu anlegen (anderes Repo)',
    delete: 'löschen (previews: false)',
    keep: 'unverändert',
  }

  for (const s of plan.sites) {
    out.push(`#### \`${s.slug}\` – Worker \`${s.worker}\` ← \`${s.repo}\``, '')
    if (s.repoConnection?.create) out.push(`- ➕ Repo-Verbindung zu \`${s.repo}\` anlegen`)
    for (const a of s.triggers) {
      const name = triggerName(a.role)
      const extra = a.op === 'adopt' ? ` (bisher \`${a.adoptedName}\`)` : a.op === 'replace' ? ` (bisher \`${a.from}\`)` : ''
      out.push(`- ${sym[a.op]} \`${name}\` ${label[a.op]}${extra}`)
      for (const c of a.changes ?? []) {
        if (c.field === 'trigger_name') continue
        out.push(`  - \`${c.field}\`: ${fmt(c.from)} → ${fmt(c.to)}`)
      }
      if (a.op === 'create' || a.op === 'replace') {
        const d = a.desired
        out.push(
          `  - Branches ${fmt(d.branch_includes)}${d.branch_excludes.length ? ` ohne ${fmt(d.branch_excludes)}` : ''}, ` +
            `Build ${fmt(d.build_command)}, Deploy ${fmt(d.deploy_command)}, Root ${fmt(d.root_directory)}`,
        )
      }
      for (const [k, v] of Object.entries(a.env?.set ?? {})) {
        if (k !== MANAGED_ENV_MARKER) out.push(`  - Variable \`${k}\` = ${fmt(v)}`)
      }
      for (const k of a.env?.remove ?? []) {
        if (k !== MANAGED_ENV_MARKER) out.push(`  - Variable \`${k}\` entfernen`)
      }
    }
    for (const w of s.warnings) out.push(`- ⚠️ ${w}`)
    out.push('')
  }

  if (plan.orphans.length) {
    out.push('#### Verwaiste `cfd:`-Trigger', '')
    for (const o of plan.orphans) {
      out.push(`- ${allowDelete ? '➖' : '⏸️'} \`${o.name}\` an \`${o.worker}\`${allowDelete ? ' – wird gelöscht' : ' – bleibt (Löschen nur mit `--allow-delete`)'}`)
    }
    out.push('')
  }

  if (plan.errors.length === 0 && !hasChanges(plan, { allowDelete })) out.push('Keine Änderungen.')
  return out.join('\n').trimEnd()
}

const fmt = v => (v === undefined || v === null ? '–' : `\`${JSON.stringify(v)}\``)
