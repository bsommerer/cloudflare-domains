# protectPreviews: Preview-URLs eines Workers nur nach Cloudflare-Access-Login.
# Die ersten Fälle zielen auf das Planer-Modul (welcher Worker, welche
# Allowlist), die letzten auf den Root (welche Access-Ressourcen entstehen).

# Unter dem Mock liefern alle Data Sources leere Listen. `mock_data` und
# `override_data` können Listen verschachtelter Objekte (wie `result` der
# Listing-Data-Sources) nicht befüllen. Die Root-Fälle unten ersetzen deshalb
# das Planer-Modul per `override_module` durch einen festen Plan und prüfen nur
# die Verdrahtung Plan -> Access-Ressourcen; die Logik selbst decken die
# Modul-Fälle oben ab.
mock_provider "cloudflare" {}

variables {
  account_id = "0123456789abcdef0123456789abcdef"

  zones = {
    "eins.de" = "id-eins"
    "zwei.de" = "id-zwei"
  }

  workers = ["web-a", "web-b"]
}

#############################################
# Planer-Modul
#############################################

run "off_by_default" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "eins.de" }
    }
  }

  assert {
    condition     = length(output.preview_protection) == 0
    error_message = "Ohne protectPreviews darf die Engine keine Access-Application planen."
  }

  assert {
    condition     = output.protect_previews["a"].enabled == false
    error_message = "Fehlt protectPreviews, ist der Schutz aus."
  }
}

run "explicitly_disabled_stays_off" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = { enabled = false, allowedEmails = ["ich@eins.de"] }
      }
    }
  }

  assert {
    condition     = length(output.preview_protection) == 0
    error_message = "enabled=false schaltet den Schutz ab, auch wenn eine Allowlist dasteht."
  }

  assert {
    condition     = length(output.preview_findings.preview_without_allowlist) == 0
    error_message = "Eine abgeschaltete Site darf keinen Befund erzeugen."
  }
}

run "enabled_site_is_planned_per_worker_with_normalized_allowlist" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = {
          enabled             = true
          allowedEmails       = [" Ich@Eins.de ", "ich@eins.de"]
          allowedEmailDomains = ["@Firma.DE"]
        }
      }
    }
  }

  assert {
    condition     = join(",", keys(output.preview_protection)) == "web-a"
    error_message = "Geschützt wird der Worker der Site."
  }

  assert {
    condition     = join(",", output.preview_protection["web-a"].allowedEmails) == "ich@eins.de"
    error_message = "E-Mail-Adressen werden getrimmt, kleingeschrieben und dedupliziert."
  }

  assert {
    condition     = join(",", output.preview_protection["web-a"].allowedEmailDomains) == "firma.de"
    error_message = "Ein vorangestelltes @ bei Domains wird toleriert und entfernt."
  }

  assert {
    condition     = length(flatten(values(output.preview_findings))) == 0
    error_message = "Eine saubere Konfiguration darf keinen Befund erzeugen."
  }
}

run "defaults_are_merged_field_by_field" {
  module { source = "./modules/site-plan" }

  variables {
    # Die Allowlist steht zentral, die Site schaltet nur ein.
    defaults = {
      domains = {
        protectPreviews = { allowedEmails = ["ich@eins.de"] }
      }
    }

    raw_sites = {
      a = {
        domains = {
          enabled         = true
          workerName      = "web-a"
          canonicalDomain = "eins.de"
          protectPreviews = { enabled = true }
        }
      }
      b = {
        domains = {
          enabled         = true
          workerName      = "web-b"
          canonicalDomain = "zwei.de"
        }
      }
    }
  }

  assert {
    condition     = join(",", output.preview_protection["web-a"].allowedEmails) == "ich@eins.de"
    error_message = "Die Allowlist aus _defaults.json muss erhalten bleiben, wenn die Site nur enabled setzt."
  }

  # Defaults ohne `enabled` schalten nichts ein.
  assert {
    condition     = join(",", keys(output.preview_protection)) == "web-a"
    error_message = "Nur Sites mit enabled=true werden geschützt."
  }
}

