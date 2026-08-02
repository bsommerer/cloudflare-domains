terraform {
  required_version = ">= 1.7"
}

# Bewusst ohne `required_providers`: dieses Modul ist eine reine Funktion von
# Konfiguration + Zonenliste auf einen Ausführungsplan. Es spricht mit nichts
# und lässt sich deshalb in tests/ ohne Cloudflare-Zugriff und ohne Mocks
# vollständig prüfen.
