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
      version = "~> 5.22"
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

      redirectDomains = [
        "www.beispiel.de",
        "beispiel-alt.de",
        "www.beispiel-alt.de",
      ]
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
