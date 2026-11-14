# Basis-Security-Header: welche Zonen, Hosts und Header geplant werden, wie sich
# Vorrang der Seite (`_headers`) und Überschreib-Modus unterscheiden und wann ein
# bestehendes Ruleset übernommen wird. Der Planer ist eine reine Funktion – der
# `import`-Block und die Ressource selbst liegen im Root (siehe unten).

# Nur der letzte Lauf (Root) braucht den Provider; alle Data Sources liefern
# dort ohne Override eine leere Liste.
mock_provider "cloudflare" {}

variables {
  zones = {
    "kunde.de"  = "id-kunde-de"
    "kunde.com" = "id-kunde-com"
    "anders.de" = "id-anders-de"
  }

  workers = ["kunde", "anders"]
}

run "disabled_by_default" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = { workerName = "kunde", canonicalDomain = "kunde.de" }
    }
  }

  assert {
    condition     = length(output.security_rules_by_zone) == 0 && length(output.security_headers) == 0
    error_message = "Ohne securityHeaders darf nichts geplant werden."
  }
}

run "explicit_false_is_off" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = { workerName = "kunde", canonicalDomain = "kunde.de", securityHeaders = false }
    }
  }

  assert {
    condition     = length(output.security_rules_by_zone) == 0
    error_message = "securityHeaders = false schaltet ab."
  }
}

run "true_uses_conservative_defaults" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = { workerName = "kunde", canonicalDomain = "kunde.de", securityHeaders = true }
    }
  }

  assert {
    condition = output.security_headers["kunde"] == {
      "Strict-Transport-Security" = "max-age=31536000"
      "Referrer-Policy"           = "strict-origin-when-cross-origin"
      "Permissions-Policy"        = "geolocation=(), camera=(), microphone=(), interest-cohort=()"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "SAMEORIGIN"
    }
    error_message = "Defaults: HSTS ohne includeSubDomains/preload, restliche Header wie vorgegeben."
  }

  # Standard: Vorrang der Seite -> eine Regel je Header mit Guard.
  assert {
    condition     = length(output.security_rules_by_zone["kunde.de"]) == 5
    error_message = "Im Standard entsteht eine Regel je Header."
  }

  assert {
    condition = alltrue([
      for r in output.security_rules_by_zone["kunde.de"] :
      r.guard != "" && strcontains(r.expression, "not any(http.response.headers.names[*] == \"${r.guard}\")")
    ])
    error_message = "Jede Regel setzt nur, wenn die Antwort den Header noch nicht hat."
  }
}

run "expression_is_exact" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        securityHeaders = { contentTypeOptions = true, hsts = false, referrerPolicy = false, permissionsPolicy = false, frameOptions = false }
      }
    }
  }

  assert {
    condition = [for r in output.security_rules_by_zone["kunde.de"] : r.expression] == [
      "(http.host in {\"kunde.de\"}) and not any(http.response.headers.names[*] == \"x-content-type-options\")"
    ]
    error_message = "Expression: Host-Menge plus Guard mit kleingeschriebenem Header-Namen."
  }
}

run "object_overrides" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        securityHeaders = {
          enabled            = true
          hsts               = { maxAge = 63072000, includeSubDomains = true, preload = true }
          referrerPolicy     = "no-referrer"
          permissionsPolicy  = "camera=()"
          contentTypeOptions = false
          frameOptions       = "DENY"
        }
      }
    }
  }

  assert {
    condition = output.security_headers["kunde"] == {
      "Strict-Transport-Security" = "max-age=63072000; includeSubDomains; preload"
      "Referrer-Policy"           = "no-referrer"
      "Permissions-Policy"        = "camera=()"
      "X-Frame-Options"           = "DENY"
    }
    error_message = "Overrides müssen die Defaults ersetzen; contentTypeOptions = false entfällt."
  }

  assert {
    condition     = length(output.security_findings.invalid_hsts) == 0
    error_message = "Preload mit einem Jahr+ und includeSubDomains ist gültig."
  }
}

run "object_with_enabled_false_is_off" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = { workerName = "kunde", canonicalDomain = "kunde.de", securityHeaders = { enabled = false } }
    }
  }

  assert {
    condition     = length(output.security_rules_by_zone) == 0
    error_message = "enabled = false im Objekt schaltet ab."
  }
}

run "preload_without_subdomains_is_a_finding" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        securityHeaders = { hsts = { preload = true } }
      }
    }
  }

  assert {
    condition     = jsonencode(output.security_findings.invalid_hsts) == jsonencode(["kunde"])
    error_message = "Preload ohne includeSubDomains muss gemeldet werden."
  }
}