run "defaults_can_enable_and_a_site_can_opt_out" {
  module { source = "./modules/site-plan" }

  variables {
    defaults = {
      domains = {
        protectPreviews = { enabled = true, allowedEmailDomains = ["eins.de"] }
      }
    }

    raw_sites = {
      a = {
        domains = { enabled = true, workerName = "web-a", canonicalDomain = "eins.de" }
      }
      b = {
        domains = {
          enabled         = true
          workerName      = "web-b"
          canonicalDomain = "zwei.de"
          protectPreviews = { enabled = false }
        }
      }
    }
  }

  assert {
    condition     = join(",", keys(output.preview_protection)) == "web-a"
    error_message = "Defaults schalten für alle ein, eine Site mit enabled=false bleibt draußen."
  }
}

run "one_worker_for_several_sites_yields_one_entry" {
  module { source = "./modules/site-plan" }

  variables {
    # Zwei Sites, ein Worker: die Previews gehören dem Worker, also eine
    # Application mit vereinigter Allowlist.
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = { enabled = true, allowedEmails = ["a@eins.de"] }
      }
      b = {
        workerName      = "web-a"
        canonicalDomain = "zwei.de"
        protectPreviews = { enabled = true, allowedEmails = ["b@zwei.de", "a@eins.de"] }
      }
    }
  }

  assert {
    condition     = length(output.preview_protection) == 1
    error_message = "Derselbe Worker darf nur einmal geschützt werden, sonst kollidieren zwei Applications."
  }

  assert {
    condition     = join(",", output.preview_protection["web-a"].allowedEmails) == "a@eins.de,b@zwei.de"
    error_message = "Die Allowlist ist die Vereinigung aller Sites des Workers."
  }

  assert {
    condition     = join(",", output.preview_protection["web-a"].sites) == "a,b"
    error_message = "Beide Sites müssen dem Worker zugeordnet sein."
  }
}

run "several_workers_are_kept_apart" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = { enabled = true, allowedEmails = ["a@eins.de"] }
      }
      b = {
        workerName      = "web-b"
        canonicalDomain = "zwei.de"
        protectPreviews = { enabled = true, allowedEmailDomains = ["zwei.de"] }
      }
    }
  }

  assert {
    condition     = join(",", keys(output.preview_protection)) == "web-a,web-b"
    error_message = "Jeder Worker bekommt seinen eigenen Eintrag."
  }

  assert {
    condition = (
      length(output.preview_protection["web-a"].allowedEmailDomains) == 0
      && length(output.preview_protection["web-b"].allowedEmails) == 0
    )
    error_message = "Die Allowlist einer Site darf nicht auf einen anderen Worker durchschlagen."
  }
}

run "enabled_without_allowlist_is_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = { enabled = true }
      }
    }
  }

  assert {
    condition     = join(",", output.preview_findings.preview_without_allowlist) == "a"
    error_message = "Schutz ohne zugelassene Person muss im Plan auffallen."
  }
}

run "malformed_entries_are_reported" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = {
          enabled             = true
          allowedEmails       = ["eins.de"]
          allowedEmailDomains = ["ich@eins.de"]
        }
      }
    }
  }

  assert {
    condition     = join(",", output.preview_findings.invalid_preview_emails) == "eins.de"
    error_message = "Eine Domain im E-Mail-Feld muss gemeldet werden."
  }

  assert {
    condition     = join(",", output.preview_findings.invalid_preview_email_domains) == "ich@eins.de"
    error_message = "Eine Adresse im Domain-Feld muss gemeldet werden."
  }
}

run "worker_id_and_policy_rules_are_prepared_for_the_root" {
  module { source = "./modules/site-plan" }

  variables {
    # So kommt die Zuordnung aus der Workers-API im Root an.
    worker_ids = {
      "web-a" = "0000000000000000000000000000000a"
      "web-b" = "0000000000000000000000000000000b"
    }

    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = {
          enabled             = true
          allowedEmails       = ["ich@eins.de"]
          allowedEmailDomains = ["firma.de"]
        }
      }
      b = { workerName = "web-b", canonicalDomain = "zwei.de" }
    }
  }

  assert {
    condition     = join(",", keys(output.preview_applications)) == "web-a"
    error_message = "Nur geschützte Worker bekommen eine Application."
  }

  assert {
    condition     = output.preview_applications["web-a"].worker_id == "0000000000000000000000000000000a"
    error_message = "Die Destination braucht die unveränderliche ID des Workers, nicht seinen Namen."
  }

  assert {
    condition = (
      length(output.preview_applications["web-a"].include) == 2
      && output.preview_applications["web-a"].include[0].email.email == "ich@eins.de"
      && output.preview_applications["web-a"].include[1].email_domain.domain == "firma.de"
    )
    error_message = "Je Adresse und je Domain entsteht eine Include-Regel."
  }
}

