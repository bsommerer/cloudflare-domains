# cloudflare-domains

**Eine JSON-Datei rein. Domains, DNS, 301-Weiterleitungen und TLS-Erzwingung raus.**

[![CI](https://github.com/bsommerer/cloudflare-domains/actions/workflows/ci.yml/badge.svg)](https://github.com/bsommerer/cloudflare-domains/actions/workflows/ci.yml)
![Terraform](https://img.shields.io/badge/terraform-%E2%89%A5%201.7-7B42BC)
![Tests](https://img.shields.io/badge/terraform%20test-40%20passing-2ea44f)

Jede Website, die man betreut, schleppt einen Rattenschwanz mit: die Domain, auf
der sie läuft, die alte Domain von vor dem Rebranding, die `.com` neben der
`.de`, und zu jeder davon die `www`-Variante. Alle sollen auf **eine**
kanonische Adresse zeigen, per 301, mit Pfad und Query intakt, über `https`.

Von Hand sind das pro Website ein Dutzend Klicks im Cloudflare-Dashboard,
verteilt über vier Menüs — und in einem halben Jahr weiß niemand mehr, warum
Zone C eine Regel hat, die Zone D nicht hat.

Hier ist es eine Datei.

## Das hier …

```json
{
  "domains": {
    "enabled": true,
    "workerName": "kunde-xy",
    "canonicalDomain": "kunde-xy.de",
    "redirectDomains": ["kunde-xy.com", "alte-firma.de"],
    "redirectWWW": true
  }
}
```

## … wird das

```
                          ┌─────────────────────────┐
  www.kunde-xy.de    ───► │                         │
  kunde-xy.com       ───► │  301, Pfad + Query      │ ───►  kunde-xy.de
  www.kunde-xy.com   ───► │  intakt, an der Edge    │       (Worker)
  alte-firma.de      ───► │                         │
  www.alte-firma.de  ───► └─────────────────────────┘
```

Sechs Hostnamen, drei Cloudflare-Zonen, ein `terraform apply`. Die drei
`www`-Varianten hat niemand getippt — `redirectWWW` leitet sie ab.

| Was entsteht | Wofür |
| --- | --- |
| `cloudflare_workers_custom_domain` | kanonische Domain am Worker (legt ihren DNS-Record selbst an) |
| `cloudflare_dns_record` | proxied Platzhalter je Redirect-Domain, damit der Request die Edge erreicht |
| `cloudflare_ruleset` | **ein** Redirect-Ruleset pro Zone — Pfad und Query bleiben |
| `cloudflare_zone_setting` | `always_use_https`, pro Zone dedupliziert |
| `cloudflare_workers_script_subdomain` | optional: `*.workers.dev` abschalten |

## Warum das nicht trivial ist

Der interessante Teil steckt nicht im Terraform, sondern in vier Stellen, an
denen die naive Lösung kaputtgeht.

**Ein Ruleset pro Zone, nicht pro Site.** Cloudflare: *„Each phase has at most
one entry point ruleset at the account level and at the zone level."* Zwei
Sites mit Redirect-Domains in derselben Zone würden sich also gegenseitig
überschreiben — die zweite gewinnt, die erste verschwindet lautlos. Deshalb
aggregiert die Engine über **alle** Sites hinweg zu einem Ruleset je Zone, mit
einer Regel pro Site darin. Dasselbe gilt für `always_use_https`.

**Zonen-Zuordnung über längstes Suffix.** `www.example.co.uk` gehört in die
Zone `example.co.uk` — nicht in `co.uk`, und auch nicht in `ample.co.uk`.
Existieren `example.com` *und* `sub.example.com` als eigene Zonen, gewinnt die
spezifischere. HCL hat kein `sort_by()`, also läuft das über einen
nullgepolsterten Längen-Präfix, der lexikografische Sortierung in
Längensortierung übersetzt.

**Redirect-Domains bekommen keinen Worker.** Sie sollen dort nie ankommen. Sie
bekommen einen proxied `AAAA`-Record auf `100::` — IPv6-Discard-Prefix aus
[RFC 6666](https://www.rfc-editor.org/rfc/rfc6666), routet nirgendwohin. Der
Record existiert einzig, damit der Request die Cloudflare-Edge erreicht, wo die
Redirect Rule greift, bevor irgendein Origin gefragt wird. Genau
[Cloudflares Vorgehen](https://developers.cloudflare.com/fundamentals/manage-domains/redirect-domain/)
für Redirect-only-Domains.

**Der Pfad überlebt.** Ein statischer `target_url.value` wirft jeden Request
auf `/` — aus `/leistungen/vorsorge` wird die Startseite, und die Rankings
gleich mit. Die Engine benutzt `target_url.expression` mit
`concat("https://…", http.request.uri.path)`; den Query-String hält
`preserve_query_string`.

## Security-Header

Statt dieselben Header in jedes Website-Repo (`_headers`) zu kopieren, setzt die
Engine sie je Zone per Response-Header-Transform-Rule. Pro Site, im
`domains`-Block (oder in `_defaults.json`):

```json
"securityHeaders": true
```

`true` setzt konservative Defaults, `false`/fehlend nichts. Zum Feinsteuern ein
Objekt – alles Weggelassene fällt auf die Defaults zurück:

```json
"securityHeaders": {
  "enabled": true,
  "hsts": { "maxAge": 31536000, "includeSubDomains": false, "preload": false },
  "referrerPolicy": "strict-origin-when-cross-origin",
  "permissionsPolicy": "geolocation=(), camera=(), microphone=(), interest-cohort=()",
  "contentTypeOptions": true,
  "frameOptions": "SAMEORIGIN",
  "overrideExisting": false
}
```

`false` bei `hsts`, `referrerPolicy`, `permissionsPolicy` oder `frameOptions`
lässt den jeweiligen Header weg. Ein Objekt in der Site ersetzt ein Objekt aus
`_defaults.json` komplett (das Mischen dort ist flach). HSTS mit `preload`
verlangt `maxAge >= 31536000` und `includeSubDomains`, sonst bricht der Plan ab.

- **Hosts:** die kanonische Domain bekommt alle Header. Redirect-Domains
  antworten mit einer leeren 301, dort sind nur Strict-Transport-Security
  sinnvoll – der Browser merkt sich, dass die Domain nur noch per HTTPS
  angesprochen wird, und die Preload-Liste verlangt den Header auch auf der
  Weiterleitung.
- **Vorrang der Seite:** eine Transform Rule mit `set` *ersetzt* einen Header,
  den der Worker bzw. die `_headers` der Seite schon liefert. Im Standard setzt
  die Engine deshalb nur, was fehlt: eine Regel je Header mit der Bedingung
  `not any(http.response.headers.names[*] == "…")`. Was ein Repo selbst in
  `_headers` setzt, gewinnt. Mit `overrideExisting: true` überschreibt die
  Engine stattdessen, und alle Header einer Site stehen in einer Regel.
- **Kontingent:** der Standard braucht bis zu fünf Regeln je Site und Zone,
  `overrideExisting` eine. Das Kontingent für Response-Header-Transform-Rules
  hängt vom Cloudflare-Plan ab (Free: 10 pro Zone) – bei mehreren Sites in
  einer Zone also ggf. `overrideExisting` nutzen.
- **Bestand:** liegt in der Zone schon ein Ruleset der Phase
  `http_response_headers_transform`, wird es wie beim Redirect-Ruleset per
  `import` übernommen und behält seinen Namen (sonst ersetzt der Provider
  es); fremde Regeln darin erscheinen im Plan als Löschung.
- **Token:** zusätzlich *Zone · Transform Rules · Edit*.

## Testbar ohne Cloudflare

```
sites/<slug>.json  ──►  modules/site-plan  ──►  Cloudflare-Ressourcen
   (Daten)                (reine Funktion)         (Provider)
```

Die gesamte Logik oben liegt in [`modules/site-plan`](modules/site-plan), und
dieses Modul spricht mit **nichts**. Es bildet Konfiguration plus Zonen- und
Worker-Liste auf einen Plan ab, mehr nicht. Kein Provider, keine API, keine
Mocks:

```bash
terraform test        # 40 Fälle, keine Credentials
```

Der Root verdrahtet danach nur noch Plan → Ressourcen. Der Umweg ist der ganze
Trick: Zonen-Matching und Aggregation sind das, was schiefgeht, und genau das
ist hier ohne Cloudflare-Konto prüfbar.

Dazu kommen Guards, die den `plan` hart abbrechen, statt Unsinn zu applien:
`workerName` ohne passendes Script, dieselbe Domain in zwei Sites, eine Domain
die in Site A kanonisch und in Site B Weiterleitungsziel ist, eine Site die
ihre eigene kanonische Domain umleitet, unbekannte Zonen, ungültige
Status-Codes.

## Zwei Wege

| | Für wen | Wie |
|---|---------|-----|
| **Self-Serve** | eigenes Cloudflare-Konto | Engine als Modul, Sites inline — [`examples/self-serve`](examples/self-serve) |
| **Managed / GitOps** | Betreiber mit mehreren Kunden | Config-Repo hält `sites/*.json`, ruft die reusable Workflows — [`examples/sites-config`](examples/sites-config) |

Der GitOps-Weg ist der eigentliche Punkt: die Konfiguration lebt in einem
**separaten Repo**, das diese Engine versioniert konsumiert. Ein PR dort
bekommt den `terraform plan` als Kommentar, Merge löst den `apply` aus. Eine
Website hinzufügen heißt: eine Datei committen.

Und weil eine Site-Datei mehrere Capability-Blöcke haben darf, bedient dasselbe
Config-Repo parallel weitere Engines — jede liest nur ihren eigenen Block:

```json
{
  "name": "Kunde XY",
  "enabled": true,

  "domains":      { "enabled": true, "workerName": "kunde-xy", "…": "…" },
  "contactForms": { "kunde-xy": { "recipients": ["kontakt@kunde-xy.de"] } }
}
```

Eine neue Engine bricht damit keine bestehende.

## Loslegen

```bash
export CLOUDFLARE_API_TOKEN="..."
export TF_VAR_account_id="..."

terraform init
terraform plan  -var sites_dir=/pfad/zum/config-repo/sites   # immer erst lesen
terraform apply -var sites_dir=/pfad/zum/config-repo/sites
```

**Voraussetzungen:** Die Domains liegen bereits als Zone bei Cloudflare, die
Worker sind bereits deployt. Die Engine legt keine Zonen an und deployt keinen
Code — sie verknüpft. Terraform ≥ 1.7, für den R2-State ≥ 1.10.

**Bestehende Seiten** brauchen keinen Sonderweg. Ist die kanonische Domain
schon von Hand mit dem Worker verknüpft, importiert die Engine sie, statt am
„existiert bereits" zu scheitern — Migration ist ein reiner Config-PR.

Dasselbe gilt für das **Redirect-Ruleset** einer Zone. Davon erlaubt Cloudflare
pro Zone nur eins, und es bleibt sogar als leere Hülle bestehen, nachdem die
letzte Regel im Dashboard gelöscht wurde — ein Neuanlegen scheitert dann mit
*„exceeded maximum number of zone rulesets“*. Die Engine übernimmt ein
vorhandenes Ruleset deshalb per `import`, aber nur in Zonen, in denen sie selbst
Weiterleitungen setzt. Ab dann gehört es ihr: von Hand angelegte Regeln darin
erscheinen im Plan als Löschung, sichtbar im PR-Kommentar, bevor etwas
passiert.

<details>
<summary><b>API-Token — welche Rechte, und eine Falle</b></summary>

| Scope   | Permission         | Level | Wofür                                    |
| ------- | ------------------ | ----- | ---------------------------------------- |
| Account | Workers Scripts    | Edit  | Custom Domain + workers.dev-Hostname     |
| Account | Workers R2 Storage | Edit  | Terraform-State im R2-Bucket             |
| Zone    | Zone               | Read  | Zonen-Zuordnung                          |
| Zone    | DNS                | Edit  | Platzhalter-Records der Redirect-Domains |
| Zone    | Single Redirect    | Edit  | die 301-Regeln                           |
| Zone    | Zone Settings      | Edit  | `always_use_https`                       |
| Zone    | Transform Rules    | Edit  | Security-Header (nur mit `securityHeaders`) |

> ⚠️ **Single Redirect**, nicht *Config Rules*. Redirect Rules leben in der
> Phase `http_request_dynamic_redirect`, für die Cloudflare genau diese
> Permission-Group verlangt. Mit *Config Rules* scheitert der Apply mit 403 —
> und die Fehlermeldung sagt nicht, warum.

Das Token wird nur als Umgebungsvariable gelesen und landet **nicht** im State.

Für den State-Bucket braucht es **kein zweites Credential**: Cloudflare leitet
die S3-Zugangsdaten aus demselben Token ab — Access Key ID ist die Token-ID,
Secret Access Key der SHA-256-Hash des Token-Werts. Die reusable Workflows
rechnen das zur Laufzeit aus, deshalb kommt das Config-Repo mit
`CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID` aus.

</details>

<details>
<summary><b>Der Config-Vertrag im Detail</b></summary>

Fehlt der `domains`-Block oder steht dort `"enabled": false`, überspringt diese
Engine die Site folgenlos. Ein optionales `_defaults.json` wird unter jeden
Block gemischt (Site gewinnt). Das JSON-Schema liegt in
[`schema/domains.schema.json`](schema/domains.schema.json) — die Engine ist die
Autorität über ihre eigenen Felder, das Config-Repo komponiert nur.

`redirectWWW` ergänzt zu jeder Domain der Site die www-Variante. Die Option
wirkt bewusst nur auf Domains, die der **Apex ihrer Zone** sind: aus der
Weiterleitung `alt.example.com` entsteht kein sinnloses `www.alt.example.com`.
Bereits explizit gelistete www-Domains werden nicht verdoppelt, und ist die
kanonische Domain selbst die www-Form, entsteht daraus keine Schleife. Am
besten steht sie einmal in `_defaults.json` für alle Sites.

Weitere Felder: `redirectStatusCode` (301/302/307/308, Default 301),
`preserveQueryString`, `alwaysUseHttps`, `disableWorkersDev`.

</details>

<details>
<summary><b>Bestandsübernahme — wie der Import funktioniert</b></summary>

Eine kanonische Domain, die schon von Hand als Workers Custom Domain verknüpft
ist, lässt sich kein zweites Mal anlegen. Statt daran zu scheitern, liest die
Engine die vorhandenen Verknüpfungen und erzeugt daraus `import`-Blöcke:

```hcl
import {
  for_each = local.custom_domain_adoptions
  to       = cloudflare_workers_custom_domain.canonical[each.key]
  id       = "${var.account_id}/${each.value}"
}
```

- Übernommen wird allein anhand des **Hostnamens**. Hängt dort ein anderer
  Worker als konfiguriert, zeigt der `plan` die Umstellung als sichtbare
  Änderung — besser, als sie am State vorbei passieren zu lassen.
- Nur die **kanonische** Domain. Eine Redirect-Domain mit alter
  Worker-Verknüpfung wird nicht importiert; sie braucht Platzhalter-Record und
  Regel. Die alte Verknüpfung im Dashboard lösen, sonst gewinnt sie.
- Der Block bleibt dauerhaft stehen: liegt die Ressource im State, ist er ein
  No-Op.

</details>

<details>
<summary><b>Grenzen, die man kennen sollte</b></summary>

**Die Engine besitzt die Redirect-Rules-Phase jeder berührten Zone.** Folgt aus
dem einen Entry-Point-Ruleset pro Zone und Phase: eine dort von Hand angelegte
Redirect Rule wird vom `apply` überschrieben. Vor dem ersten Lauf gegen eine
Zone mit bestehenden Regeln also entweder die Regeln in die Site-Datei
übernehmen oder die Zone draußen lassen. Der `plan` zeigt es — deshalb ihn
immer lesen.

**`*.workers.dev` gehört Cloudflare, nicht dir.** Dort lassen sich keine
Redirect Rules anlegen, der Hostname indexiert also parallel zur echten Domain.
Anders als bei `*.pages.dev` lässt er sich aber komplett abschalten:

```json
"domains": { "workerName": "kunde-xy", "disableWorkersDev": true, "…": "…" }
```

Ohne die Angabe fasst die Engine den Hostnamen nicht an — dann wirkt gegen
doppelte Indexierung nur der `<link rel="canonical">`-Tag der Seite.

</details>

<details>
<summary><b>wrangler-Konfliktprüfung — damit der nächste Deploy nichts zurückdreht</b></summary>

Die Worker werden aus ihren eigenen Repos per `wrangler deploy` ausgerollt, und
die wrangler-Datei gewinnt dabei gegen die Engine: Fehlt `workers_dev`, schaltet
jeder Deploy den workers.dev-Hostnamen wieder ein; `routes` oder `custom_domain`
kollidieren mit der Custom Domain der Engine. Trägt die Site-Datei das Repo
ein, prüft der Validate-Workflow das im PR:

```json
{ "repo": "kunde-xy-org/kunde-xy-website", "repoRef": "main", "wranglerConfig": "wrangler.toml", "domains": { "…": "…" } }
```

`repoRef` (Default: Default-Branch) und `wranglerConfig` (Default
`wrangler.toml`; `wrangler.jsonc`/`.json` gehen auch) sind optional. Fehler gibt
es, wenn

1. `name` ≠ `domains.workerName`,
2. `disableWorkersDev` gesetzt ist, `workers_dev` aber nicht explizit `false`,
3. `routes`/`route` gesetzt sind (top-level oder in `[env.*]`), obwohl die
   Engine die Domains der Site verwaltet.

Sites ohne `repo` oder mit `domains.enabled != true` werden übersprungen. Die
Ausgabe kommt als Annotation an der Site-Datei und als Tabelle in der
Job-Summary. Lokal: `node scripts/check-wrangler/cli.mjs <sites-dir> [--allow-missing]`
(Node ≥ 20, keine Abhängigkeiten).

Private Worker-Repos liest der `GITHUB_TOKEN` des Config-Repos nicht. Dafür gibt
es das optionale Secret `REPO_READ_TOKEN` (fine-grained PAT, **Contents: Read**
auf die Worker-Repos), das der Aufrufer durchreicht. Ohne das Secret läuft die
Prüfung mit `--allow-missing`: nicht lesbare Repos sind dann nur eine Warnung.
Bestehende Aufrufer brauchen keine Änderung.

</details>

## Workers Builds: Deploy-Einstellungen ins Config-Repo

Die Worker selbst deployt Cloudflare Workers Builds aus dem Git-Repo der Site.
Deren Einstellungen – welcher Branch produktiv geht, welche Befehle laufen,
welche Build-Variablen gesetzt sind, ob Branches eine Vorschau bekommen –
lebten bisher nur im Dashboard. Ein optionaler `builds`-Block holt sie in
dieselbe Site-Datei:

```json
{
  "repo": "kunde-xy-org/kunde-xy-website",
  "domains": { "enabled": true, "workerName": "kunde-xy", "canonicalDomain": "kunde-xy.de" },
  "builds": {
    "enabled": true,
    "productionBranch": "main",
    "buildCommand": "npm run build",
    "deployCommand": "npx wrangler deploy",
    "previews": true,
    "env": { "SKIP_DEPENDENCY_INSTALL": "1" }
  }
}
```

Der Terraform-Provider kennt Workers Builds nicht, deshalb gleicht
[`scripts/reconcile-builds`](scripts/reconcile-builds) (Node ≥ 20, keine
Abhängigkeiten) direkt gegen die API ab – im Validate-Workflow als Plan in
Job-Summary und PR-Kommentar, im Apply-Workflow nach dem `terraform apply`.

- **Zwei Trigger pro Worker:** `cfd:production` (nur `productionBranch`,
  `deployCommand`) und mit `previews` zusätzlich `cfd:preview` (alle anderen
  Branches, `previewDeployCommand`, Default `npx wrangler versions upload`).
- **Eigentum über den Namen:** verändert oder gelöscht werden nur Trigger mit
  `cfd:`-Präfix. Fremde Trigger bleiben unangetastet, der Plan weist nur auf
  sie hin.
- **Bestandsübernahme:** Ein im Dashboard angelegter Trigger mit demselben
  Repo und demselben Branch-Muster wird umbenannt und angeglichen statt
  verdoppelt. Passen mehrere, bricht der Plan ab, statt zu raten.
- **Build-Variablen:** gesetzt wird, was in `env` steht, plus automatisch
  `SITE_URL=https://<canonicalDomain>` (überschreibbar). Entfernt wird nur,
  was der Abgleich selbst gesetzt hatte – das hält er in der Variable
  `CFD_MANAGED_ENV` fest. Secrets werden weder überschrieben noch gelöscht.
- **Löschen:** `previews: false` entfernt den eigenen `cfd:preview`.
  Verwaiste `cfd:`-Trigger (Site oder Block entfernt) löscht der Apply nur mit
  `builds_allow_delete: true`.
- `_defaults.json` wird wie bei `domains` flach gemischt, `env` schlüsselweise.

**Was von Hand bleibt:** Die Cloudflare-GitHub-App braucht Zugriff auf das
Repo, und der Worker muss existieren. Die Repo-Verbindung findet der Abgleich
an einem bestehenden Trigger im Account oder legt sie an; für ein privates
Repo ohne bestehende Verbindung braucht er dafür ein optionales
`BUILDS_GITHUB_TOKEN` (Metadata: Read). Ein Build-Token legt er nie an – er
nimmt das eines vorhandenen Triggers, `<worker> build token` oder den Namen aus
`builds.buildTokenName`. Fehlt etwas davon, bricht der Plan mit Anleitung ab.

**Token-Rechte zusätzlich**, nur wenn eine Site `builds` nutzt:

| Scope   | Permission                     | Level | Wofür                         |
| ------- | ------------------------------ | ----- | ----------------------------- |
| Account | Workers Builds Configuration   | Edit  | Trigger, Variablen, Repo-Verbindung |
| Account | Workers Scripts                | Read  | Script-Tag des Workers (in *Edit* enthalten) |

Wahlweise als eigenes Secret `CLOUDFLARE_BUILDS_API_TOKEN`, sonst gilt
`CLOUDFLARE_API_TOKEN`. Ohne `builds`-Block ist der Abgleich ein No-Op ohne
API-Aufruf; bestehende Config-Repos merken nichts davon.

## Warum überhaupt Terraform

**Warum kein Redirect im Worker?** Würde funktionieren, macht aber jeden
Request zu einer Worker-Invocation und verlagert Infrastruktur in
Anwendungscode. Redirect Rules laufen an der Edge, bevor der Worker angefragt
wird — ohne Laufzeitkosten.

**Warum Workers und nicht Pages?** Cloudflare steuert neue statische Projekte
auf Workers Static Assets, Pages ist faktisch Legacy. Praktisch: eine Workers
Custom Domain legt ihren DNS-Record
[selbst an](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
— es braucht keinen eigenen `cloudflare_dns_record` für die kanonische Domain.
Und `*.workers.dev` lässt sich abschalten, was bei `*.pages.dev` nicht ging.

**Warum kein Shell-Skript gegen die API?** Weil der Wert nicht im Anlegen liegt,
sondern im *Abgleich*: was ist da, was soll da sein, was fällt weg. Genau das
ist der `plan` — und er ist der Review-Gegenstand im PR.

## Status

37 `terraform test`-Fälle, `terraform validate` und CI grün.

In Produktion gelaufen: erster Apply gegen ein echtes Cloudflare-Konto
inklusive Übernahme einer bestehenden Custom Domain, R2-Backend mit
`use_lockfile` (State-Locking greift) und der komplette GitOps-Weg über die
reusable Workflows aus einem Config-Repo — PR mit `plan`-Kommentar, Merge,
`apply`.
