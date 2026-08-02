variable "account_id" {
  description = <<-EOT
    Cloudflare Account-ID, in der Pages-Projekt und Zonen liegen.
    Dashboard -> rechte Spalte, oder `wrangler whoami`.

    In CI als `TF_VAR_account_id` aus dem Secret CLOUDFLARE_ACCOUNT_ID setzen,
    damit die Account-ID nicht im Config-Repo steht.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id ist ein 32-stelliger Hex-String."
  }
}

variable "sites_dir" {
  description = <<-EOT
    Pfad zu einem Verzeichnis mit Site-Dateien (`<slug>.json`) aus dem
    zentralen Config-Repo. Gelesen wird ausschließlich der `domains`-Block
    jeder Datei; alle anderen Capability-Blöcke (z. B. `contactForms`) werden
    ignoriert – sie gehören anderen Engines.

    Ein optionales `_defaults.json` im selben Verzeichnis wird flach unter
    jede Site gemischt (Site gewinnt).

    Kann mit `sites` kombiniert werden; bei gleichem Slug gewinnt `sites_dir`.
  EOT
  type        = string
  default     = null
}

variable "placeholder_ipv6" {
  description = <<-EOT
    Platzhalter-Ziel für Redirect-Domains. Default `100::` stammt aus dem
    IPv6-Discard-Prefix (RFC 6666) und routet nirgendwohin – der Record ist
    ausschließlich dazu da, den Request an Cloudflares Edge zu bringen, wo die
    Redirect Rule greift, bevor irgendein Origin kontaktiert wird.
  EOT
  type        = string
  default     = "100::"
}

variable "sites" {
  description = <<-EOT
    Sites direkt als Map – für Self-Serve-Nutzung ohne Config-Repo.
    Gleiche Feldnamen wie der `domains`-Block einer Site-Datei.
  EOT

  type = map(object({
    pagesProject        = string
    canonicalDomain     = string
    redirectDomains     = optional(list(string), [])
    redirectStatusCode  = optional(number, 301)
    preserveQueryString = optional(bool, true)
    alwaysUseHttps      = optional(bool, true)
  }))

  default = {}
}