run "missing_worker_id_stays_empty_instead_of_failing" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      a = {
        workerName      = "web-a"
        canonicalDomain = "eins.de"
        protectPreviews = { enabled = true, allowedEmails = ["ich@eins.de"] }
      }
    }
  }

  # Die Precondition im Root meldet das mit einer verständlichen Nachricht.
  assert {
    condition     = output.preview_applications["web-a"].worker_id == ""
    error_message = "Ein fehlender Worker darf die Auswertung nicht mit \"Invalid index\" abbrechen."
  }
}

#############################################
# Root: Access-Ressourcen
#############################################

run "disabled_workers_dev_keeps_protected_previews_on" {
  command = plan

  override_module {
    target = module.plan
    outputs = {
      sites = {
        a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = [], redirectStatusCode = 301 }
        b = { workerName = "web-b", canonicalDomain = "zwei.de", redirectDomains = [], redirectStatusCode = 301 }
      }
      zone_name_for        = { "eins.de" = "eins.de", "zwei.de" = "zwei.de" }
      zone_id_for          = { "eins.de" = "id-eins", "zwei.de" = "id-zwei" }
      zone_ids_by_name     = { "eins.de" = "id-eins", "zwei.de" = "id-zwei" }
      managed_zones        = ["eins.de", "zwei.de"]
      redirect_records     = {}
      rules_by_zone        = {}
      https_zones          = []
      workers_dev_disabled = ["web-a", "web-b"]

      custom_domain_adoptions = {}
      ruleset_adoptions       = {}
      redirect_ruleset_names  = {}

      # Security-Header sind hier nicht Thema.
      ruleset_lookup_zones       = []
      security_headers           = {}
      security_rules_by_zone     = {}
      security_ruleset_adoptions = {}
      security_ruleset_names     = {}
      security_findings          = { invalid_hsts = [] }

      findings = {
        unmatched_domains      = []
        duplicate_canonicals   = []
        duplicate_redirects    = []
        canonical_and_redirect = []
        self_redirecting       = []
        unknown_workers        = []
        invalid_status         = []
      }
      preview_protection = {
        "web-a" = { sites = ["a"], allowedEmails = ["ich@eins.de"], allowedEmailDomains = ["firma.de"] }
      }
      preview_applications = {
        "web-a" = {
          worker_id = "0000000000000000000000000000000a"
          include = [
            { email = { email = "ich@eins.de" } },
            { email_domain = { domain = "firma.de" } },
          ]
        }
      }
      preview_findings = {
        preview_without_allowlist     = []
        invalid_preview_emails        = []
        invalid_preview_email_domains = []
      }
    }
  }

  # Beim Abschalten von workers.dev schaltet die API ohne ausdrückliches
  # `previews_enabled` auch die Previews ab – dann gäbe es nichts zu schützen.
  assert {
    condition     = cloudflare_workers_script_subdomain.canonical["web-a"].enabled == false && cloudflare_workers_script_subdomain.canonical["web-a"].previews_enabled == true
    error_message = "workers.dev aus, die geschützten Previews aber ausdrücklich an."
  }

  assert {
    condition     = cloudflare_workers_script_subdomain.canonical["web-b"].enabled == false
    error_message = "Ohne protectPreviews bleibt es bei workers.dev aus."
  }
}

