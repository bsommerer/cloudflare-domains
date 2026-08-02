# Der Vertrag mit dem zentralen Config-Repo: eine Site-Datei beschreibt eine
# Website für MEHRERE Engines. Diese Engine liest ausschließlich `domains`.

variables {
  zones = {
    "kunde-xy.de"  = "id-kunde-xy"
    "kunde-xy.com" = "id-kunde-xy-com"
    "andere.de"    = "id-andere"
  }

  defaults = {
    domains = {
      redirectStatusCode = 308
      alwaysUseHttps     = false
    }
  }

  raw_sites = {
    "kunde-xy" = {
      name = "Kunde XY"
      domains = {
        enabled         = true
        pagesProject    = "web-kunde-xy"
        canonicalDomain = "kunde-xy.de"
        redirectDomains = ["www.kunde-xy.de", "kunde-xy.com"]
      }
      # Gehört einer anderen Engine und muss folgenlos ignoriert werden.
      contactForms = {
        "kunde-xy" = {
          recipients = ["kontakt@kunde-xy.de"]
          turnstile  = true
        }
      }
      # Eine Engine, die es heute noch nicht gibt.
      analytics = { enabled = true, provider = "plausible" }
    }
  }
}

run "unknown_capability_blocks_are_ignored" {
  module { source = "./modules/site-plan" }

  assert {
    condition     = length(output.sites) == 1
    error_message = "Fremde Capability-Blöcke dürfen das Einlesen nicht stören."
  }

  assert {
    condition     = output.sites["kunde-xy"].pagesProject == "web-kunde-xy"
    error_message = "Der domains-Block muss korrekt extrahiert werden."
  }
}

run "defaults_are_merged_below_the_site" {
  module { source = "./modules/site-plan" }

  assert {
    condition     = output.sites["kunde-xy"].redirectStatusCode == 308
    error_message = "_defaults.json muss für nicht gesetzte Felder greifen."
  }

  assert {
    condition     = output.sites["kunde-xy"].alwaysUseHttps == false
    error_message = "Auch boolesche Defaults müssen greifen."
  }

  # Die Site gewinnt gegen die Defaults.
  assert {
    condition     = output.sites["kunde-xy"].canonicalDomain == "kunde-xy.de"
    error_message = "Site-Werte dürfen nicht von Defaults überschrieben werden."
  }
}

run "site_defaults_apply_without_a_defaults_file" {
  module { source = "./modules/site-plan" }

  variables {
    defaults = {}
  }

  assert {
    condition     = output.sites["kunde-xy"].redirectStatusCode == 301
    error_message = "Ohne _defaults.json muss 301 der Default sein."
  }

  assert {
    condition     = output.sites["kunde-xy"].alwaysUseHttps == true
    error_message = "Ohne _defaults.json muss alwaysUseHttps standardmäßig an sein."
  }

  assert {
    condition     = output.sites["kunde-xy"].preserveQueryString == true
    error_message = "Der Query-String bleibt standardmäßig erhalten."
  }
}

run "domains_block_disabled_skips_the_site" {
  module { source = "./modules/site-plan" }

  variables {
    raw_sites = {
      "kunde-xy" = {
        domains      = { enabled = false, pagesProject = "web-kunde-xy", canonicalDomain = "kunde-xy.de" }
        contactForms = { "kunde-xy" = { recipients = ["kontakt@kunde-xy.de"] } }
      }
    }
  }

  assert {
    condition     = length(output.sites) == 0
    error_message = "domains.enabled=false heißt: diese Engine ist nicht zuständig."
  }
}

run "missing_domains_block_skips_the_site" {
  module { source = "./modules/site-plan" }

  variables {
    # Eine Website, die nur ein Kontaktformular hat und ihre DNS woanders pflegt.
    raw_sites = {
      "nur-formular" = {
        contactForms = { "nur-formular" = { recipients = ["a@b.de"] } }
      }
    }
  }

  assert {
    condition     = length(output.sites) == 0
    error_message = "Fehlt der domains-Block, überspringt diese Engine die Site."
  }
}

run "site_level_enabled_false_disables_everything" {
  module { source = "./modules/site-plan" }

  variables {
    raw_sites = {
      "kunde-xy" = {
        enabled = false
        domains = { enabled = true, pagesProject = "web-kunde-xy", canonicalDomain = "kunde-xy.de" }
      }
    }
  }

  assert {
    condition     = length(output.sites) == 0
    error_message = "enabled=false auf Site-Ebene sticht den Capability-Block."
  }
}

run "config_repo_wins_over_inline_sites" {
  module { source = "./modules/site-plan" }

  variables {
    sites = {
      "kunde-xy" = {
        pagesProject    = "web-veraltet"
        canonicalDomain = "andere.de"
      }
    }
  }

  assert {
    condition     = output.sites["kunde-xy"].pagesProject == "web-kunde-xy"
    error_message = "Bei gleichem Slug gewinnt das Config-Repo gegen var.sites."
  }
}
