output "sites" {
  description = "Normalisierte Sites: Slug -> vollständig aufgelöste Domain-Konfiguration."
  value       = local.sites
}

output "zone_name_for" {
  description = "Domain -> Name der zuständigen Zone (leer, wenn keine passt)."
  value       = local.zone_name_for
}

output "zone_id_for" {
  description = "Domain -> Zonen-ID (leer, wenn keine passt)."
  value       = local.zone_id_for
}

output "zone_ids_by_name" {
  description = "Zonenname -> Zonen-ID, kleingeschrieben."
  value       = local.zone_ids_by_name
}

output "redirect_records" {
  description = "Redirect-Domain -> zuständige Site, Ziel, Status und Zonen-ID."
  value       = local.redirect_records
}

output "rules_by_zone" {
  description = "Zone -> Liste der Redirect-Regeln, die in EIN Ruleset gehören."
  value       = local.rules_by_zone
}

output "https_zones" {
  description = "Zonen, in denen always_use_https gesetzt werden soll (dedupliziert)."
  value       = local.https_zones
}

output "managed_zones" {
  description = "Alle berührten Zonen."
  value       = local.managed_zones
}

output "workers_dev_disabled" {
  description = "Worker, deren *.workers.dev-Hostname abgeschaltet werden soll (dedupliziert)."
  value       = local.workers_dev_disabled
}

output "custom_domain_adoptions" {
  description = <<-EOT
    Slug -> ID der bereits bestehenden Workers Custom Domain. Nur Sites, deren
    kanonische Domain im Account schon verknüpft ist; alle anderen legt die
    Engine regulär an.
  EOT
  value       = local.custom_domain_adoptions
}

output "ruleset_adoptions" {
  description = <<-EOT
    Zonenname -> ID des bereits bestehenden Redirect-Rulesets. Nur Zonen, in
    denen die Engine Weiterleitungen setzt und schon ein Ruleset der Phase
    `http_request_dynamic_redirect` existiert.
  EOT
  value       = local.ruleset_adoptions
}

output "redirect_ruleset_names" {
  description = <<-EOT
    Zonenname -> Name des Redirect-Rulesets. Bei einer Übernahme der
    bestehende Name, sonst `canonical-redirects`.
  EOT
  value       = local.redirect_ruleset_names
}

output "findings" {
  description = "Konfigurationsprobleme, die der Root als Precondition hart abbricht."
  value       = local.findings
}

output "security_headers" {
  description = "Slug -> Header, die für die Site gesetzt werden (nur Sites mit aktivem `securityHeaders`)."
  value       = local.sec_headers
}

output "security_rules_by_zone" {
  description = <<-EOT
    Zone -> Regeln für das Header-Transform-Ruleset. Je Regel: Hosts, Header,
    Expression und – im Standard – der Header, den die Antwort noch nicht haben
    darf (`guard`, leer im Überschreib-Modus).
  EOT
  value       = local.security_rules_by_zone
}

output "security_ruleset_adoptions" {
  description = "Zonenname -> ID des bereits bestehenden Rulesets der Phase `http_response_headers_transform`."
  value       = local.security_ruleset_adoptions
}

output "ruleset_lookup_zones" {
  description = "Zonen, für die der Root vorhandene Rulesets nachschlagen soll (Redirects und Header)."
  value       = local.ruleset_lookup_zones
}

output "security_findings" {
  description = "Konfigurationsprobleme bei `securityHeaders`; der Root bricht den Plan ab."
  value       = local.security_findings
}
