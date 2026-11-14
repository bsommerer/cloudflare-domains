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

variable "existing_custom_domains" {
  description = <<-EOT
    Bereits im Account vorhandene Workers Custom Domains als
    Hostname -> unveränderliche Domain-ID. Grundlage für die Bestandsübernahme:
    Wer eine Domain vor der Engine von Hand verknüpft hat, soll sie per
    `import` übernehmen können, statt am "existiert bereits" zu scheitern.
  EOT
  type        = map(string)
  default     = {}
}

variable "existing_rulesets" {
  description = <<-EOT
    Bereits vorhandene Rulesets je Zone als Zonenname -> Liste von
    { id, kind, phase }. Grundlage für die Übernahme eines Redirect-Rulesets,
    das schon vor der Engine existierte: Cloudflare erlaubt pro Zone und Phase
    nur ein Entry-Point-Ruleset, ein zweites Anlegen scheitert.
  EOT
  type = map(list(object({
    id    = string
    kind  = string
    phase = string
  })))
  default = {}
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
