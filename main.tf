#############################################
# Lookups
#############################################

# Einmal für alle Sites – nicht pro Site. Voraussetzung des Moduls ist, dass
# die Domains bereits bei Cloudflare liegen; Zonen werden gelesen, nicht
# angelegt.
data "cloudflare_zones" "all" {
  account   = { id = var.account_id }
  max_items = local.zone_page_size
}

#############################################
# Planung
#############################################

# Reine Funktion ohne Provider-Zugriff: Konfiguration + Zonenliste -> Plan.
# Die gesamte kniffelige Logik (Zonen-Zuordnung per längstem Suffix,
# Aggregation über Sites hinweg) liegt hier und ist in tests/ ohne Cloudflare
# vollständig abgedeckt.
module "plan" {
  source = "./modules/site-plan"

  zones     = { for z in data.cloudflare_zones.all.result : z.name => z.id }
  raw_sites = local.raw_sites
  defaults  = local.defaults
  sites     = var.sites
}

# Liefert das echte "<projekt>.pages.dev"-Ziel, statt es aus dem Projektnamen
# zu raten – bei Namenskollisionen hängt Cloudflare ein Suffix an.
data "cloudflare_pages_project" "this" {
  for_each = local.sites

  account_id   = var.account_id
  project_name = each.value.pagesProject
}

#############################################
# Kanonische Domain -> Pages
#############################################

# Cloudflare legt für eine Pages-Custom-Domain KEINEN DNS-Record an
# (ausdrücklicher Hinweis in der Provider-Doku), deshalb hier explizit.
# CNAME auf den Apex ist bei Cloudflare dank CNAME-Flattening zulässig.
resource "cloudflare_dns_record" "canonical" {
  for_each = local.sites

  zone_id = local.zone_id_for[each.value.canonicalDomain]
  name    = each.value.canonicalDomain
  type    = "CNAME"
  content = data.cloudflare_pages_project.this[each.key].subdomain
  proxied = true
  ttl     = 1 # bei proxied Records erzwingt Cloudflare TTL "automatic"
  comment = "Managed by Terraform - Pages: ${each.value.pagesProject}"
}

resource "cloudflare_pages_domain" "canonical" {
  for_each = local.sites

  account_id   = var.account_id
  project_name = each.value.pagesProject
  name         = each.value.canonicalDomain

  # Ohne den DNS-Record bleibt die Domain-Validierung bei Cloudflare hängen.
  depends_on = [cloudflare_dns_record.canonical]
}

#############################################
# Redirect-Domains
#############################################

# Proxied Platzhalter-Record: bringt den Request an die Edge, ohne dass ein
# Origin existieren muss. Die Redirect Rule greift davor. Redirect-Domains
# werden bewusst NICHT mit dem Pages-Projekt verknüpft.
resource "cloudflare_dns_record" "redirect" {
  for_each = local.redirect_records

  zone_id = each.value.zone_id
  name    = each.key
  type    = "AAAA"
  content = var.placeholder_ipv6
  proxied = true
  ttl     = 1
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
