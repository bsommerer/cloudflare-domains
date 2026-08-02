# Prüft den Root: dass die Guards greifen und dass `for_each` über eine aus
# dem Zonen-Lookup abgeleitete Map zur Plan-Zeit auflösbar ist.

# Beide Data Sources liefern unter dem Mock eine leere Liste – der Account
# hat also weder Zonen noch Worker. Genau die Fälle, die die Guards abfangen.
mock_provider "cloudflare" {}

variables {
  account_id = "0123456789abcdef0123456789abcdef"
}

run "unmatched_domain_aborts_the_plan" {
  command = plan

  variables {
    sites = {
      a = { workerName = "web-a", canonicalDomain = "gibtsnicht.example" }
    }
  }

  # Die gemockte Worker-Liste ist leer, deshalb meldet der config-Guard
  # zusaetzlich den unbekannten Worker.
  expect_failures = [
    terraform_data.zones,
    terraform_data.config,
  ]
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
      a = { workerName = "web-a", canonicalDomain = "kollision.example" }
      b = { workerName = "web-b", canonicalDomain = "kollision.example" }
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