run "override_existing_uses_one_rule" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        securityHeaders = { overrideExisting = true }
      }
    }
  }

  assert {
    condition     = length(output.security_rules_by_zone["kunde.de"]) == 1
    error_message = "Mit overrideExisting bündelt eine Regel alle Header."
  }

  assert {
    condition     = output.security_rules_by_zone["kunde.de"][0].expression == "http.host in {\"kunde.de\"}" && output.security_rules_by_zone["kunde.de"][0].guard == ""
    error_message = "Ohne Guard, nur die Host-Bedingung."
  }

  assert {
    condition     = length(output.security_rules_by_zone["kunde.de"][0].headers) == 5
    error_message = "Alle fünf Header in der Regel."
  }
}

run "redirect_domains_only_get_hsts" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectDomains = ["kunde.com"]
        securityHeaders = true
      }
    }
  }

  # Zone kunde.de: Standardmodus, 5 Regeln, HSTS gilt nur für kunde.de.
  assert {
    condition     = length(output.security_rules_by_zone["kunde.de"]) == 5
    error_message = "Kanonische Zone: eine Regel je Header."
  }

  # Zone kunde.com enthält nur die Redirect-Domain -> nur die HSTS-Regel.
  assert {
    condition     = jsonencode([for r in output.security_rules_by_zone["kunde.com"] : keys(r.headers)]) == jsonencode([["Strict-Transport-Security"]])
    error_message = "Redirect-Domains bekommen ausschließlich HSTS."
  }

  assert {
    condition     = jsonencode(output.security_rules_by_zone["kunde.com"][0].hosts) == jsonencode(["kunde.com"])
    error_message = "Host der Regel ist die Redirect-Domain."
  }
}

run "redirect_domain_in_same_zone_shares_hsts_rule" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectWWW     = true
        securityHeaders = true
      }
    }
  }

  assert {
    condition = jsonencode([
      for r in output.security_rules_by_zone["kunde.de"] : r.hosts if r.guard == "strict-transport-security"
    ]) == jsonencode([["kunde.de", "www.kunde.de"]])
    error_message = "HSTS gilt auch für www-Weiterleitung, alle anderen Header nur für die kanonische Domain."
  }

  assert {
    condition = alltrue([
      for r in output.security_rules_by_zone["kunde.de"] : jsonencode(r.hosts) == jsonencode(["kunde.de"]) if r.guard != "strict-transport-security"
    ])
    error_message = "Andere Header nur auf der kanonischen Domain."
  }
}

run "override_mode_splits_canonical_and_redirects" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectWWW     = true
        securityHeaders = { overrideExisting = true }
      }
    }
  }

  assert {
    condition     = length(output.security_rules_by_zone["kunde.de"]) == 2
    error_message = "Eine Regel für die kanonische Domain, eine nur mit HSTS für die Weiterleitung."
  }

  assert {
    condition     = jsonencode(keys(output.security_rules_by_zone["kunde.de"][1].headers)) == jsonencode(["Strict-Transport-Security"])
    error_message = "Die Weiterleitungs-Regel setzt nur HSTS."
  }
}

run "several_sites_share_one_zone" {
  module { source = "./modules/site-plan" }

  variables {
    zones = { "kunde.de" = "id-kunde-de" }

    sites = {
      shop = {
        workerName      = "kunde"
        canonicalDomain = "shop.kunde.de"
        securityHeaders = { overrideExisting = true }
      }
      blog = {
        workerName      = "kunde"
        canonicalDomain = "blog.kunde.de"
        securityHeaders = { overrideExisting = true, frameOptions = "DENY" }
      }
      still = {
        workerName      = "kunde"
        canonicalDomain = "still.kunde.de"
      }
    }
  }

  assert {
    condition     = keys(output.security_rules_by_zone) == ["kunde.de"]
    error_message = "Ein Ruleset je Zone."
  }

  assert {
    condition     = [for r in output.security_rules_by_zone["kunde.de"] : r.slug] == ["blog", "shop"]
    error_message = "Je Site mit aktiven Headern eine Regel, nach Slug sortiert; Site ohne Header fehlt."
  }

  assert {
    condition     = output.security_rules_by_zone["kunde.de"][0].headers["X-Frame-Options"] == "DENY" && output.security_rules_by_zone["kunde.de"][1].headers["X-Frame-Options"] == "SAMEORIGIN"
    error_message = "Jede Site behält ihre eigenen Werte."
  }
}

run "sites_in_different_zones" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "kunde", canonicalDomain = "kunde.de", securityHeaders = { overrideExisting = true } }
      b = { workerName = "anders", canonicalDomain = "anders.de", securityHeaders = { overrideExisting = true } }
    }
  }

  assert {
    condition     = keys(output.security_rules_by_zone) == ["anders.de", "kunde.de"]
    error_message = "Je Zone ein Eintrag."
  }
}

