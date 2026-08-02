#############################################
# Plan-Zeit-Guards
#
# Bewusst als `precondition` und nicht als `check`: ein `check` warnt nur, hier
# soll der Plan hart abbrechen. Und bewusst nicht als `validation` an der
# Variable, weil die Regeln über Sites *hinweg* gelten und teilweise erst nach
# dem Zonen-Lookup entscheidbar sind.
#
# Die Befunde selbst werden im Planer-Modul berechnet und dort getestet.
#############################################

resource "terraform_data" "config" {
  input = keys(local.sites)

  lifecycle {
    precondition {
      condition     = length(local.sites) > 0
      error_message = <<-EOT
        Keine Site konfiguriert. Entweder `sites_dir` auf ein Verzeichnis mit
        `<slug>.json`-Dateien setzen (jede mit einem `domains`-Block, in dem
        `"enabled": true` steht), oder `sites` direkt als Map übergeben.
      EOT
    }

    precondition {
      condition     = length(local.findings.duplicate_canonicals) == 0
      error_message = <<-EOT
        Diese kanonischen Domains sind mehr als einer Site zugeordnet:
        ${join(", ", local.findings.duplicate_canonicals)}.
      EOT
    }

    precondition {
      condition     = length(local.findings.duplicate_redirects) == 0
      error_message = <<-EOT
        Diese Redirect-Domains sind mehr als einer Site zugeordnet:
        ${join(", ", local.findings.duplicate_redirects)}. Jede Domain kann nur
        ein Weiterleitungsziel haben.
      EOT
    }

    precondition {
      condition     = length(local.findings.canonical_and_redirect) == 0
      error_message = <<-EOT
        Diese Domains sind in einer Site kanonisch und in einer anderen als
        Redirect-Domain eingetragen: ${join(", ", local.findings.canonical_and_redirect)}.
      EOT
    }

    precondition {
      condition     = length(local.findings.self_redirecting) == 0
      error_message = <<-EOT
        Diese Sites führen ihre eigene canonicalDomain in redirectDomains und
        erzeugen damit eine Weiterleitungsschleife:
        ${join(", ", local.findings.self_redirecting)}.
      EOT
    }

    precondition {
      condition     = length(local.findings.unknown_workers) == 0
      error_message = <<-EOT
        Diese Worker existieren nicht im Account ${var.account_id}:
        ${join(", ", local.findings.unknown_workers)}.

        Die Engine deployt keine Worker – sie verknüpft nur Domains mit
        bereits vorhandenen. Bitte `workerName` prüfen (Tippfehler?) oder den
        Worker zuerst per `wrangler deploy` ausrollen.
      EOT
    }

    precondition {
      condition     = length(local.findings.invalid_status) == 0
      error_message = <<-EOT
        redirectStatusCode muss 301, 302, 307 oder 308 sein. Betroffene Sites:
        ${join(", ", local.findings.invalid_status)}.
      EOT
    }
  }
}

resource "terraform_data" "zones" {
  input = module.plan.zone_name_for

  lifecycle {
    precondition {
      condition     = length(local.findings.unmatched_domains) == 0
      error_message = <<-EOT
        Für diese Domains wurde keine passende Cloudflare-Zone im Account
        ${var.account_id} gefunden: ${join(", ", local.findings.unmatched_domains)}.

        Voraussetzung des Moduls ist, dass die Domains bereits bei Cloudflare
        liegen. Bitte die Zone im Dashboard anlegen bzw. den Nameserver-Wechsel
        abschließen und danach erneut ausführen.
      EOT
    }
  }
}

# Warnung statt Abbruch: greift nur bei sehr großen Accounts, und der Guard
# oben fängt die Folge – nicht zuordenbare Domains – ohnehin ab.
check "zone_listing_complete" {
  assert {
    condition     = length(data.cloudflare_zones.all.result) < local.zone_page_size
    error_message = <<-EOT
      Das Zonen-Listing hat das Limit von ${local.zone_page_size} erreicht und ist
      womöglich abgeschnitten – die Zonen-Zuordnung kann dann unvollständig sein.
    EOT
  }
}
