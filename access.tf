#############################################
# protectPreviews: Preview-URLs hinter Cloudflare Access
#
# Preview-URLs eines Workers (`<version>-<worker>.<subdomain>.workers.dev`,
# `<alias>-<worker>.<subdomain>.workers.dev`) sind ohne Schutz öffentlich.
# Das Dashboard („Workers & Pages“ > Worker > Access > „Previews only“) legt
# dafür eine self-hosted Access-Application mit einer Destination vom Typ
# `preview_worker` an – gebunden an die unveränderliche ID des Workers, nicht
# an einen Hostnamen. Genau das wird hier nachgebaut:
# https://developers.cloudflare.com/workers/configuration/cloudflare-access/
#
# Bewusst NICHT verwaltet: ob Preview-URLs überhaupt ausgeliefert werden. Das
# steuert `preview_urls` in der wrangler.toml, und wrangler setzt es bei jedem
# Deploy neu – eine zweite Quelle hier würde sich mit jedem Deploy streiten.
# Die Engine schützt nur, was wrangler ausrollt.
#############################################

# Access-Destinations erwarten die unveränderliche Worker-ID, nicht den Namen.
# Die liefert die neue Workers-API (`cloudflare_workers`) direkt als `id` – das
# ältere Script-Listing in main.tf nennt sie `tag`. Nur gelesen, wenn überhaupt
# eine Site Previews schützt; die Zuordnung Name -> ID geht als `worker_ids` ins
# Planer-Modul (main.tf).
data "cloudflare_workers" "preview" {
  count = length(local.preview_protection) > 0 ? 1 : 0

  account_id = var.account_id
  max_items  = local.worker_page_size
}

locals {
  preview_protection   = module.plan.preview_protection
  preview_applications = module.plan.preview_applications
  preview_findings     = module.plan.preview_findings

  # Nur informativ für den Output unten.
  preview_url_suffixes = {
    for w in try(data.cloudflare_workers.preview[0].result, []) :
    w.name => try(w.subdomain.preview_url_suffix, null)
  }
}

# Wiederverwendbare Policy statt einer Inline-Policy in der Application: so
# macht es auch das Dashboard, und die Policy taucht in Zero Trust unter
# „Policies“ mit Namen auf. Eine pro Worker, weil die Allowlist pro Worker
# aggregiert wird.
resource "cloudflare_zero_trust_access_policy" "preview" {
  for_each = local.preview_protection

  account_id = var.account_id
  name       = "${each.key} - Previews (Terraform)"
  decision   = "allow"

  # Angemeldet wird per Login-Methode des Zero-Trust-Accounts, ohne eigenen
  # IdP also per One-time PIN an die E-Mail-Adresse.
  include = local.preview_applications[each.key].include
}

resource "cloudflare_zero_trust_access_application" "preview" {
  for_each = local.preview_protection

  account_id = var.account_id
  name       = "${each.key} - Previews (Terraform)"
  type       = "self_hosted"

  # Nur die Previews. `worker` statt `preview_worker` würde auch Produktion
  # (Custom Domain, Routen, workers.dev) hinter den Login stellen.
  destinations = [{
    type      = "preview_worker"
    worker_id = local.preview_applications[each.key].worker_id
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.preview[each.key].id
    precedence = 1
  }]

  # Vorschauen sind kein Ziel für das App-Launcher-Portal der Organisation.
  app_launcher_visible = false

  lifecycle {
    precondition {
      condition     = local.preview_applications[each.key].worker_id != ""
      error_message = <<-EOT
        Für den Worker "${each.key}" wurde keine Worker-ID gefunden – Access
        braucht die unveränderliche ID, nicht den Namen. Existiert der Worker
        (`wrangler deploy`), und darf das Token Workers lesen?
      EOT
    }
  }
}

#############################################
# Guards
#############################################

resource "terraform_data" "preview_protection" {
  input = keys(local.preview_protection)

  lifecycle {
    precondition {
      condition     = length(local.preview_findings.preview_without_allowlist) == 0
      error_message = <<-EOT
        Diese Sites schalten protectPreviews ein, lassen aber niemanden zu:
        ${join(", ", local.preview_findings.preview_without_allowlist)}.
        `allowedEmails` oder `allowedEmailDomains` setzen – in der Site-Datei
        oder zentral in `_defaults.json`.
      EOT
    }

    precondition {
      condition     = length(local.preview_findings.invalid_preview_emails) == 0
      error_message = <<-EOT
        Ungültige Einträge in protectPreviews.allowedEmails:
        ${join(", ", local.preview_findings.invalid_preview_emails)}.
      EOT
    }

    precondition {
      condition     = length(local.preview_findings.invalid_preview_email_domains) == 0
      error_message = <<-EOT
        Ungültige Einträge in protectPreviews.allowedEmailDomains:
        ${join(", ", local.preview_findings.invalid_preview_email_domains)}.
        Erwartet wird eine Domain wie "example.com", ohne "@".
      EOT
    }
  }
}

output "protected_previews" {
  description = <<-EOT
    Worker, deren Preview-URLs nur nach Access-Login erreichbar sind, mit den
    Sites dahinter und dem Host-Suffix der Previews. Ob Previews überhaupt
    ausgeliefert werden, steuert `preview_urls` in der wrangler.toml.
  EOT
  value = {
    for w, p in local.preview_protection : w => {
      sites = p.sites
      # Von Cloudflare geliefert; davor gehört die Versions- oder
      # Alias-Kennung. null, wenn der Account keine workers.dev-Subdomain hat.
      preview_url_suffix = lookup(local.preview_url_suffixes, w, null)
    }
  }
}
