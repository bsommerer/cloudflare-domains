terraform {
  # >= 1.7 wegen `mock_provider` in tests/ – die Zonen-Zuordnung und die
  # Ruleset-Gruppierung werden ohne Cloudflare-Zugriff getestet.
  required_version = ">= 1.7"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }
}
