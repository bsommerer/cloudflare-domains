// Führt einen fertigen Plan aus. Entscheidet nichts mehr selbst – alles, was
// hier passiert, stand vorher im Plan (und damit im PR-Kommentar).

import { MANAGED_ENV_MARKER } from './config.mjs'

/**
 * @param {object}   plan     Ergebnis von buildPlan()
 * @param {object}   client   createClient()
 * @param {object}   opts
 * @param {boolean}  opts.allowDelete  verwaiste `cfd:`-Trigger löschen
 * @param {Function} opts.log
 */
export async function applyPlan(plan, client, { allowDelete = false, log = () => {} } = {}) {
  if (plan.errors.length) throw new Error('Plan enthält Fehler – es wird nichts angewendet.')

  for (const s of plan.sites) {
    let repoConnectionUuid = s.repoConnection?.uuid
    if (s.repoConnection?.create) {
      const conn = await client.upsertRepoConnection(s.repoConnection.create)
      repoConnectionUuid = conn.repo_connection_uuid
      log(`${s.slug}: Repo-Verbindung ${s.repo} angelegt`)
    }

    for (const a of s.triggers) {
      let uuid = a.uuid
      switch (a.op) {
        case 'keep':
          break
        case 'delete':
          await client.deleteTrigger(uuid)
          log(`${s.slug}: ${a.name} gelöscht`)
          continue
        case 'adopt':
        case 'update':
          await client.updateTrigger(uuid, a.desired)
          log(`${s.slug}: ${a.desired.trigger_name} ${a.op === 'adopt' ? `übernommen (bisher ${a.adoptedName})` : 'aktualisiert'}`)
          break
        case 'replace':
          await client.deleteTrigger(uuid)
        // fallthrough: danach wie ein neuer Trigger
        case 'create': {
          const t = await client.createTrigger({
            external_script_id: s.scriptTag,
            repo_connection_uuid: repoConnectionUuid,
            build_token_uuid: s.buildTokenUuid,
            ...a.desired,
          })
          uuid = t.trigger_uuid
          log(`${s.slug}: ${a.desired.trigger_name} angelegt`)
          break
        }
        default:
          throw new Error(`unbekannte Aktion ${a.op}`)
      }

      const { set = {}, remove = [] } = a.env ?? {}
      if (Object.keys(set).length) {
        const body = Object.fromEntries(Object.entries(set).map(([k, v]) => [k, { value: v, is_secret: false }]))
        await client.setEnv(uuid, body)
        const names = Object.keys(set).filter(k => k !== MANAGED_ENV_MARKER)
        if (names.length) log(`${s.slug}: ${a.desired.trigger_name} Variablen gesetzt: ${names.join(', ')}`)
      }
      for (const k of remove) {
        await client.deleteEnv(uuid, k)
        if (k !== MANAGED_ENV_MARKER) log(`${s.slug}: ${a.desired.trigger_name} Variable ${k} entfernt`)
      }
    }
  }

  if (allowDelete) {
    for (const o of plan.orphans) {
      await client.deleteTrigger(o.uuid)
      log(`${o.worker}: verwaisten Trigger ${o.name} gelöscht`)
    }
  }
}
