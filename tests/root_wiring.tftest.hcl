# Prüft den Root: dass die Guards greifen und dass `for_each` über eine aus
# dem Zonen-Lookup abgeleitete Map zur Plan-Zeit auflösbar ist. Cloudflare
# wird gemockt und liefert dabei einen leeren Zonen-Bestand – jede Domain ist
# also unzuordenbar, was genau der Fall ist, den terraform_data.zones abfängt.

mock_provider "cloudflare" {
  mock_data "cloudflare_pages_project" {
    defaults = { subdomain = "mocked.pages.dev" }
  }
}

variables {
  account_id = "0123456789abcdef0123456789abcdef"
}

run "unmatched_domain_aborts_the_plan" {
  command = plan

  variables {
    sites = {
      a = { pagesProject = "web-a", canonicalDomain = "gibtsnicht.example" }
    }
  }

  expect_failures = [terraform_data.zones]
}

run "empty_config_aborts_the_plan" {
  command = plan

  variables {
    sites = {}
  }

  expect_failures = [terraform_data.config]
}

run "duplicate_canonical_aborts_the_plan" {
  command = plan

  variables {
    sites = {
      a = { pagesProject = "web-a", canonicalDomain = "kollision.example" }
      b = { pagesProject = "web-b", canonicalDomain = "kollision.example" }
    }
  }

  # Der leere Zonen-Bestand des Mocks lässt zwangsläufig auch den
  # Zonen-Guard anschlagen – beide Befunde werden gemeldet, nicht nur der
  # erste.
  expect_failures = [
    terraform_data.config,
    terraform_data.zones,
  ]
}
