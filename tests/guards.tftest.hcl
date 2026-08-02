# Konfigurationsfehler, die der Root als harte Precondition abbricht. Getestet
# wird hier der Befund im Planer-Modul – die Verdrahtung zur Fehlermeldung
# steht in validations.tf.

variables {
  zones = {
    "eins.de"   = "id-eins"
    "zwei.de"   = "id-zwei"
    "shared.de" = "id-shared"
  }

  workers = ["web-a", "web-b"]
}

run "domain_without_a_zone_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        redirectDomains = ["www.eins.de", "gibtsnicht.example"]
      }
    }
  }

  assert {
    condition     = join(",", output.findings.unmatched_domains) == "gibtsnicht.example"
    error_message = "Eine Domain ohne passende Zone muss gemeldet werden."
  }

  # Statt eines "Invalid index"-Fehlers beim Auswerten der Ressourcen.
  assert {
    condition     = output.zone_id_for["gibtsnicht.example"] == ""
    error_message = "Eine nicht zuordenbare Domain darf die Auswertung nicht abbrechen."
  }
}

run "same_redirect_domain_in_two_sites_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = ["alt.shared.de"] }
      b = { workerName = "web-b", canonicalDomain = "zwei.de", redirectDomains = ["alt.shared.de"] }
    }
  }

  assert {
    condition     = join(",", output.findings.duplicate_redirects) == "alt.shared.de"
    error_message = "Eine Domain kann nur ein Weiterleitungsziel haben."
  }

  # Wichtig: keine "duplicate key"-Exception, sondern ein sauberer Befund.
  assert {
    condition     = length(output.redirect_records) == 1
    error_message = "Die doppelte Beanspruchung darf die Auswertung nicht abbrechen."
  }
}

run "same_canonical_domain_in_two_sites_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de" }
      b = { workerName = "web-b", canonicalDomain = "eins.de" }
    }
  }

  assert {
    condition     = join(",", output.findings.duplicate_canonicals) == "eins.de"
    error_message = "Zwei Sites dürfen nicht dieselbe kanonische Domain beanspruchen."
  }
}

run "canonical_in_one_site_and_redirect_in_another_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de" }
      b = { workerName = "web-b", canonicalDomain = "zwei.de", redirectDomains = ["eins.de"] }
    }
  }

  assert {
    condition     = join(",", output.findings.canonical_and_redirect) == "eins.de"
    error_message = "Eine Domain kann nicht gleichzeitig Worker-Ziel und Weiterleitung sein."
  }
}

run "self_redirect_loop_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        redirectDomains = ["www.eins.de", "EINS.de"]
      }
    }
  }

  # Greift auch bei abweichender Groß-/Kleinschreibung, weil vorher
  # normalisiert wird.
  assert {
    condition     = join(",", output.findings.self_redirecting) == "a"
    error_message = "Eine Site, die ihre eigene canonicalDomain umleitet, erzeugt eine Schleife."
  }
}

run "invalid_status_code_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName         = "web-a"
        canonicalDomain    = "eins.de"
        redirectStatusCode = 418
      }
    }
  }

  assert {
    condition     = join(",", output.findings.invalid_status) == "a"
    error_message = "Nur 301, 302, 307 und 308 sind zulässig."
  }
}

run "clean_config_reports_nothing" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = ["www.eins.de"] }
      b = { workerName = "web-b", canonicalDomain = "zwei.de", redirectDomains = ["www.zwei.de"] }
    }
  }

  assert {
    condition     = length(flatten(values(output.findings))) == 0
    error_message = "Eine saubere Konfiguration darf keinen Befund erzeugen."
  }
}

run "unknown_worker_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de" }
      b = { workerName = "tippfehler", canonicalDomain = "zwei.de" }
    }
  }

  assert {
    condition     = join(",", output.findings.unknown_workers) == "tippfehler"
    error_message = "Ein workerName ohne passendes Script im Account muss im Plan auffallen, nicht erst beim Apply."
  }
}

run "workers_dev_disable_is_deduplicated_per_worker" {
  module { source = "./modules/site-plan" }

  variables {
    # Ein Worker kann mehrere Sites bedienen – die workers.dev-Abschaltung
    # gilt aber dem Worker, nicht der Site.
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de", disableWorkersDev = true }
      b = { workerName = "web-a", canonicalDomain = "zwei.de", disableWorkersDev = true }
    }
  }

  assert {
    condition     = join(",", output.workers_dev_disabled) == "web-a"
    error_message = "Derselbe Worker darf nur einmal auftauchen, sonst kollidieren zwei Ressourcen."
  }
}

run "workers_dev_is_untouched_by_default" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de" }
    }
  }

  assert {
    condition     = length(output.workers_dev_disabled) == 0
    error_message = "Ohne disableWorkersDev fasst die Engine den workers.dev-Hostnamen nicht an."
  }
}
