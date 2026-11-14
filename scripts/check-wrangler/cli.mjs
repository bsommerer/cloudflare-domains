#!/usr/bin/env node
// Aufruf: node cli.mjs <sites-verzeichnis> [--allow-missing]
// Token: REPO_READ_TOKEN, sonst GH_TOKEN/GITHUB_TOKEN (nur für öffentliche
// Repos nötig, wenn man das Rate-Limit schonen will).

import { appendFileSync } from "node:fs";
import { annotations, checkSites, hasErrors, loadSites, summary } from "./check.mjs";
import { githubFetcher } from "./github.mjs";

const args = process.argv.slice(2);
const allowMissing = args.includes("--allow-missing");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("Aufruf: cli.mjs <sites-verzeichnis> [--allow-missing]");
  process.exit(2);
}

const token = process.env.REPO_READ_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const results = await checkSites(loadSites(dir), { fetchFile: githubFetcher({ token }), allowMissing });

for (const line of annotations(results, dir)) console.log(line);
const md = summary(results);
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
process.exit(hasErrors(results) ? 1 : 0);
