#############################################
# 1. Capability-Block extrahieren und normalisieren
#############################################

# Der Vertrag mit dem Config-Repo: eine Site-Datei kann Blöcke für beliebige
# Engines enthalten. Diese Engine liest `domains` und ignoriert alles andere –
# deshalb bricht eine neue Engine keine bestehende. `enabled` auf Site- wie auf
# Blockebene entscheidet, ob wir überhaupt zuständig sind.
locals {
  selected = {
    for slug, site in var.raw_sites :
    slug => merge(try(var.defaults.domains, {}), site.domains)
    if try(site.enabled, true) && try(site.domains.enabled, false)
  }

  # Beide Quellen werden auf exakt dieselbe Form gebracht, damit alles Weitere
  # nur eine Struktur kennt. Hostnamen werden kleingeschrieben – DNS ist
  # case-insensitiv, das Zonen-Matching per `endswith()` wäre es nicht.
  from_dir = {
    for slug, s in local.selected : slug => {
      workerName          = s.workerName
      disableWorkersDev   = try(s.disableWorkersDev, null)
      canonicalDomain     = lower(s.canonicalDomain)
      redirectDomains     = [for d in try(s.redirectDomains, []) : lower(d)]
      redirectStatusCode  = try(s.redirectStatusCode, 301)
      preserveQueryString = try(s.preserveQueryString, true)
      alwaysUseHttps      = try(s.alwaysUseHttps, true)
    }
  }

  from_var = {
    for slug, s in var.sites : slug => {
      workerName          = s.workerName
      disableWorkersDev   = try(s.disableWorkersDev, null)
      canonicalDomain     = lower(s.canonicalDomain)
      redirectDomains     = [for d in try(s.redirectDomains, []) : lower(d)]
      redirectStatusCode  = try(s.redirectStatusCode, 301)
      preserveQueryString = try(s.preserveQueryString, true)
      alwaysUseHttps      = try(s.alwaysUseHttps, true)
    }
  }

  sites = merge(local.from_var, local.from_dir)

  all_domains = distinct(flatten([
    for slug, s in local.sites : concat([s.canonicalDomain], s.redirectDomains)
  ]))
}

#############################################
# 2. Zonen-Zuordnung
#############################################

locals {
  zone_ids_by_name = { for name, id in var.zones : lower(name) => id }

  # Jeder Hostname gehört in die *spezifischste* Zone, auf die er passt:
  # "www.example.co.uk" -> Zone "example.co.uk", und existiert zusätzlich eine
  # Zone "www.example.co.uk", gewinnt diese.
  #
  # Der führende Punkt in ".${zn}" verhindert Falsch-Treffer wie
  # "www.example.com" -> Zone "ample.com".
  #
  # Der nullgepolsterte Längen-Präfix ("012|example.com") sorgt dafür, dass die
  # lexikografische Sortierung exakt der Sortierung nach Länge entspricht –
  # HCL hat kein sort_by().
  zone_matches = {
    for d in local.all_domains : d => reverse(sort([
      for zn in keys(local.zone_ids_by_name) :
      format("%03d|%s", length(zn), zn)
      if d == zn || endswith(d, ".${zn}")
    ]))
  }

  zone_name_for = {
    for d, matches in local.zone_matches :
    d => length(matches) > 0 ? split("|", matches[0])[1] : ""
  }

  # `try()` statt direkter Indizierung: eine nicht zugeordnete Domain soll die
  # Precondition im Root auslösen und nicht vorher schon einen nichtssagenden
  # "Invalid index"-Fehler beim Auswerten der Ressourcen.
  zone_id_for = {
    for d, zn in local.zone_name_for : d => try(local.zone_ids_by_name[zn], "")
  }
}

#############################################
# 3. Aggregation über ALLE Sites hinweg
#############################################

