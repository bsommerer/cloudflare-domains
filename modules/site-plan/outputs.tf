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

output "findings" {
  description = "Konfigurationsprobleme, die der Root als Precondition hart abbricht."
  value       = local.findings
}