run "lookup_zones_cover_header_only_zones" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      # Keine Redirects -> rules_by_zone ist leer, die Zone muss trotzdem
      # nachgeschlagen werden.
      a = { workerName = "kunde", canonicalDomain = "anders.de", securityHeaders = true }
      b = { workerName = "kunde", canonicalDomain = "kunde.de", redirectDomains = ["kunde.com"] }
    }
  }

  assert {
    condition     = jsonencode(output.ruleset_lookup_zones) == jsonencode(["anders.de", "kunde.com"])
    error_message = "Lookup = Zonen mit Redirects plus Zonen mit Headern, dedupliziert."
  }
}

run "existing_header_ruleset_is_adopted" {
  module { source = "./modules/site-plan" }

  variables {
    existing_rulesets = {
      "kunde.de" = [
        { id = "rs-redirect", kind = "zone", phase = "http_request_dynamic_redirect" },
        { id = "rs-headers", kind = "zone", phase = "http_response_headers_transform" },
      ]
    }

    sites = {
      kunde = { workerName = "kunde", canonicalDomain = "kunde.de", securityHeaders = true }
    }
  }

  assert {
    condition     = output.security_ruleset_adoptions == { "kunde.de" = "rs-headers" }
    error_message = "Nur das Ruleset der Header-Phase wird übernommen."
  }

  # Das Redirect-Muster bleibt davon unberührt.
  assert {
    condition     = length(output.ruleset_adoptions) == 0
    error_message = "Redirect-Übernahme darf nicht durch Header-Rulesets ausgelöst werden."
  }
}

run "foreign_kind_or_unrelated_zone_not_adopted" {
  module { source = "./modules/site-plan" }

  variables {
    existing_rulesets = {
      "kunde.de"  = [{ id = "rs-managed", kind = "managed", phase = "http_response_headers_transform" }]
      "anders.de" = [{ id = "rs-fremd", kind = "zone", phase = "http_response_headers_transform" }]
    }

    sites = {
      kunde = { workerName = "kunde", canonicalDomain = "kunde.de", securityHeaders = true }
    }
  }

  assert {
    condition     = length(output.security_ruleset_adoptions) == 0
    error_message = "Managed Rulesets und Zonen ohne Engine-Regeln werden nicht übernommen."
  }
}

# Root: Ressource für eine Zone, die nur Header hat. Der Planer ist
# oben schon geprüft; hier wird sein Ergebnis überschrieben, damit der Test ohne
# nachgebaute Provider-Datenstrukturen auskommt.
run "root_plans_header_ruleset_and_adopts_existing" {
  command = plan

  variables {
    account_id = "0123456789abcdef0123456789abcdef"
  }

  override_module {
    target = module.plan
    outputs = {
      sites                   = { kunde = { canonicalDomain = "kunde.de", workerName = "kunde", redirectDomains = [] } }
      zone_id_for             = { "kunde.de" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      zone_name_for           = { "kunde.de" = "kunde.de" }
      zone_ids_by_name        = { "kunde.de" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      redirect_records        = {}
      rules_by_zone           = {}
      https_zones             = []
      managed_zones           = ["kunde.de"]
      workers_dev_disabled    = []
      custom_domain_adoptions = {}
      ruleset_adoptions       = {}
      ruleset_lookup_zones    = ["kunde.de"]
      security_headers        = { kunde = { "X-Content-Type-Options" = "nosniff" } }
      # Die Übernahme ist oben geprüft; Mock-Provider erlauben keinen import.
      security_ruleset_adoptions = {}
      security_findings          = { invalid_hsts = [] }
      security_rules_by_zone = {
        "kunde.de" = [{
          slug        = "kunde"
          hosts       = ["kunde.de"]
          headers     = { "X-Content-Type-Options" = "nosniff" }
          guard       = "x-content-type-options"
          description = "X-Content-Type-Options (kunde): kunde.de"
          expression  = "(http.host in {\"kunde.de\"}) and not any(http.response.headers.names[*] == \"x-content-type-options\")"
        }]
      }
      findings = {
        unmatched_domains      = []
        duplicate_canonicals   = []
        duplicate_redirects    = []
        canonical_and_redirect = []
        self_redirecting       = []
        unknown_workers        = []
        invalid_status         = []
      }
    }
  }

  # Den Worker kennt der gemockte Account nicht; das ist hier nicht Thema.
  assert {
    condition     = cloudflare_ruleset.security_headers["kunde.de"].phase == "http_response_headers_transform"
    error_message = "Das Header-Ruleset muss für die Zone geplant werden."
  }

  assert {
    condition     = cloudflare_ruleset.security_headers["kunde.de"].rules[0].action == "rewrite" && cloudflare_ruleset.security_headers["kunde.de"].rules[0].action_parameters.headers["X-Content-Type-Options"].operation == "set"
    error_message = "Aktion rewrite mit operation set."
  }
}
