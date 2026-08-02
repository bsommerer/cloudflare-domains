terraform {
  required_version = ">= 1.7"

  # Dieses Modul erzeugt KEINE Provider-Ressourcen – es ist eine reine Funktion
  # von Konfiguration plus Zonen-/Worker-Liste auf einen Ausführungsplan, und
  # genau deshalb in tests/ ohne Cloudflare-Zugriff vollständig prüfbar.
  #
  # Der Eintrag steht hier trotzdem, damit `terraform test` den Namen
  # "cloudflare" in allen Testdateien auf dieselbe Provider-Quelle auflöst –
  # ohne ihn kollidiert der mock_provider aus tests/root_wiring.tftest.hcl mit
  # der Default-Auflösung auf hashicorp/cloudflare.
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }
}
