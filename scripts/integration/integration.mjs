#!/usr/bin/env node
// Integrationstests: prüft live, ob das, was die Site-Dateien beschreiben, auch
// wirklich so ausgeliefert wird – kanonische Domain, http -> https,
// Weiterleitungen samt Pfad und Query, Security-Header, abgeschaltetes
// workers.dev, Access vor den Preview-URLs und die Build-Trigger.
//
//   node scripts/integration/integration.mjs --sites-dir <dir> [--site <slug>]...
//        [--max-wait <sekunden>] [--workers-subdomain <name>]
//
// Umgebung (optional – ohne Token werden Previews und Builds übersprungen,
// redirectWWW wird ohne Zonenliste genähert):
//   CLOUDFLARE_API_TOKEN       Zone: Read, Workers Scripts: Read,
//                              Workers Builds Configuration: Read
//   CLOUDFLARE_ACCOUNT_ID
//   INTEGRATION_SUMMARY_OUT    Markdown zusätzlich in diese Datei
//   GITHUB_STEP_SUMMARY        wird von GitHub Actions gesetzt
//
// Nur GET-Requests. Exit 1 bei mindestens einer fehlgeschlagenen Prüfung.

import { appendFileSync, writeFileSync } from 'node:fs'
import { readSitesDir, deriveChecks } from './lib/expect.mjs'
import { createApi, runChecks } from './lib/run.mjs'
import { annotations, renderMarkdown, hasFailures, counts } from './lib/report.mjs'

function parseArgs(argv) {
  const args = { sitesDir: null, only: [], maxWait: 600, workersSubdomain: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sites-dir') args.sitesDir = argv[++i]
    else if (a === '--site') args.only.push(...String(argv[++i] ?? '').split(',').filter(Boolean))
    else if (a === '--max-wait') args.maxWait = Number(argv[++i])
    else if (a === '--workers-subdomain') args.workersSubdomain = argv[++i]
    else throw new Error(`unbekanntes Argument ${a}`)
  }
  if (!args.sitesDir) throw new Error('--sites-dir fehlt')
  if (!Number.isFinite(args.maxWait) || args.maxWait < 0) throw new Error('--max-wait erwartet Sekunden ≥ 0')
  return args
}

function emit(markdown) {
  console.log(markdown)
  if (process.env.INTEGRATION_SUMMARY_OUT) writeFileSync(process.env.INTEGRATION_SUMMARY_OUT, `${markdown}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`✖ ${err.message}`)
    process.exit(2)
  }

  const token = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const api = token && accountId ? createApi({ token, accountId }) : null
  if (!api) console.log('::notice::Ohne CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID werden Previews und Builds übersprungen.')

  // Ohne Zone: Read nur eine Warnung – redirectWWW wird dann genähert.
  const zones = api
    ? await api.zones().catch(err => {
        console.log(`::warning::Zonenliste nicht lesbar (${err.message}) – www-Varianten werden über die Label-Zahl bestimmt.`)
        return null
      })
    : null
  const workersSubdomain = args.workersSubdomain ?? (api ? await api.workersSubdomain() : null)

  const { raw, defaults } = readSitesDir(args.sitesDir)
  const { sites, errors } = deriveChecks(raw, defaults, { zones, only: args.only.length ? args.only : null })
  if (errors.length) {
    for (const e of errors) console.log(`::error::${e}`)
    emit(renderMarkdown([], { errors }))
    process.exit(1)
  }

  const report = await runChecks(sites, {
    api,
    workersSubdomain,
    maxWaitMs: args.maxWait * 1000,
    log: m => console.error(m),
  })

  for (const line of annotations(report)) console.log(line)
  emit(renderMarkdown(report))
  const c = counts(report)
  console.error(`${c.pass} bestanden, ${c.fail} fehlgeschlagen, ${c.skip} übersprungen`)
  process.exit(hasFailures(report) ? 1 : 0)
}

main().catch(err => {
  console.error(`✖ ${err.message}`)
  process.exit(1)
})
