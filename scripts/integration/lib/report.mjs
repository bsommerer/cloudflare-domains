// Ausgabe: GitHub-Annotations für die Log-Ansicht und Markdown für die
// Job-Summary. Rein, damit die Form getestet werden kann.

const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escTitle = s => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** `::error`/`::notice` je fehlgeschlagener bzw. übersprungener Prüfung. */
export function annotations(report) {
  const lines = []
  for (const site of report) {
    for (const r of site.results) {
      if (r.state === 'fail') lines.push(`::error title=${escTitle(`${site.slug}: ${r.title}`)}::${esc(r.detail)}`)
      if (r.state === 'skip') lines.push(`::notice title=${escTitle(`${site.slug}: ${r.title}`)}::übersprungen – ${esc(r.detail)}`)
    }
  }
  return lines
}

export function counts(report) {
  const c = { pass: 0, fail: 0, skip: 0 }
  for (const s of report) for (const r of s.results) c[r.state]++
  return c
}

export const hasFailures = report => counts(report).fail > 0

export function renderMarkdown(report, { errors = [] } = {}) {
  const icon = { pass: '✅', fail: '❌', skip: '⏭️' }
  const label = { pass: 'ok', fail: 'Fehler', skip: 'übersprungen' }
  const c = counts(report)
  const lines = ['### cloudflare-domains – Integrationstests', '']

  if (errors.length) {
    lines.push('**Konfiguration nicht auswertbar:**', '', ...errors.map(e => `- ${e}`), '')
  }
  if (report.length === 0 && !errors.length) {
    lines.push('Keine Site mit prüfbaren Einstellungen – nichts zu tun.')
    return lines.join('\n')
  }

  lines.push(`${c.pass} bestanden, ${c.fail} fehlgeschlagen, ${c.skip} übersprungen.`, '')
  for (const site of report) {
    lines.push(`#### \`${site.slug}\``, '', '| Prüfung | Ergebnis | Details |', '| --- | --- | --- |')
    for (const r of site.results) {
      const tries = r.tries > 1 ? ` (${r.tries} Versuche)` : ''
      const detail = String(r.detail ?? '').replace(/\|/g, '\\|') || '–'
      lines.push(`| ${r.title} | ${icon[r.state]} ${label[r.state]}${tries} | ${detail} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
