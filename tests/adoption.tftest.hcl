# Bestandsübernahme: eine kanonische Domain, die schon von Hand mit einem Worker
# verknüpft ist, muss importiert statt neu angelegt werden. Hier wird nur die
# Auswahl geprüft – der `import`-Block selbst liegt im Root.

variables {
  zones = {
    "kunde.de"  = "id-kunde-de"
    "kunde.com" = "id-kunde-com"
  }

  workers = ["kunde", "anderer"]
}

run "existing_canonical_domain_is_adopted" {
  module { source = "./modules/site-plan" }

  variables {
    existing_custom_domains = { "kunde.de" = "cd-1111" }

    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
      }
    }
  }

  assert {
    condition     = output.custom_domain_adoptions["kunde"] == "cd-1111"
    error_message = "Eine bestehende Custom Domain muss zur Übernahme vorgemerkt werden."
  }
}

run "unknown_canonical_domain_is_created_normally" {
  module { source = "./modules/site-plan" }

  variables {
    # Im Account existiert eine ganz andere Verknüpfung.
    existing_custom_domains = { "fremd.de" = "cd-9999" }

    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
      }
    }
  }

  assert {
    condition     = length(keys(output.custom_domain_adoptions)) == 0
    error_message = "Ohne bestehende Verknüpfung darf nichts importiert werden."
  }
}

run "adoption_ignores_redirect_domains" {
  module { source = "./modules/site-plan" }

  variables {
    # kunde.com ist Weiterleitung, keine kanonische Domain. Selbst wenn dort
    # noch eine alte Worker-Verknüpfung hängt, gehört sie nicht in den State –
    # die Engine verwaltet Weiterleitungen über DNS-Record plus Regel.
    existing_custom_domains = {
      "kunde.de"  = "cd-1111"
      "kunde.com" = "cd-2222"
    }

    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
        redirectDomains = ["kunde.com"]
      }
    }
  }

  assert {
    condition     = join(",", values(output.custom_domain_adoptions)) == "cd-1111"
    error_message = "Nur die kanonische Domain wird übernommen, keine Weiterleitung."
  }
}

run "adoption_also_when_a_different_worker_is_attached" {
  module { source = "./modules/site-plan" }

  variables {
    # Übernommen wird allein anhand des Hostnamens. Hängt dort ein anderer
    # Worker, zeigt der Plan die Umstellung als sichtbare Änderung – besser,
    # als sie am State vorbei passieren zu lassen.
    existing_custom_domains = { "kunde.de" = "cd-1111" }

    sites = {
      kunde = {
        workerName      = "anderer"
        canonicalDomain = "kunde.de"
      }
    }
  }

  assert {
    condition     = output.custom_domain_adoptions["kunde"] == "cd-1111"
    error_message = "Auch bei abweichendem Worker wird der Hostname übernommen."
  }
}

run "adoption_is_empty_without_input" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      kunde = {
        workerName      = "kunde"
        canonicalDomain = "kunde.de"
      }
    }
  }

  assert {
    condition     = length(keys(output.custom_domain_adoptions)) == 0
    error_message = "Ohne bekannte Bestandsdomains darf die Übernahme leer bleiben."
  }
}