run "root_creates_preview_worker_application_and_policy" {
  command = plan

  override_module {
    target = module.plan
    outputs = {
      sites = {
        a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = [], redirectStatusCode = 301 }
      }
      zone_name_for        = { "eins.de" = "eins.de" }
      zone_id_for          = { "eins.de" = "id-eins" }
      zone_ids_by_name     = { "eins.de" = "id-eins" }
      managed_zones        = ["eins.de"]
      redirect_records     = {}
      rules_by_zone        = {}
      https_zones          = []
      workers_dev_disabled = []

      custom_domain_adoptions = {}
      ruleset_adoptions       = {}
      redirect_ruleset_names  = {}

      # Security-Header sind hier nicht Thema.
      ruleset_lookup_zones       = []
      security_headers           = {}
      security_rules_by_zone     = {}
      security_ruleset_adoptions = {}
      security_ruleset_names     = {}
      security_findings          = { invalid_hsts = [] }

      findings = {
        unmatched_domains      = []
        duplicate_canonicals   = []
        duplicate_redirects    = []
        canonical_and_redirect = []
        self_redirecting       = []
        unknown_workers        = []
        invalid_status         = []
      }
      preview_protection = {
        "web-a" = { sites = ["a"], allowedEmails = ["ich@eins.de"], allowedEmailDomains = ["firma.de"] }
      }
      preview_applications = {
        "web-a" = {
          worker_id = "0000000000000000000000000000000a"
          include = [
            { email = { email = "ich@eins.de" } },
            { email_domain = { domain = "firma.de" } },
          ]
        }
      }
      preview_findings = {
        preview_without_allowlist     = []
        invalid_preview_emails        = []
        invalid_preview_email_domains = []
      }
    }
  }

  assert {
    condition     = join(",", keys(cloudflare_zero_trust_access_application.preview)) == "web-a"
    error_message = "Je geschütztem Worker entsteht genau eine Access-Application."
  }

  assert {
    condition     = cloudflare_zero_trust_access_application.preview["web-a"].type == "self_hosted"
    error_message = "Worker-Destinations gibt es nur an self-hosted Applications."
  }

  # Der Kern: an die Worker-ID gebunden, nur Previews – nicht Produktion.
  assert {
    condition = (
      length(cloudflare_zero_trust_access_application.preview["web-a"].destinations) == 1
      && cloudflare_zero_trust_access_application.preview["web-a"].destinations[0].type == "preview_worker"
      && cloudflare_zero_trust_access_application.preview["web-a"].destinations[0].worker_id == "0000000000000000000000000000000a"
    )
    error_message = "Die Application muss genau die Previews des Workers per unveränderlicher ID schützen."
  }

  assert {
    condition = (
      cloudflare_zero_trust_access_policy.preview["web-a"].decision == "allow"
      && length(cloudflare_zero_trust_access_policy.preview["web-a"].include) == 2
      # `include` ist ein Set – also über die Elemente prüfen, nicht per Index.
      && anytrue([for r in cloudflare_zero_trust_access_policy.preview["web-a"].include : try(r.email.email, "") == "ich@eins.de"])
      && anytrue([for r in cloudflare_zero_trust_access_policy.preview["web-a"].include : try(r.email_domain.domain, "") == "firma.de"])
    )
    error_message = "Die Policy muss genau die Allowlist zulassen – Adressen und Domains."
  }

  assert {
    condition     = length(cloudflare_zero_trust_access_application.preview["web-a"].policies) == 1
    error_message = "Die Application hängt an genau der einen Policy des Workers."
  }

  assert {
    condition     = length(data.cloudflare_workers.preview) == 1
    error_message = "Mit geschütztem Worker muss die Worker-ID gelesen werden."
  }
}

run "root_creates_nothing_without_protection" {
  command = plan

  override_module {
    target = module.plan
    outputs = {
      sites = {
        a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = [], redirectStatusCode = 301 }
      }
      zone_name_for        = { "eins.de" = "eins.de" }
      zone_id_for          = { "eins.de" = "id-eins" }
      zone_ids_by_name     = { "eins.de" = "id-eins" }
      managed_zones        = ["eins.de"]
      redirect_records     = {}
      rules_by_zone        = {}
      https_zones          = []
      workers_dev_disabled = []

      custom_domain_adoptions = {}
      ruleset_adoptions       = {}
      redirect_ruleset_names  = {}

      # Security-Header sind hier nicht Thema.
      ruleset_lookup_zones       = []
      security_headers           = {}
      security_rules_by_zone     = {}
      security_ruleset_adoptions = {}
      security_ruleset_names     = {}
      security_findings          = { invalid_hsts = [] }

      findings = {
        unmatched_domains      = []
        duplicate_canonicals   = []
        duplicate_redirects    = []
        canonical_and_redirect = []
        self_redirecting       = []
        unknown_workers        = []
        invalid_status         = []
      }
      preview_protection   = {}
      preview_applications = {}
      preview_findings = {
        preview_without_allowlist     = []
        invalid_preview_emails        = []
        invalid_preview_email_domains = []
      }
    }
  }

  assert {
    condition = (
      length(cloudflare_zero_trust_access_application.preview) == 0
      && length(cloudflare_zero_trust_access_policy.preview) == 0
      && length(data.cloudflare_workers.preview) == 0
    )
    error_message = "Ohne protectPreviews darf die Engine Access nicht anfassen – nicht einmal lesen."
  }
}

