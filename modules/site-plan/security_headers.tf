#############################################
# Basis-Security-Header (Response Header Transform Rules)
#############################################

# Heute kopiert jedes Website-Repo dieselben Header in seine `_headers`. Hier
# werden sie stattdessen zentral je Zone als Response-Header-Transform-Rule
# geplant. Wie überall in diesem Modul: reine Funktion, kein Provider-Zugriff.
#
# `securityHeaders` ist `true`/`false` oder ein Objekt zum Feinsteuern. Ein
# Objekt ohne `enabled` gilt als eingeschaltet. Einzelne Header lassen sich mit
# `false` abschalten (`hsts`, `referrerPolicy`, `permissionsPolicy`,
# `frameOptions`) bzw. `contentTypeOptions = false`.
#
# Hinweis zu `_defaults.json`: Das Zusammenmischen dort ist flach. Setzt eine
# Site ein eigenes `securityHeaders`-Objekt, ersetzt es das aus den Defaults
# komplett – nicht genannte Felder fallen auf die Engine-Defaults zurück, nicht
# auf die der Defaults-Datei.
locals {
  sec_names = {
    hsts = "Strict-Transport-Security"
    ref  = "Referrer-Policy"
    perm = "Permissions-Policy"
    cto  = "X-Content-Type-Options"
    xfo  = "X-Frame-Options"
  }

  sec_raw = { for slug, s in local.sites : slug => try(s.securityHeaders, false) }

  # Schritt 1: Eingabe (bool oder Objekt) auf eine einheitliche Form bringen.
  # `can(keys(x))` unterscheidet Objekt von bool; `false` bedeutet bei den
  # Textfeldern „Header nicht setzen“ und wird zu einem leeren String.
  sec_cfg = {
    for slug, raw in local.sec_raw : slug => {
      enabled = can(keys(raw)) ? try(raw.enabled, true) == true : raw == true

      hsts_on = (can(keys(try(raw.hsts, {}))) ? try(raw.hsts.enabled, true) == true
      : try(raw.hsts, true) != false)
      hsts_max_age = try(raw.hsts.maxAge, 31536000)
      hsts_sub     = try(raw.hsts.includeSubDomains, false) == true
      hsts_preload = try(raw.hsts.preload, false) == true

      referrer = try(raw.referrerPolicy, null) == null ? "strict-origin-when-cross-origin" : (
      raw.referrerPolicy == false ? "" : tostring(raw.referrerPolicy))
      permissions = try(raw.permissionsPolicy, null) == null ? "geolocation=(), camera=(), microphone=(), interest-cohort=()" : (
      raw.permissionsPolicy == false ? "" : tostring(raw.permissionsPolicy))
      frame = try(raw.frameOptions, null) == null ? "SAMEORIGIN" : (
      raw.frameOptions == false ? "" : tostring(raw.frameOptions))
      nosniff = try(raw.contentTypeOptions, true) == true

      # false (Standard): Header, die die Seite selbst setzt (z. B. per
      # `_headers`), haben Vorrang. true: die Engine überschreibt sie.
      override = try(raw.overrideExisting, false) == true
    } if can(keys(raw)) || raw == true
  }

  # Schritt 2: fertige Header-Werte. Leere Werte (abgeschaltet) fallen raus.
  sec_headers = {
    for slug, c in local.sec_cfg : slug => {
      for k, v in {
        (local.sec_names.hsts) = c.hsts_on ? join("; ", concat(
          ["max-age=${c.hsts_max_age}"],
          c.hsts_sub ? ["includeSubDomains"] : [],
          c.hsts_preload ? ["preload"] : [],
        )) : ""
        (local.sec_names.ref)  = c.referrer
        (local.sec_names.perm) = c.permissions
        (local.sec_names.cto)  = c.nosniff ? "nosniff" : ""
        (local.sec_names.xfo)  = c.frame
      } : k => v if v != ""
    } if c.enabled
  }

  # Schritt 3: Regeln je Site und Zone.
  #
  # Welche Hosts bekommen welche Header?
  # - Kanonische Domain: alle Header.
  # - Redirect-Domains: nur HSTS. Sie antworten mit einer 301 ohne Inhalt, da
  #   sind nosniff, Frame- oder Permissions-Header wirkungslos. HSTS dagegen
  #   schon: Der Browser merkt sich, dass diese Domain nur noch per HTTPS
  #   angesprochen wird, und überspringt künftig den ungesicherten ersten Hop.
  #   Das ist auch Voraussetzung für die HSTS-Preload-Liste, die den Header auf
  #   der Weiterleitungsantwort der Apex-Domain verlangt.
  #
  # Verhalten gegenüber Headern der Seite (`_headers`): eine Transform Rule mit
  # `set` ersetzt einen schon vorhandenen Header. Standard ist deshalb, dass
  # die Engine nur setzt, wenn die Antwort den Header noch nicht hat – dafür
  # eine eigene Regel je Header mit der Bedingung
  # `not any(http.response.headers.names[*] == "<name>")` (Feldnamen sind
  # kleingeschrieben). Mit `overrideExisting = true` entfällt der Vorrang der
  # Seite, und alle Header einer Site landen in EINER Regel – das spart Regeln
  # im Kontingent der Zone.
  sec_site_zones = {
    for slug, h in local.sec_headers : slug => sort(distinct([
      for d in concat([local.sites[slug].canonicalDomain], local.sites[slug].redirectDomains) :
      local.zone_name_for[d] if local.zone_name_for[d] != ""
    ]))
  }

  sec_rules_flat = flatten([
    for slug in sort(keys(local.sec_headers)) : [
      for zn in local.sec_site_zones[slug] : concat(
        # Überschreib-Modus: eine Regel für die kanonische Domain ...
        local.sec_cfg[slug].override && local.zone_name_for[local.sites[slug].canonicalDomain] == zn ? [{
          slug    = slug
          zone    = zn
          hosts   = [local.sites[slug].canonicalDomain]
          headers = local.sec_headers[slug]
          guard   = ""
        }] : [],
        # ... und eine nur mit HSTS für die Redirect-Domains der Zone.
        local.sec_cfg[slug].override && contains(keys(local.sec_headers[slug]), local.sec_names.hsts)
        && length([for d in local.sites[slug].redirectDomains : d if local.zone_name_for[d] == zn]) > 0 ? [{
          slug  = slug
          zone  = zn
          hosts = sort([for d in local.sites[slug].redirectDomains : d if local.zone_name_for[d] == zn])
          headers = {
            (local.sec_names.hsts) = local.sec_headers[slug][local.sec_names.hsts]
          }
          guard = ""
        }] : [],
        # Standard: je Header eine Regel, die nur greift, wenn er fehlt.
        local.sec_cfg[slug].override ? [] : [
          for name in sort(keys(local.sec_headers[slug])) : {
            slug = slug
            zone = zn
            hosts = concat(
              local.zone_name_for[local.sites[slug].canonicalDomain] == zn ? [local.sites[slug].canonicalDomain] : [],
              name == local.sec_names.hsts ? sort([for d in local.sites[slug].redirectDomains : d if local.zone_name_for[d] == zn]) : [],
            )
            headers = { (name) = local.sec_headers[slug][name] }
            guard   = lower(name)
          }
        ],
      )
    ]
  ])

  # Regeln ohne Host (Zone enthält nur Redirect-Domains, Header ist nicht HSTS)
  # entfallen.
  sec_rules = [for r in local.sec_rules_flat : r if length(r.hosts) > 0]

  security_rules_by_zone = {
    for zn in sort(distinct([for r in local.sec_rules : r.zone])) : zn => [
      for r in local.sec_rules : {
        slug        = r.slug
        hosts       = r.hosts
        headers     = r.headers
        guard       = r.guard
        description = "${join(", ", sort(keys(r.headers)))} (${r.slug}): ${join(", ", r.hosts)}"
        expression = r.guard == "" ? format("http.host in {%s}", join(" ", [for d in r.hosts : "\"${d}\""])) : format(
          "(%s) and not any(http.response.headers.names[*] == \"%s\")",
          format("http.host in {%s}", join(" ", [for d in r.hosts : "\"${d}\""])), r.guard
        )
      } if r.zone == zn
    ]
  }


  # Zonen, in denen schon ein Ruleset der Header-Phase liegen könnte. Dient dem
  # Root als Lookup-Liste – gemeinsam mit den Redirect-Zonen, damit auch Zonen
  # ohne Weiterleitungen übernommen werden.
  ruleset_lookup_zones = sort(distinct(concat(
    keys(local.rules_by_zone),
    keys(local.security_rules_by_zone),
  )))

  # Wie bei den Redirects: nur Zonen, in denen die Engine Header setzt; ein
  # fremdes Ruleset anderer Zonen bleibt unangetastet.
  security_ruleset_candidates = {
    for zn, _ in local.security_rules_by_zone : zn => [
      for r in lookup(var.existing_rulesets, zn, []) : r.id
      if r.kind == "zone" && r.phase == "http_response_headers_transform"
    ]
  }

  security_ruleset_adoptions = {
    for zn, ids in local.security_ruleset_candidates : zn => ids[0] if length(ids) > 0
  }

  # Befunde für die Precondition im Root. HSTS-Preload verlangt laut
  # hstspreload.org mindestens ein Jahr und includeSubDomains; ein Header, der
  # das verfehlt, würde von der Liste abgelehnt – besser vorab melden.
  security_findings = {
    invalid_hsts = sort([
      for slug, c in local.sec_cfg : slug
      if c.enabled && c.hsts_on && (
        !can(tonumber(c.hsts_max_age)) || (
          can(tonumber(c.hsts_max_age)) && (
            tonumber(c.hsts_max_age) < 0
            || (c.hsts_preload && (tonumber(c.hsts_max_age) < 31536000 || !c.hsts_sub))
          )
        )
      )
    ])
  }
}
