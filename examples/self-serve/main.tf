# Self-Serve: Engine als Modul, Sites direkt inline. Kein Config-Repo, kein
# Remote-State, kein CI. Für ein einzelnes eigenes Cloudflare-Konto.
#
#   export CLOUDFLARE_API_TOKEN="..."
#   terraform init && terraform apply

terraform {
  required_version = ">= 1.7"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }
}

module "domains" {
  source = "../.."

  account_id = var.account_id

  sites = {
    beispiel = {
      workerName      = "beispiel"
      canonicalDomain = "beispiel.de"

      # redirectWWW ergänzt www.beispiel.de und www.beispiel-alt.de selbst.
      redirectDomains = ["beispiel-alt.de"]
      redirectWWW     = true
    }
  }
}

variable "account_id" {
  description = "Cloudflare Account-ID."
  type        = string
}

output "sites" {
  value = module.domains.sites
}
