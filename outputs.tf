output "sites" {
  description = "Übersicht je Site: kanonische URL, Worker und aktive Weiterleitungen."
  value = {
    for slug, s in local.sites : slug => {
      canonical_url = "https://${s.canonicalDomain}"
      worker        = s.workerName
      redirects = {
        for d in s.redirectDomains :
        d => "https://${s.canonicalDomain} (${s.redirectStatusCode})"
      }
    }
  }
}

output "zone_assignment" {
  description = "Welche Domain in welcher Cloudflare-Zone gelandet ist."
  value       = module.plan.zone_name_for
}

output "redirect_rulesets" {
  description = <<-EOT
    Was pro Zone in EINEM Ruleset landet. Zwei Sites, die sich eine Zone
    teilen, erscheinen hier als zwei Regeln unter demselben Zonen-Key –
    Cloudflare erlaubt pro Zone und Phase nur ein Entry-Point-Ruleset.
  EOT
  value = {
    for zn, rules in local.rules_by_zone : zn => [
      for r in rules : {
        site        = r.slug
        domains     = r.domains
        target      = "https://${r.target}"
        status_code = r.status
      }
    ]
  }
}

output "managed_zones" {
  description = "Alle Zonen, die von dieser Konfiguration berührt werden."
  value       = module.plan.managed_zones
}

output "workers_dev_disabled" {
  description = <<-EOT
    Worker, deren *.workers.dev-Hostname abgeschaltet wurde. Wird ein Worker
    hier nicht gelistet, ist die Seite zusätzlich unter
    `<name>.<subdomain>.workers.dev` erreichbar – dagegen wirkt dann nur der
    canonical-Tag der Seite.
  EOT
  value       = local.workers_dev_disabled
}