# Cloudflare erlaubt pro Zone und Phase genau ein Entry-Point-Ruleset ("Each
# phase has at most one entry point ruleset at the account level and at the
# zone level"). Zonen-bezogene Ressourcen dürfen deshalb NICHT pro Site
# entstehen, sondern müssen über alle Sites hinweg aggregiert werden – sonst
# kollidieren zwei Sites, die sich eine Zone teilen.
locals {
  # `...` gruppiert statt zu kollidieren: eine doppelt beanspruchte Domain
  # soll die Validierung auslösen, nicht einen "duplicate key"-Fehler.
  redirect_claims = {
    for item in flatten([
      for slug, s in local.sites : [
        for d in s.redirectDomains : { domain = d, slug = slug }
      ]
    ]) : item.domain => item.slug...
  }

  redirect_records = {
    for d, slugs in local.redirect_claims :
    d => {
      slug        = slugs[0]
      target      = local.sites[slugs[0]].canonicalDomain
      status_code = local.sites[slugs[0]].redirectStatusCode
      zone_id     = local.zone_id_for[d]
    }
  }

  # Zone -> je Site eine Regel. Zwei Sites in derselben Zone ergeben zwei
  # Regeln in EINEM Ruleset, nicht zwei Rulesets.
  rules_by_zone = {
    for zn in sort(distinct([
      for d, r in local.redirect_records :
      local.zone_name_for[d] if local.zone_name_for[d] != ""
      ])) : zn => [
      for slug in sort(distinct([
        for d, r in local.redirect_records : r.slug if local.zone_name_for[d] == zn
        ])) : {
        slug     = slug
        target   = local.sites[slug].canonicalDomain
        status   = local.sites[slug].redirectStatusCode
        preserve = local.sites[slug].preserveQueryString
        domains = sort([
          for d, r in local.redirect_records :
          d if local.zone_name_for[d] == zn && r.slug == slug
        ])
      }
    ]
  }

  # `always_use_https` ist ebenfalls zonen-, nicht site-bezogen: global
  # dedupliziert, sonst verwalten zwei Sites dasselbe Cloudflare-Objekt.
  https_zones = sort(distinct([
    for zn in flatten([
      for slug, s in local.sites : [
        for d in concat([s.canonicalDomain], s.redirectDomains) :
        local.zone_name_for[d]
      ] if s.alwaysUseHttps
    ]) : zn if zn != ""
  ]))

  managed_zones = sort(distinct([
    for d, zn in local.zone_name_for : zn if zn != ""
  ]))

  # Ein Worker kann mehrere Sites bedienen; die workers.dev-Abschaltung gilt
  # aber dem Worker, nicht der Site – deshalb hier dedupliziert.
  workers_dev_disabled = sort(distinct([
    for slug, s in local.sites : s.workerName if s.disableWorkersDev == true
  ]))
}

#############################################
# 4. Befunde für die Guards im Root
#############################################

locals {
  canonical_claims = {
    for item in [
      for slug, s in local.sites : { domain = s.canonicalDomain, slug = slug }
    ] : item.domain => item.slug...
  }

  findings = {
    # Domain gehört zu keiner Zone im Account.
    unmatched_domains = sort([for d, zn in local.zone_name_for : d if zn == ""])

    # Eine Domain darf nur einer Site gehören.
    duplicate_canonicals = sort([
      for d, slugs in local.canonical_claims : d if length(slugs) > 1
    ])
    duplicate_redirects = sort([
      for d, slugs in local.redirect_claims : d if length(slugs) > 1
    ])

    # Kanonisch in Site A, umgeleitet in Site B: bekäme sowohl eine Workers
    # Custom Domain als auch einen Platzhalter-AAAA auf demselben Hostnamen.
    canonical_and_redirect = sort([
      for d in keys(local.canonical_claims) :
      d if contains(keys(local.redirect_claims), d)
    ])

    # Site leitet ihre eigene kanonische Domain um -> Schleife.
    self_redirecting = sort([
      for slug, s in local.sites :
      slug if contains(s.redirectDomains, s.canonicalDomain)
    ])

    # workerName zeigt auf kein Script im Account.
    unknown_workers = sort(distinct([
      for slug, s in local.sites :
      s.workerName if !contains(var.workers, s.workerName)
    ]))

    invalid_status = sort([
      for slug, s in local.sites :
      slug if !contains([301, 302, 307, 308], s.redirectStatusCode)
    ])
  }
}
