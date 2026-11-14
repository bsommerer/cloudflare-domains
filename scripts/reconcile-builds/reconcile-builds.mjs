#!/usr/bin/env node
// Gleicht Cloudflare Workers Builds (Git-Anbindung der Worker) mit den
// `builds`-Blöcken der Site-Dateien ab. Ergänzt das Terraform der Engine: der
// Provider (cloudflare 5.22) hat für Workers Builds keine Resource.
//
//   node scripts/reconcile-builds/reconcile-builds.mjs plan  --sites-dir <dir>
//   node scripts/reconcile-builds/reconcile-builds.mjs apply --sites-dir <dir> [--allow-delete]
//
// Umgebung:
//   CLOUDFLARE_API_TOKEN   Workers Builds Configuration: Edit + Workers Scripts: Read
//   CLOUDFLARE_ACCOUNT_ID
//   BUILDS_GITHUB_TOKEN    optional: nur nötig, um für ein privates Repo ohne
//                          bestehende Repo-Verbindung die GitHub-IDs zu lesen
//   BUILDS_SUMMARY_OUT     optional: Markdown-Plan zusätzlich in diese Datei
//
// Ohne Site mit `builds`-Block ist das Skript ein No-Op und spricht mit
// niemandem – bestehende Aufrufer brauchen weder Token-Recht noch Konfiguration.

import { writeFileSync } from 'node:fs'
import { readSitesDir } from './lib/config.mjs'
import { createClient } from './lib/cloudflare.mjs'
import { buildPlan, renderMarkdown } from './lib/plan.mjs'
import { applyPlan } from './lib/apply.mjs'

function parseArgs(argv) {
  const args = { mode: argv[0], sitesDir: null, allowDelete: false }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--sites-dir') args.sitesDir = argv[++i]
    else if (argv[i] === '--allow-delete') args.allowDelete = true
    else throw new Error(`unbekanntes Argument ${argv[i]}`)
  }
  if (!['plan', 'apply'].includes(args.mode)) throw new Error('Modus fehlt: plan oder apply')
  if (!args.sitesDir) throw new Error('--sites-dir fehlt')
  return args
}

function emit(markdown) {
  console.log(markdown)
  if (process.env.BUILDS_SUMMARY_OUT) writeFileSync(process.env.BUILDS_SUMMARY_OUT, `${markdown}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { sites, errors } = readSitesDir(args.sitesDir)

  if (errors.length) {
    emit(renderMarkdown({ sites: [], orphans: [], errors }, { mode: args.mode }))
    process.exit(1)
  }
  if (sites.length === 0) {
    emit(renderMarkdown({ sites: [], orphans: [], errors: [] }, { mode: args.mode }))
    return
  }

  const token = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN und CLOUDFLARE_ACCOUNT_ID müssen gesetzt sein.')

  const client = createClient({ token, accountId, githubToken: process.env.BUILDS_GITHUB_TOKEN || '' })
  const plan = await buildPlan(sites, client)

  if (args.mode === 'plan' || plan.errors.length) {
    emit(renderMarkdown(plan, { mode: 'plan', allowDelete: args.allowDelete }))
    if (plan.errors.length) process.exit(1)
    return
  }

  await applyPlan(plan, client, { allowDelete: args.allowDelete, log: m => console.error(`✓ ${m}`) })
  emit(renderMarkdown(plan, { mode: 'apply', allowDelete: args.allowDelete }))
}

main().catch(err => {
  console.error(`✖ ${err.message}`)
  process.exit(1)
})
