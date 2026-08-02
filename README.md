# Cloudflare Domain-Setup als Code

Verknüpft Domains mit Cloudflare-Pages-Projekten und leitet alle Nebendomains
SEO-konform per 301 auf eine kanonische Domain um – DNS, Custom Domain,
Redirect Rules und `http → https` in einem `terraform apply`.

**GitOps-first:** Eine Website hinzufügen heißt _eine JSON-Datei committen_.
Dieses Repo ist die **Engine** (Open Source). Die eigentliche Konfiguration
lebt in einem separaten **Config-Repo**, das diese Engine versioniert
konsumiert – und dabei parallel weitere Engines bedienen kann.

## Zwei Wege, das zu nutzen

| Weg | Für wen | Wie |
|-----|---------|-----|
| **Self-Serve** | Du betreibst es auf deinem eigenen Cloudflare-Konto | Engine als Modul einbinden, Sites inline übergeben – siehe [`examples/self-serve`](examples/self-serve) |
| **Managed / GitOps** | Ein Betreiber stellt es als Service bereit | Zentrales Config-Repo hält `sites/*.json` und ruft die reusable Workflows dieser Engine auf – siehe [`examples/sites-config`](examples/sites-config) |

## Architektur

```
sites/<slug>.json  ──►  modules/site-plan  ──►  Cloudflare-Ressourcen
   (Daten)                (reine Funktion)         (Provider)
```

Die gesamte kniffelige Logik – Zonen-Zuordnung, Aggregation über Sites hinweg,
Konfigurations-Guards – liegt in [`modules/site-plan`](modules/site-plan). Das
Modul spricht mit **nichts**: es bildet Konfiguration plus Zonenliste auf einen
Plan ab. Deshalb lässt es sich in [`tests/`](tests) per `terraform test`
vollständig prüfen, ohne Cloudflare-Zugang und ohne Provider-Mocks. Der Root
verdrahtet nur noch Plan → Ressourcen.

```bash
terraform test        # 20 Tests, keine Credentials nötig
```

## Der Config-Vertrag

Eine Site-Datei beschreibt eine Website für **mehrere** Engines. Jeder
Top-Level-Key ist ein Capability-Block, der genau einer Engine gehört. Diese
Engine liest `domains` und **ignoriert alles andere**:

```json
{
  "name": "Kunde XY",
  "enabled": true,

  "domains": {
    "enabled": true,
    "pagesProject": "web-kunde-xy",
    "canonicalDomain": "kunde-xy.de",
    "redirectDomains": ["www.kunde-xy.de", "kunde-xy.com", "www.kunde-xy.com"]
  },

  "contactForms": { "kunde-xy": { "recipients": ["kontakt@kunde-xy.de"] } }
}
```

Fehlt der `domains`-Block oder steht dort `"enabled": false`, überspringt diese
Engine die Site folgenlos. Ein optionales `_defaults.json` wird unter jeden
Block gemischt (Site gewinnt). Das JSON-Schema liegt in
[`schema/domains.schema.json`](schema/domains.schema.json) – die Engine ist die
Autorität über ihre eigenen Felder, das Config-Repo komponiert nur.

## Voraussetzungen

- Die Domains liegen **bereits als Zone** bei Cloudflare (Nameserver-Wechsel
  abgeschlossen). Die Engine legt keine Zonen an – sie liest sie.
- Die Pages-Projekte existieren bereits.
- Terraform >= 1.7 (>= 1.10, wenn der R2-Backend mit `use_lockfile` genutzt wird).

## Lokal ausführen

```bash
export CLOUDFLARE_API_TOKEN="..."
export TF_VAR_account_id="..."

terraform init
terraform plan -var sites_dir=/pfad/zum/config-repo/sites   # immer erst lesen
terraform apply -var sites_dir=/pfad/zum/config-repo/sites
```

### API-Token

Ein Token mit diesen Rechten genügt (Dashboard → My Profile → API Tokens):

| Scope   | Permission       | Level | Wofür                          |
| ------- | ---------------- | ----- | ------------------------------ |
| Account | Cloudflare Pages | Edit  | Custom Domain am Projekt       |
| Zone    | Zone             | Read  | Zonen-Zuordnung                |
| Zone    | DNS              | Edit  | CNAME + Platzhalter-Records    |
| Zone    | Single Redirect  | Edit  | die 301-Regeln                 |
| Zone    | Zone Settings    | Edit  | `always_use_https`             |

> **Single Redirect**, nicht *Config Rules*: Redirect Rules leben in der Phase
> `http_request_dynamic_redirect`, für die Cloudflare genau dieses
> Permission-Group verlangt. Mit *Config Rules* scheitert der Apply mit 403.

