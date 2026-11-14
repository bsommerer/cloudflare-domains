import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  annotations,
  checkSites,
  evaluate,
  findRoutes,
  hasErrors,
  loadSites,
  parseWranglerConfig,
  summary,
} from "../check.mjs";
import { githubFetcher } from "../github.mjs";

const fx = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const wr = (name) => parseWranglerConfig(name, readFileSync(fx(`wrangler/${name}`), "utf8"));
const site = (over = {}) => ({
  repo: "o/r",
  domains: { enabled: true, workerName: "kunde-xy", canonicalDomain: "kunde-xy.de", disableWorkersDev: true, ...over },
});

test("saubere Konfiguration ergibt keine Fehler", () => {
  assert.deepEqual(evaluate(site(), wr("ok.toml")), []);
  assert.deepEqual(evaluate(site(), wr("ok.jsonc")), []);
});

test("workers_dev fehlt oder true bei disableWorkersDev", () => {
  assert.equal(evaluate(site(), wr("no-workers-dev.toml")).length, 1);
  assert.equal(evaluate(site(), wr("workers-dev-true.toml")).length, 1);
});

test("workers_dev wird nur bei disableWorkersDev verlangt", () => {
  assert.deepEqual(evaluate(site({ disableWorkersDev: undefined }), wr("no-workers-dev.toml")), []);
  assert.deepEqual(evaluate(site({ disableWorkersDev: false }), wr("no-workers-dev.toml")), []);
});

test("abweichender Worker-Name", () => {
  const errs = evaluate(site(), wr("wrong-name.toml"));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /anderer-worker/);
});

test("routes/route in allen Schreibweisen und in env", () => {
  assert.deepEqual(findRoutes(wr("routes-array.toml")), ["routes"]);
  assert.deepEqual(findRoutes(wr("route-string.toml")), ["route"]);
  assert.deepEqual(findRoutes(wr("routes-table.toml")), ["routes"]);
  assert.deepEqual(findRoutes(wr("env-routes.toml")), ["env.production.routes", "env.preview.routes"]);
  assert.deepEqual(findRoutes(wr("ok.toml")), []);
  assert.deepEqual(findRoutes({ routes: [] }), []);
});

test("mehrere Verstöße ergeben mehrere Meldungen", () => {
  assert.equal(evaluate(site(), parseWranglerConfig("w.toml", `name="x"\nroute="a/*"`)).length, 3);
});

test("loadSites mischt _defaults.json flach unter, Site gewinnt", () => {
  const sites = loadSites(fx("sites"));
  assert.deepEqual(sites.map((s) => s.file), ["a.json", "b-ohne-repo.json", "c-aus.json"]);
  assert.equal(sites[0].site.domains.disableWorkersDev, true);
  assert.equal(sites[0].site.repoRef, "main");
});

const fetcherFor = (files) => async ({ repo, path, ref }) =>
  files[`${repo}:${path}:${ref ?? ""}`] ?? { status: "missing", detail: "HTTP 404" };

test("checkSites überspringt Sites ohne repo oder ohne domains.enabled", async () => {
  const res = await checkSites(loadSites(fx("sites")), {
    fetchFile: fetcherFor({
      "bsommerer/kunde-xy:wrangler.toml:main": { status: "ok", text: readFileSync(fx("wrangler/ok.toml"), "utf8") },
    }),
  });
  assert.deepEqual(res.map((r) => r.state), ["ok", "skipped", "skipped"]);
  assert.equal(hasErrors(res), false);
});

test("wranglerConfig und repoRef werden an den Abruf durchgereicht", async () => {
  let seen;
  const s = [{ file: "x.json", site: { ...site(), wranglerConfig: "app/wrangler.jsonc", repoRef: "dev" } }];
  await checkSites(s, {
    fetchFile: async (a) => ((seen = a), { status: "ok", text: readFileSync(fx("wrangler/ok.jsonc"), "utf8") }),
  });
  assert.deepEqual(seen, { repo: "o/r", path: "app/wrangler.jsonc", ref: "dev" });
});

test("nicht lesbares Repo: Fehler, mit allowMissing nur Warnung", async () => {
  const s = [{ file: "x.json", site: site() }];
  const strict = await checkSites(s, { fetchFile: fetcherFor({}) });
  assert.equal(strict[0].state, "error");
  assert.match(strict[0].messages[0], /Contents: Read/);
  const lax = await checkSites(s, { fetchFile: fetcherFor({}), allowMissing: true });
  assert.equal(lax[0].state, "warning");
  assert.equal(hasErrors(lax), false);
});

test("unlesbares TOML bleibt auch mit allowMissing ein Fehler", async () => {
  const res = await checkSites([{ file: "x.json", site: site() }], {
    fetchFile: async () => ({ status: "ok", text: "name = " }),
    allowMissing: true,
  });
  assert.equal(res[0].state, "error");
});

test("Annotations und Summary", async () => {
  const res = await checkSites([{ file: "x.json", site: site() }], {
    fetchFile: async () => ({ status: "ok", text: 'name = "kunde-xy"' }),
  });
  const [line] = annotations(res, "sites");
  assert.match(line, /^::error file=sites\/x\.json::/);
  assert.ok(!line.includes("\n"));
  assert.match(summary(res), /\| `x\.json` \| ❌ error \|/);
});

test("githubFetcher: URL, Header und Statusabbildung", async () => {
  const calls = [];
  const mk = (status, body = "") => async (url, init) => (calls.push({ url, init }), { ok: status === 200, status, text: async () => body });
  const ok = await githubFetcher({ token: "t", fetchImpl: mk(200, "name='x'") })({ repo: "o/r", path: "a b/wrangler.toml", ref: "feat/x" });
  assert.deepEqual(ok, { status: "ok", text: "name='x'" });
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/contents/a%20b/wrangler.toml?ref=feat%2Fx");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t");
  const args = { repo: "o/r", path: "w.toml" };
  assert.equal((await githubFetcher({ fetchImpl: mk(404) })(args)).status, "missing");
  assert.equal((await githubFetcher({ fetchImpl: mk(403) })(args)).status, "denied");
  assert.equal((await githubFetcher({ fetchImpl: mk(500) })(args)).status, "error");
  assert.equal(calls[1].init.headers.Authorization, undefined);
});
