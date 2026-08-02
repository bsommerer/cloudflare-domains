#############################################
# Lookups
#############################################

# Einmal für alle Sites – nicht pro Site. Voraussetzung der Engine ist, dass
# die Domains bereits bei Cloudflare liegen; Zonen werden gelesen, nicht
# angelegt.
data "cloudflare_zones" "all" {
  account   = { id = var.account_id }
  max_items = local.zone_page_size
}

# Nur zur Existenzprüfung: ein Tippfehler in `workerName` soll im Plan
# auffallen, nicht erst beim Apply.
data "cloudflare_workers_scripts" "all" {
  account_id = var.account_id
  max_items  = local.worker_page_size
}

#############################################
# Planung
#############################################

# Reine Funktion ohne Provider-Zugriff: Konfiguration + Zonen + Worker -> Plan.
# Die gesamte kniffelige Logik (Zonen-Zuordnung per längstem Suffix,
# Aggregation über Sites hinweg) liegt hier und ist in tests/ ohne Cloudflare
# vollständig abgedeckt.
module "plan" {
  source = "./modules/site-plan"

  zones     = { for z in data.cloudflare_zones.all.result : z.name => z.id }
  workers   = [for w in data.cloudflare_workers_scripts.all.result : w.id]
  raw_sites = local.raw_sites
  defaults  = local.defaults
  sites     = var.sites
}

#############################################
# Kanonische Domain -> Worker
#############################################

# Eine Workers Custom Domain legt ihren DNS-Record selbst an ("After you have
# added the domain or subdomain, Cloudflare will create a new DNS record for
# you") – anders als bei Pages gibt es hier also bewusst KEINEN eigenen
# cloudflare_dns_record. Ein zusätzlicher Record würde die Custom Domain sogar
# blockieren: sie lässt sich auf einem Hostnamen mit bestehendem CNAME nicht
# anlegen.
resource "cloudflare_workers_custom_domain" "canonical" {
  for_each = local.sites

  account_id = var.account_id
  hostname   = each.value.canonicalDomain
  service    = each.value.workerName
  zone_id    = local.zone_id_for[each.value.canonicalDomain]
}

# Optional: den *.workers.dev-Hostnamen abschalten, damit die Seite nicht
# zusätzlich unter einer Cloudflare-Domain indexiert wird. Nur verwaltet, wenn
# `disableWorkersDev` in der Site-Datei gesetzt ist.
resource "cloudflare_workers_script_subdomain" "canonical" {
  for_each = toset(local.workers_dev_disabled)

  account_id  = var.account_id
  script_name = each.value
  enabled     = false
}

#############################################
# Redirect-Domains
#############################################

# Proxied Platzhalter-Record: bringt den Request an die Edge, ohne dass ein
# Origin existieren muss. Die Redirect Rule greift davor. Redirect-Domains
# werden bewusst NICHT mit dem Worker verknüpft.
resource "cloudflare_dns_record" "redirect" {
  for_each = local.redirect_records

  zone_id = each.value.zone_id
  name    = each.key
  type    = "AAAA"
  content = var.placeholder_ipv6
  proxied = true
  ttl     = 1 # bei proxied Records erzwingt Cloudflare TTL "automatic"
  comment = "Managed by Terraform - ${each.value.status_code} -> ${each.value.target}"
}

# Ein Ruleset pro Zone, mit einer Regel je Site in dieser Zone.
resource "cloudflare_ruleset" "redirect" {
  for_each = local.rules_by_zone

  zone_id     = local.zone_ids_by_name[each.key]
  name        = "canonical-redirects"
  description = "Kanonische Weiterleitungen (Terraform)"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    for r in each.value : {
      action      = "redirect"
      description = "${join(", ", r.domains)} -> ${r.target}"
      enabled     = true
      expression  = format("http.host in {%s}", join(" ", [for d in r.domains : "\"${d}\""]))

      action_parameters = {
        from_value = {
          status_code           = r.status
          preserve_query_string = r.preserve

          # `expression` statt `value`, damit der Pfad erhalten bleibt –
          # ein statischer `value` würde jeden Request auf "/" werfen.
          target_url = {
            expression = "concat(\"https://${r.target}\", http.request.uri.path)"
          }
        }
      }
    }
  ]

  depends_on = [cloudflare_dns_record.redirect]
}

#############################################
# http -> https
#############################################

# Deckt Aufrufe über http:// ab, für alle beteiligten Zonen – also auch die
# der Redirect-Domains.
resource "cloudflare_zone_setting" "always_use_https" {
  for_each = toset(local.https_zones)

  zone_id    = local.zone_ids_by_name[each.value]
  setting_id = "always_use_https"
  value      = "on"
}
