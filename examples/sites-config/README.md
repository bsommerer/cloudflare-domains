# Vorlage: zentrales Config-Repo

Kopiervorlage für ein **privates** Config-Repo, das als Single Source of Truth
für mehrere Engines dient. Eine Website = eine Datei; jede Engine liest nur
ihren eigenen Capability-Block.

```
sites/
  _defaults.json        gemeinsame Defaults, pro Capability-Block
  kunde-xy.json         eine Datei pro Website
.github/workflows/
  ci.yml                ruft validate.yml JEDER Engine auf (PR)
  deploy-domains.yml    → cloudflare-domains/.github/workflows/apply.yml@v1
  deploy-contact-form.yml → contact-form-worker/.github/workflows/deploy.yml@main
```

Kein Anwendungscode, kein Terraform, kein `package.json`. Das Repo hält
Konfiguration und ruft versionierte Engines auf.

## Der Vertrag

Jeder Top-Level-Key einer Site-Datei ist ein **Capability-Block**, der genau
einer Engine gehört:

| Key            | Engine                 |
| -------------- | ---------------------- |
| `domains`      | `cloudflare-domains`   |
| `contactForms` | `contact-form-worker`  |

Verbindlich für jede Engine:

1. Sie liest **nur ihren Block** und ignoriert alle anderen. Deshalb bricht
   eine neue Engine keine bestehende.
2. Fehlt ihr Block oder steht dort `"enabled": false`, überspringt sie die
   Site folgenlos – siehe [`sites/nur-formular.json`](sites/nur-formular.json).
3. `"enabled": false` auf **Site**-Ebene sticht alle Blöcke.
4. Das **Teil-Schema liegt in der Engine**, nicht hier. Dieses Repo komponiert
   nur.

Eine Engine hinzufügen heißt damit: einen Key vergeben und zwei Workflow-Jobs
ergänzen. An bestehenden Engines ändert sich nichts.

## Warum Domains und Kontaktformular in einer Datei stehen

Weil sie dieselbe Information brauchen. Die Contact-Form-Engine leitet ihre
`allowedOrigins` aus dem `domains`-Block ab, statt sie zu duplizieren – ein
Domain-Umzug ist dann eine Zeile in einer Datei, nicht zwei Repos.
Explizites `allowedOrigins` bleibt für Sonderfälle möglich (siehe
`nur-formular.json`, dessen DNS gar nicht hier verwaltet wird).

## Neue Website

1. `sites/<slug>.json` anlegen. Der Dateiname ist der Slug.
2. PR öffnen → `ci.yml` validiert die JSON gegen die Schemas jeder Engine und
   kommentiert den Terraform-Plan an den PR.
3. Mergen → die `deploy-*`-Workflows wenden die Änderung an.

## Secrets

Settings → Secrets and variables → Actions:

| Secret                  | Wofür                                                   |
| ----------------------- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | alle Engines (Rechte siehe jeweilige Engine-README)      |
| `CLOUDFLARE_ACCOUNT_ID` | Account-ID – bleibt dadurch aus den Config-Dateien raus  |
| `R2_ACCOUNT_ID`         | R2-Endpoint für den Terraform-State                      |
| `R2_ACCESS_KEY_ID`      | R2-Token (Object Read & Write auf den State-Bucket)      |
| `R2_SECRET_ACCESS_KEY`  | dito                                                     |
| `RESEND_API_KEY`        | nur `contact-form-worker`                                |
