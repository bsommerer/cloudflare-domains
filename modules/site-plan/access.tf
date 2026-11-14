#############################################
# protectPreviews: Preview-URLs hinter Cloudflare Access
#############################################

# Preview-URLs (`<version>-<worker>.<subdomain>.workers.dev` und
# `<alias>-<worker>.<subdomain>.workers.dev`) sind ohne Schutz öffentlich – auch
# dann, wenn `disableWorkersDev` den normalen workers.dev-Hostnamen abschaltet.
# Für Seiten mit persönlichen Daten soll dort nur durchkommen, wer sich per
# Cloudflare Access anmeldet.
#
# Cloudflare setzt das selbst über eine Access-Application mit einer
# Worker-Destination vom Typ `preview_worker` um – nicht über einen
# Wildcard-Hostnamen auf workers.dev. Dieser Teil plant nur, WELCHE Worker mit
# WELCHER Allowlist geschützt werden; die Ressourcen legt der Root an.

# Access-Destinations erwarten die unveränderliche Worker-ID, nicht den Namen.
# Der Root liest sie nur, wenn überhaupt ein Worker geschützt wird – daher hängt
# `preview_protection` bewusst NICHT an dieser Eingabe, sonst entstünde ein
# Zyklus (Lookup hängt am Plan, Plan am Lookup).
variable "worker_ids" {
  description = "Worker-Name -> unveränderliche Worker-ID (Workers-API). Nur für protectPreviews."
  type        = map(string)
  default     = {}
}

# Pro Site die aufgelöste Einstellung. `protectPreviews` ist ein Objekt und wird
# deshalb – anders als die übrigen Felder – feldweise mit `_defaults.json`
# gemischt: so kann die Allowlist einmal zentral stehen und eine Site schaltet
# nur noch `"enabled": true`. Ein flaches `merge()` würde das Default-Objekt
# komplett durch das der Site ersetzen.
locals {
  protect_previews_from_dir = {
    for slug, _ in local.selected : slug => try(merge(
      try(var.defaults.domains.protectPreviews, {}),
      try(var.raw_sites[slug].domains.protectPreviews, {}),
    ), null)
  }

  # Self-Serve-Sites kennen kein `_defaults.json`. Bei gleichem Slug gewinnt wie
  # überall das Config-Repo.
  protect_previews_from_var = {
    for slug, s in var.sites : slug => try(s.protectPreviews, null)
  }

  protect_previews_raw = merge(local.protect_previews_from_var, local.protect_previews_from_dir)

  # Normalisiert wie die Hostnamen in main.tf: E-Mail-Adressen und Domains sind
  # case-insensitiv, ein vorangestelltes "@" bei Domains ist ein häufiger
  # Tippfehler und wird toleriert. Fehlt `enabled`, ist der Schutz aus – wie
  # beim `domains`-Block selbst.
  protect_previews = {
    for slug, s in local.sites : slug => {
      enabled = try(local.protect_previews_raw[slug].enabled, false) == true

      # `try()` um den ganzen Ausdruck: fehlt das Objekt oder die Liste (oder ist
      # sie null), ergibt das eine leere Liste statt eines Auswertungsfehlers.
      allowedEmails = sort(distinct(try([
        for e in local.protect_previews_raw[slug].allowedEmails : lower(trimspace(e))
      ], [])))

      allowedEmailDomains = sort(distinct(try([
        for d in local.protect_previews_raw[slug].allowedEmailDomains : trimprefix(lower(trimspace(d)), "@")
      ], [])))
    }
  }

  # Eine Access-Application schützt die Previews eines WORKERS, nicht einer
  # Site. Bedient ein Worker mehrere Sites, entsteht trotzdem nur eine
  # Application; ihre Allowlist ist die Vereinigung aller Sites dieses Workers
  # mit aktivem Schutz. Sonst verwalteten zwei Sites dasselbe Cloudflare-Objekt.
  preview_protection = {
    for w in sort(distinct([
      for slug, p in local.protect_previews : local.sites[slug].workerName if p.enabled
      ])) : w => {
      sites = sort([
        for slug, p in local.protect_previews : slug
        if p.enabled && local.sites[slug].workerName == w
      ])
      allowedEmails = sort(distinct(flatten([
        for slug, p in local.protect_previews : p.allowedEmails
        if p.enabled && local.sites[slug].workerName == w
      ])))
      allowedEmailDomains = sort(distinct(flatten([
        for slug, p in local.protect_previews : p.allowedEmailDomains
        if p.enabled && local.sites[slug].workerName == w
      ])))
    }
  }

  # Was der Root je Worker anlegt: Destination-ID und die Include-Regeln der
  # Policy. Include-Regeln sind ODER-verknüpft – eine passende Adresse ODER
  # Domain genügt.
  preview_applications = {
    for w, p in local.preview_protection : w => {
      worker_id = lookup(var.worker_ids, w, "")
      include = concat(
        [for e in p.allowedEmails : { email = { email = e } }],
        [for d in p.allowedEmailDomains : { email_domain = { domain = d } }],
      )
    }
  }

  preview_findings = {
    # Schutz an, aber niemand zugelassen: Access lehnt eine Policy ohne
    # Include-Regel ab – und gewollt ist das so gut wie nie.
    preview_without_allowlist = sort([
      for slug, p in local.protect_previews : slug
      if p.enabled && length(p.allowedEmails) + length(p.allowedEmailDomains) == 0
    ])

    # Grobe Plausibilität; die genaue Prüfung macht das JSON-Schema. Hier geht es
    # darum, dass z. B. eine Domain im E-Mail-Feld nicht erst beim Apply auffällt.
    invalid_preview_emails = sort(distinct(flatten([
      for slug, p in local.protect_previews : [
        for e in p.allowedEmails : e if !can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))
      ]
    ])))

    invalid_preview_email_domains = sort(distinct(flatten([
      for slug, p in local.protect_previews : [
        for d in p.allowedEmailDomains : d if !can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", d))
      ]
    ])))
  }
}

output "protect_previews" {
  description = "Site -> aufgelöste protectPreviews-Einstellung (Defaults gemischt, normalisiert)."
  value       = local.protect_previews
}

output "preview_protection" {
  description = <<-EOT
    Worker -> geschützte Sites und vereinigte Allowlist. Je Eintrag entsteht im
    Root genau eine Access-Application mit `preview_worker`-Destination und eine
    wiederverwendbare Access-Policy.
  EOT
  value       = local.preview_protection
}

output "preview_applications" {
  description = <<-EOT
    Worker -> Worker-ID und Include-Regeln der Access-Policy. Leere
    `worker_id` heißt: der Worker fehlt im Listing der Workers-API.
  EOT
  value       = local.preview_applications
}

output "preview_findings" {
  description = "Konfigurationsprobleme von protectPreviews, die der Root als Precondition hart abbricht."
  value       = local.preview_findings
}
