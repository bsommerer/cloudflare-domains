variable "zones" {
  description = "Zonen des Accounts als Name -> Zonen-ID."
  type        = map(string)
}

variable "workers" {
  description = <<-EOT
    Namen aller Worker-Scripts im Account. Dient nur dazu, einen Tippfehler in
    `workerName` schon im Plan zu melden statt erst beim Apply.
  EOT
  type        = list(string)
  default     = []
}

variable "raw_sites" {
  description = <<-EOT
    Die dekodierten Site-Dateien aus dem Config-Repo, als Slug -> Inhalt.
    Enthält typischerweise Blöcke mehrerer Engines; gelesen wird nur `domains`.
  EOT
  type        = any
  default     = {}
}

variable "defaults" {
  description = "Dekodiertes `_defaults.json`, wird flach unter jeden `domains`-Block gemischt."
  type        = any
  default     = {}
}

variable "sites" {
  description = "Direkt übergebene Sites (Self-Serve). Gewinnen nicht gegen `raw_sites`."
  type        = any
  default     = {}
}
