# Zonen-Zuordnung und Aggregation. Zielt direkt auf das Planer-Modul – reine
# Funktion, kein Provider, kein Cloudflare-Zugriff.

variables {
  # Enthält bewusst Fallen: sub.example.com ist spezifischer als example.com,
  # und ample.com ist ein echtes Suffix von "www.example.com" – aber kein
  # gültiger Zonen-Treffer dafür.
  zones = {
    "example.com"     = "id-example-com"
    "example.co.uk"   = "id-example-couk"
    "sub.example.com" = "id-sub-example-com"
    "ample.com"       = "id-ample-com"
    "shared.example"  = "id-shared-example"
    "other.de"        = "id-other-de"
  }

  sites = {
    alpha = {
      pagesProject    = "web-alpha"
      canonicalDomain = "example.co.uk"
      redirectDomains = ["www.example.co.uk"]
    }
    beta = {
      pagesProject    = "web-beta"
      canonicalDomain = "example.com"
      redirectDomains = ["www.example.com", "deep.sub.example.com"]
    }
    gamma = {
      pagesProject    = "web-gamma"
      canonicalDomain = "other.de"
      redirectDomains = ["www.other.de", "legacy.shared.example"]
    }
    delta = {
      pagesProject       = "web-delta"
      canonicalDomain    = "ample.com"
      redirectDomains    = ["OLD.Shared.Example"]
      redirectStatusCode = 308
    }
  }
}

run "longest_suffix_wins" {
  module { source = "./modules/site-plan" }

  assert {
    condition     = output.zone_name_for["deep.sub.example.com"] == "sub.example.com"
    error_message = "Die spezifischere Zone sub.example.com muss example.com schlagen."
  }

  assert {
    condition     = output.zone_name_for["www.example.co.uk"] == "example.co.uk"
    error_message = "Mehrteilige TLDs müssen korrekt zugeordnet werden."
  }

  assert {
    condition     = output.zone_name_for["example.com"] == "example.com"
    error_message = "Eine Apex-Domain muss ihrer eigenen Zone zugeordnet werden."
  }

  # Ohne den führenden Punkt im endswith() würde www.example.com fälschlich in
  # der Zone ample.com landen.
  assert {
    condition     = output.zone_name_for["www.example.com"] == "example.com"
    error_message = "www.example.com darf nicht in der Zone ample.com landen."
  }

  assert {
    condition     = length(output.findings.unmatched_domains) == 0
    error_message = "Alle Testdomains haben eine passende Zone."
  }
}

run "hostnames_are_lowercased" {
  module { source = "./modules/site-plan" }

  assert {
    condition     = contains(keys(output.zone_name_for), "old.shared.example")
    error_message = "Hostnamen müssen normalisiert werden, sonst schlägt das Zonen-Matching bei Großschreibung fehl."
  }

  assert {
    condition     = output.zone_name_for["old.shared.example"] == "shared.example"
    error_message = "Auch der großgeschriebene Eintrag muss seiner Zone zugeordnet werden."
  }
}

# Der Kern des Umbaus: gamma und delta leiten beide in die Zone
# shared.example um. Cloudflare erlaubt dort nur EIN Entry-Point-Ruleset für
# die Phase http_request_dynamic_redirect.
run "shared_zone_yields_one_ruleset_with_two_rules" {
  module { source = "./modules/site-plan" }

  assert {
    condition     = length(output.rules_by_zone["shared.example"]) == 2
    error_message = "Zwei Sites in einer Zone müssen zwei Regeln unter EINEM Zonen-Key ergeben."
  }

  assert {
    condition     = join(",", sort([for r in output.rules_by_zone["shared.example"] : r.target])) == "ample.com,other.de"
    error_message = "Beide Weiterleitungsziele müssen in derselben Zone erhalten bleiben."
  }

  # Jede Regel matcht nur ihre eigenen Domains.
  assert {
    condition = anytrue([
      for r in output.rules_by_zone["shared.example"] :
      join(",", r.domains) == "old.shared.example" && r.target == "ample.com" && r.status == 308
    ])
    error_message = "Die Regel von delta muss genau ihre Domain und ihren Status-Code tragen."
  }
}

run "always_use_https_is_deduplicated_per_zone" {
  module { source = "./modules/site-plan" }

  # shared.example wird von gamma und delta berührt, darf aber nur einmal
  # verwaltet werden.
  assert {
    condition     = length(output.https_zones) == length(distinct(output.https_zones))
    error_message = "https_zones muss dedupliziert sein."
  }

  assert {
    condition     = contains(output.https_zones, "shared.example")
    error_message = "Eine von zwei Sites geteilte Zone gehört genau einmal in die Liste."
  }
}

run "opting_out_of_https_removes_only_that_zone" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      beta = {
        pagesProject    = "web-beta"
        canonicalDomain = "example.com"
        redirectDomains = ["www.example.com"]
        alwaysUseHttps  = false
      }
      gamma = {
        pagesProject    = "web-gamma"
        canonicalDomain = "other.de"
        redirectDomains = []
      }
    }
  }

  assert {
    condition     = join(",", output.https_zones) == "other.de"
    error_message = "alwaysUseHttps=false darf nur die Zonen dieser Site aussparen."
  }

  assert {
    condition     = join(",", output.managed_zones) == "example.com,other.de"
    error_message = "managed_zones zählt unabhängig von alwaysUseHttps alle berührten Zonen."
  }
}

run "redirect_records_carry_their_zone_and_target" {
  module { source = "./modules/site-plan" }

  assert {
    condition     = output.redirect_records["deep.sub.example.com"].zone_id == "id-sub-example-com"
    error_message = "Der Platzhalter-Record muss in der spezifischsten Zone landen."
  }

  assert {
    condition     = output.redirect_records["deep.sub.example.com"].target == "example.com"
    error_message = "Das Weiterleitungsziel ist die canonicalDomain der zuständigen Site."
  }
}