run "root_aborts_on_missing_worker_id" {
  command = plan

  override_module {
    target = module.plan
    outputs = {
      sites = {
        a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = [], redirectStatusCode = 301 }
      }
      zone_name_for        = { "eins.de" = "eins.de" }
      zone_id_for          = { "eins.de" = "id-eins" }
      zone_ids_by_name     = { "eins.de" = "id-eins" }
      managed_zones        = ["eins.de"]
      redirect_records     = {}
      rules_by_zone        = {}
      https_zones          = []
      workers_dev_disabled = []

      custom_domain_adoptions = {}
      ruleset_adoptions       = {}
      redirect_ruleset_names  = {}

      # Security-Header sind hier nicht Thema.
      ruleset_lookup_zones       = []
      security_headers           = {}
      security_rules_by_zone     = {}
      security_ruleset_adoptions = {}
      security_ruleset_names     = {}
      security_findings          = { invalid_hsts = [] }

      findings = {
        unmatched_domains      = []
        duplicate_canonicals   = []
        duplicate_redirects    = []
        canonical_and_redirect = []
        self_redirecting       = []
        unknown_workers        = []
        invalid_status         = []
      }
      preview_protection = {
        "web-a" = { sites = ["a"], allowedEmails = ["ich@eins.de"], allowedEmailDomains = ["firma.de"] }
      }
      preview_applications = {
        "web-a" = {
          worker_id = ""
          include = [
            { email = { email = "ich@eins.de" } },
            { email_domain = { domain = "firma.de" } },
          ]
        }
      }
      preview_findings = {
        preview_without_allowlist     = []
        invalid_preview_emails        = []
        invalid_preview_email_domains = []
      }
    }
  }

  expect_failures = [cloudflare_zero_trust_access_application.preview["web-a"]]
}

run "root_aborts_without_allowlist" {
  command = plan

  override_module {
    target = module.plan
    outputs = {
      sites = {
        a = { workerName = "web-a", canonicalDomain = "eins.de", redirectDomains = [], redirectStatusCode = 301 }
      }
      zone_name_for        = { "eins.de" = "eins.de" }
      zone_id_for          = { "eins.de" = "id-eins" }
      zone_ids_by_name     = { "eins.de" = "id-eins" }
      managed_zones        = ["eins.de"]
      redirect_records     = {}
      rules_by_zone        = {}
      https_zones          = []
      workers_dev_disabled = []

      custom_domain_adoptions = {}
      ruleset_adoptions       = {}
      redirect_ruleset_names  = {}

      # Security-Header sind hier nicht Thema.
      ruleset_lookup_zones       = []
      security_headers           = {}
      security_rules_by_zone     = {}
      security_ruleset_adoptions = {}
      security_ruleset_names     = {}
      security_findings          = { invalid_hsts = [] }

      findings = {
        unmatched_domains      = []
        duplicate_canonicals   = []
        duplicate_redirects    = []
        canonical_and_redirect = []
        self_redirecting       = []
        unknown_workers        = []
        invalid_status         = []
      }
      preview_protection = {
        "web-a" = { sites = ["a"], allowedEmails = ["ich@eins.de"], allowedEmailDomains = ["firma.de"] }
      }
      preview_applications = {
        "web-a" = {
          worker_id = "0000000000000000000000000000000a"
          include = [
            { email = { email = "ich@eins.de" } },
            { email_domain = { domain = "firma.de" } },
          ]
        }
      }
      preview_findings = {
        preview_without_allowlist     = ["a"]
        invalid_preview_emails        = []
        invalid_preview_email_domains = []
      }
    }
  }

  expect_failures = [terraform_data.preview_protection]
}
