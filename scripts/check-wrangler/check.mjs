// Prüfung der wrangler-Konfiguration eines Workers gegen die Site-Datei.
//
// Hintergrund: Die Engine verwaltet Custom Domain und workers.dev-Hostname
// eines Workers, der Worker selbst wird aber aus seinem eigenen Repo per
// `wrangler deploy` ausgerollt. Was dort in der wrangler-Datei steht, gewinnt
// bei jedem Deploy – fehlt `workers_dev`, schaltet wrangler den Hostnamen
// wieder ein, und `routes`/`custom_domain` kollidieren mit der Custom Domain
// der Engine. Diese Prüfung fängt das im PR des Config-Repos ab, statt erst
// beim nächsten Deploy aufzufallen.
//
// Alles hier ist rein und ohne Netzwerk testbar: der GitHub-Abruf wird als
// `fetchFile` injiziert.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseToml } from "./toml.mjs";

const DEFAULT_CONFIG = "wrangler.toml";

/** Liest Site-Dateien; `_defaults.json` wird flach untergemischt (Site gewinnt). */
export function loadSites(dir) {
  let defaults = {};
  try {
    defaults = JSON.parse(readFileSync(join(dir, "_defaults.json"), "utf8"));
  } catch {
    // ohne Defaults weiter
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "_defaults.json")
    .sort()
    .map((file) => {
      const site = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return { file, site: mergeDefaults(defaults, site) };
    });
}

// Wie locals.tf bzw. modules/site-plan: der `domains`-Block wird flach
// gemischt, alle anderen Top-Level-Felder (z. B. `repo`) ebenfalls.
export function mergeDefaults(defaults, site) {
  return {
    ...defaults,
    ...site,
    domains: { ...(defaults.domains ?? {}), ...(site.domains ?? {}) },
  };
}

/** Parst wrangler.toml oder wrangler.jsonc/.json in dieselbe Form. */
export function parseWranglerConfig(path, text) {
  if (/\.jsonc?$/i.test(path)) return JSON.parse(stripJsonc(text));
  return parseToml(text);
}

// Kommentare und Trailing Commas entfernen, ohne Strings anzufassen.
function stripJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const isSet = (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

/** Sammelt, wo in der Konfiguration `route`/`routes` gesetzt sind. */
export function findRoutes(config) {
  const hits = [];
  const scan = (node, where) => {
    if (isSet(node.routes)) hits.push(`${where}routes`);
    if (isSet(node.route)) hits.push(`${where}route`);
  };
  scan(config, "");
  for (const [env, body] of Object.entries(config.env ?? {})) {
    if (body && typeof body === "object") scan(body, `env.${env}.`);
  }
  return hits;
}

/** Fehlermeldungen für eine Site; leer = in Ordnung. */
export function evaluate(site, config) {
  const errors = [];
  const d = site.domains;
  if (config.name !== d.workerName) {
    errors.push(
      `\`name\` in der wrangler-Datei ist ${fmt(config.name)}, die Site erwartet \`domains.workerName\` = "${d.workerName}". Ein abweichender Name deployt einen anderen Worker, als die Engine verknüpft.`,
    );
  }
  if (d.disableWorkersDev === true && config.workers_dev !== false) {
    errors.push(
      `\`domains.disableWorkersDev\` ist true, aber \`workers_dev\` steht in der wrangler-Datei auf ${fmt(config.workers_dev)}. Ohne explizites \`workers_dev = false\` schaltet jeder \`wrangler deploy\` den workers.dev-Hostnamen wieder ein.`,
    );
  }
  const routes = findRoutes(config);
  if (routes.length > 0) {
    errors.push(
      `\`${routes.join("`, `")}\` in der wrangler-Datei gesetzt, obwohl die Engine die Domains dieser Site verwaltet. Routen und \`custom_domain\` kollidieren mit der Custom Domain der Engine – entfernen.`,
    );
  }
  return errors;
}

const fmt = (v) => (v === undefined ? "nicht gesetzt" : JSON.stringify(v));

/**
 * Prüft alle Sites. `fetchFile({repo, path, ref})` liefert
 * `{ status: "ok", text }` oder `{ status: "missing" | "denied" | "error", detail }`.
 * Ergebnis je Site: `{ file, state: "ok"|"skipped"|"error"|"warning", messages }`.
 */
export async function checkSites(sites, { fetchFile, allowMissing = false }) {
  const results = [];
  for (const { file, site } of sites) {
    const d = site.domains;
    if (!site.repo) {
      results.push({ file, state: "skipped", messages: ["kein `repo` gesetzt"] });
      continue;
    }
    if (d.enabled !== true) {
      results.push({ file, state: "skipped", messages: ["`domains.enabled` ist nicht true"] });
      continue;
    }
    const path = site.wranglerConfig ?? DEFAULT_CONFIG;
    const res = await fetchFile({ repo: site.repo, path, ref: site.repoRef });
    if (res.status !== "ok") {
      const msg =
        `${site.repo}:${path} nicht lesbar (${res.detail ?? res.status}). ` +
        `Das Token (Secret REPO_READ_TOKEN) braucht für private Repos Contents: Read auf ${site.repo}; ` +
        `außerdem prüfen, ob Pfad${site.repoRef ? " und repoRef" : ""} stimmen.`;
      results.push({ file, state: allowMissing ? "warning" : "error", messages: [msg] });
      continue;
    }
    let config;
    try {
      config = parseWranglerConfig(path, res.text);
    } catch (e) {
      results.push({ file, state: "error", messages: [`${site.repo}:${path} nicht auswertbar: ${e.message}`] });
      continue;
    }
    const errors = evaluate(site, config);
    results.push({ file, state: errors.length ? "error" : "ok", messages: errors });
  }
  return results;
}

const escAnno = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** GitHub-Annotations (`::error file=…::…`). Hinweise zu übersprungenen Sites als `notice`. */
export function annotations(results, dir) {
  const lines = [];
  for (const r of results) {
    const level = { error: "error", warning: "warning", skipped: "notice" }[r.state];
    if (!level) continue;
    for (const m of r.messages) lines.push(`::${level} file=${dir}/${r.file}::${escAnno(m)}`);
  }
  return lines;
}

/** Markdown für `$GITHUB_STEP_SUMMARY`. */
export function summary(results) {
  const icon = { ok: "✅", error: "❌", warning: "⚠️", skipped: "⏭️" };
  const lines = ["### wrangler-Konfiguration – Konfliktprüfung", "", "| Site | Ergebnis | Details |", "| --- | --- | --- |"];
  for (const r of results) {
    const details = r.messages.map((m) => m.replace(/\|/g, "\\|")).join("<br>") || "–";
    lines.push(`| \`${r.file}\` | ${icon[r.state]} ${r.state} | ${details} |`);
  }
  return lines.join("\n") + "\n";
}

export const hasErrors = (results) => results.some((r) => r.state === "error");
