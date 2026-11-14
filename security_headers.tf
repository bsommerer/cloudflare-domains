#############################################
# Basis-Security-Header
#############################################

# Ein Ruleset pro Zone, mit einer oder mehreren Regeln je Site. Wie bei den
# Redirects erlaubt Cloudflare pro Zone und Phase nur ein Entry-Point-Ruleset,
# deshalb wird über alle Sites hinweg aggregiert (siehe modules/site-plan).
#
# Das Token braucht dafür zusätzlich „Zone · Transform Rules · Edit“.
#
# Die Plan-Logik (welche Hosts, welche Header, Vorrang gegenüber `_headers`)
# steht samt Begründung in modules/site-plan/security_headers.tf.
resource "cloudflare_ruleset" "security_headers" {
  for_each = module.plan.security_rules_by_zone

  # Übernommene Rulesets behalten ihren Namen, sonst ersetzt der Provider sie.
  zone_id     = local.zone_ids_by_name[each.key]
  name        = module.plan.security_ruleset_names[each.key]
  description = "Basis-Security-Header (Terraform)"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [
    for r in each.value : {
      action      = "rewrite"
      description = r.description
      enabled     = true
      expression  = r.expression

      action_parameters = {
        headers = {
          for name, value in r.headers : name => {
            operation = "set"
            value     = value
          }
        }
      }
    }
  ]
}

# Bestandsübernahme wie beim Redirect-Ruleset: ein schon vorhandenes Ruleset der
# Header-Phase wird importiert statt neu angelegt. Danach gehört es der Engine –
# fremde Regeln darin zeigt der Plan als Löschung.
import {
  for_each = module.plan.security_ruleset_adoptions

  to = cloudflare_ruleset.security_headers[each.key]
  id = "zones/${local.zone_ids_by_name[each.key]}/${each.value}"
}

resource "terraform_data" "security_headers" {
  input = module.plan.security_headers

  lifecycle {
    precondition {
      condition     = length(module.plan.security_findings.invalid_hsts) == 0
      error_message = <<-EOT
        Ungültige HSTS-Einstellung bei: ${join(", ", module.plan.security_findings.invalid_hsts)}.
        `maxAge` muss eine nicht negative Zahl sein; mit `preload` verlangt die
        Preload-Liste mindestens 31536000 Sekunden und `includeSubDomains`.
      EOT
    }
  }
}

output "security_header_rulesets" {
  description = "Was pro Zone im Header-Ruleset landet: Hosts und Header je Regel."
  value = {
    for zn, rules in module.plan.security_rules_by_zone : zn => [
      for r in rules : { site = r.slug, hosts = r.hosts, headers = r.headers, only_if_absent = r.guard != "" }
    ]
  }
}
