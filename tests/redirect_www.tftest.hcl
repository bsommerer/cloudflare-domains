# Die Komfort-Option redirectWWW. Interessant sind vor allem die Fälle, in
# denen sie NICHT greifen darf.

variables {
  zones = {
    "kunde.de"      = "id-kunde-de"
    "kunde.com"     = "id-kunde-com"
    "kunde.co.uk"   = "id-kunde-couk"
    "sub.kunde.de"  = "id-sub-kunde-de"
    "www.sonder.de" = "id-www-sonder-de"
    "sonder.de"     = "id-sonder-de"
  }

  workers = ["kunde"]
}

run "www_is_added_for_canonical_and_every_apex_redirect" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectDomains = ["kunde.com", "kunde.co.uk"]
        redirectWWW     = true
      }
    }
  }

  assert {
    condition = join(",", sort(output.sites["kunde"].redirectDomains)) == join(",", [
      "kunde.co.uk", "kunde.com", "www.kunde.co.uk", "www.kunde.com", "www.kunde.de"
    ])
    error_message = "Zu jeder Apex-Domain – inklusive der kanonischen – muss die www-Variante entstehen."
  }

  # Die www-Variante gehört in dieselbe Zone wie ihre Basis.
  assert {
    condition     = output.zone_name_for["www.kunde.co.uk"] == "kunde.co.uk"
    error_message = "Auch bei mehrteiligen TLDs muss die www-Variante korrekt zugeordnet werden."
  }

  assert {
    condition     = length(output.findings.unmatched_domains) == 0
    error_message = "Die generierten www-Domains müssen alle eine Zone finden."
  }
}

run "off_by_default" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectDomains = ["kunde.com"]
      }
    }
  }

  assert {
    condition     = join(",", output.sites["kunde"].redirectDomains) == "kunde.com"
    error_message = "Ohne redirectWWW darf die Engine nichts hinzufügen."
  }
}

run "no_www_for_subdomains" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        # alt.kunde.com ist kein Apex – "www.alt.kunde.com" wäre Unsinn.
        # sub.kunde.de ist zwar eine eigene Zone, also sehr wohl ein Apex.
        redirectDomains = ["alt.kunde.com", "sub.kunde.de"]
        redirectWWW     = true
      }
    }
  }

  assert {
    condition     = !contains(output.sites["kunde"].redirectDomains, "www.alt.kunde.com")
    error_message = "Für eine Subdomain darf keine www-Variante entstehen."
  }

  assert {
    condition     = contains(output.sites["kunde"].redirectDomains, "www.sub.kunde.de")
    error_message = "Ist die Subdomain selbst eine Zone, ist sie ein Apex und bekommt ihre www-Variante."
  }
}

run "no_duplicate_when_www_is_also_listed_explicitly" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectDomains = ["www.kunde.de", "kunde.com"]
        redirectWWW     = true
      }
    }
  }

  assert {
    condition = length([
      for d in output.sites["kunde"].redirectDomains : d if d == "www.kunde.de"
    ]) == 1
    error_message = "Eine bereits explizit gelistete www-Domain darf nicht doppelt auftauchen."
  }

  # Und aus "www.kunde.de" darf kein "www.www.kunde.de" werden.
  assert {
    condition     = !contains(output.sites["kunde"].redirectDomains, "www.www.kunde.de")
    error_message = "Eine www-Domain darf kein zweites www-Präfix bekommen."
  }
}

run "no_loop_when_canonical_is_the_www_variant" {
  module { source = "./modules/site-plan" }

  variables {
    # Kanonisch ist hier bewusst die www-Form. Aus "sonder.de" darf dann NICHT
    # "www.sonder.de" erzeugt werden – das wäre die kanonische Domain selbst
    # und damit eine Weiterleitungsschleife.
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "www.sonder.de"
        redirectDomains = ["sonder.de"]
        redirectWWW     = true
      }
    }
  }

  assert {
    condition     = join(",", output.sites["kunde"].redirectDomains) == "sonder.de"
    error_message = "Die kanonische Domain darf nicht als eigene Weiterleitung erzeugt werden."
  }

  assert {
    condition     = length(output.findings.self_redirecting) == 0
    error_message = "redirectWWW darf keine Schleife erzeugen."
  }
}

run "generated_www_domains_flow_into_rules_and_records" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectDomains = ["kunde.com"]
        redirectWWW     = true
      }
    }
  }

  # www.kunde.de liegt in der Zone der kanonischen Domain, kunde.com und
  # www.kunde.com in einer zweiten -> zwei Rulesets.
  assert {
    condition     = length(keys(output.rules_by_zone)) == 2
    error_message = "Die generierten Domains müssen sich auf ihre Zonen verteilen."
  }

  assert {
    condition     = join(",", output.rules_by_zone["kunde.com"][0].domains) == "kunde.com,www.kunde.com"
    error_message = "Basis und www-Variante gehören in dieselbe Regel derselben Zone."
  }

  assert {
    condition     = output.redirect_records["www.kunde.de"].target == "kunde.de"
    error_message = "Auch die generierten Domains brauchen einen Platzhalter-Record auf das kanonische Ziel."
  }
}