Das Token wird nur als Umgebungsvariable gelesen und landet dadurch **nicht**
im Terraform-State.

## Was automatisch passiert

| Ressource                 | Zweck                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `cloudflare_dns_record`   | CNAME der kanonischen Domain auf `<projekt>.pages.dev` (proxied)  |
| `cloudflare_pages_domain` | Verknüpfung der kanonischen Domain mit dem Pages-Projekt          |
| `cloudflare_dns_record`   | Proxied Platzhalter-Record je Redirect-Domain                     |
| `cloudflare_ruleset`      | **Ein** Redirect-Ruleset pro Zone, Pfad + Query bleiben erhalten  |
| `cloudflare_zone_setting` | `always_use_https` = on, pro Zone dedupliziert                    |

Die Zonen-Zuordnung passiert über **längste Suffix-Übereinstimmung**:
`www.example.co.uk` landet korrekt in der Zone `example.co.uk`, und wenn sowohl
`example.com` als auch `sub.example.com` als Zone existieren, gewinnt die
spezifischere. Gehört eine Domain zu keiner Zone im Account, bricht schon der
`plan` mit einer klaren Meldung ab.

Weitere Guards, die den Plan hart abbrechen: dieselbe Domain in zwei Sites,
eine Domain, die in Site A kanonisch und in Site B Weiterleitungsziel ist, eine
Site, die ihre eigene kanonische Domain umleitet, und ungültige Status-Codes.

## Designentscheidungen

**Warum ein Ruleset pro Zone statt pro Site?** Cloudflare: *„Each phase has at
most one entry point ruleset at the account level and at the zone level."*
Zwei Sites mit Redirect-Domains in derselben Zone müssen sich deshalb **ein**
Ruleset mit zwei Regeln teilen – zwei Rulesets für dieselbe Zone und Phase
kollidieren. Genau dafür existiert die Aggregationsstufe im Planer-Modul, und
genau das prüft `tests/zone_matching.tftest.hcl`.

**Warum keine `_redirects`-Datei?** Cloudflare Pages unterstützt darin
[ausdrücklich keine Domain-Level-Redirects](https://developers.cloudflare.com/pages/configuration/redirects/)
– die Datei matcht nur Pfade, nicht Hostnamen.

**Warum keine Pages-Functions-Middleware?** Würde funktionieren, macht aber
jeden Request zu einer Worker-Invocation und verlagert Infrastruktur in den
Anwendungscode. Redirect Rules laufen an der Edge, bevor Pages überhaupt
angefragt wird – ohne Laufzeitkosten.

**Warum bekommen Redirect-Domains einen Platzhalter-Record statt eines CNAME
auf Pages?** Weil sie nie bei Pages ankommen sollen. `100::` stammt aus dem
IPv6-Discard-Prefix (RFC 6666) und routet nirgendwohin; der Record existiert
ausschließlich, damit der Request die Edge erreicht, wo die Redirect Rule
greift. Das ist [Cloudflares dokumentiertes Vorgehen](https://developers.cloudflare.com/fundamentals/manage-domains/redirect-domain/)
für Redirect-only-Domains.

**Warum `target_url.expression` statt `value`?** Ein statischer `value` würde
jeden Request auf `/` werfen. Die Expression
`concat("https://…", http.request.uri.path)` erhält den Pfad, `preserve_query_string`
den Query-String.

## Bekannte Grenze: bestehende Redirect Rules

Weil Cloudflare pro Zone und Phase nur ein Entry-Point-Ruleset zulässt,
**besitzt diese Engine die komplette Redirect-Rules-Phase jeder berührten
Zone**. Eine dort von Hand angelegte Redirect Rule wird vom `apply`
überschrieben. Vor dem ersten Lauf gegen eine Zone mit bestehenden Regeln
also: Regeln sichten und in die Site-Datei übernehmen, oder die Zone aus der
Konfiguration heraushalten. Der `plan` zeigt es an – deshalb ihn immer lesen.

## Bekannte Grenze: `*.pages.dev`

Die Zone `pages.dev` gehört Cloudflare, nicht dir – dort lassen sich keine
Redirect Rules anlegen. Gegen doppelte Indexierung wirkt hier der
`<link rel="canonical">`-Tag der Seite. Wer das hart abstellen will, muss den
Zugriff auf die pages.dev-Domain im Pages-Projekt selbst einschränken.

## Status

Die Logik ist durch `terraform test` abgedeckt und `terraform validate` läuft
sauber. Der **erste Apply gegen ein echtes Cloudflare-Konto steht noch aus** –
insbesondere der R2-Backend mit `use_lockfile` und die Token-Scopes sollten
beim ersten Lauf bewusst beobachtet werden.
