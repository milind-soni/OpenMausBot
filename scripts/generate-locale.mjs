#!/usr/bin/env node
// Draft a language pack from src/locales/en.json using the locally installed
// `claude` CLI (your existing login — no API key, nothing leaves your
// machine except the prompt). The output is a DRAFT: review it like any
// community PR before registering it.
//
//   node scripts/generate-locale.mjs de "German"
//   node scripts/generate-locale.mjs --check        # coverage report
//
// The en.json catalog stays a flat map of "key": "value" string pairs on
// purpose — this script (and translators) parse it without a TS toolchain.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
function readCatalog(file) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"));
}

const en = readCatalog("en.json");
const enKeys = Object.keys(en);
if (!enKeys.length) {
  console.error("could not parse any keys from en.json — the catalog must stay flat \"key\": \"value\" pairs");
  process.exit(1);
}

if (process.argv[2] === "--check") {
  for (const file of readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json") && !["en.json", "index.ts"].includes(f))) {
    const pack = readCatalog(file);
    const missing = enKeys.filter((key) => !(key in pack));
    const pct = Math.round(((enKeys.length - missing.length) / enKeys.length) * 100);
    console.log(`${file}: ${pct}% (${enKeys.length - missing.length}/${enKeys.length})${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  }
  process.exit(0);
}

const code = (process.argv[2] ?? "").toLowerCase();
const label = process.argv[3] ?? code;
if (!/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(code)) {
  console.error("usage: node scripts/generate-locale.mjs <bcp47-code> [label]   (or --check)");
  process.exit(1);
}
const outFile = join(LOCALES_DIR, `${code}.json`);
if (existsSync(outFile) && !process.argv.includes("--force")) {
  console.error(`${code}.json already exists — pass --force to overwrite the draft`);
  process.exit(1);
}

const prompt = [
  `Translate this UI string catalog for a desktop app (OpenMausBot, a multi-agent bot workbench) into ${label} (${code}).`,
  "Rules: natural product copy, keep placeholders like {name} verbatim, keep product names (OpenMausBot, CLI, AI) as-is,",
  "match the register of professional desktop apps in that language.",
  "Reply with ONLY a JSON object mapping every key to its translation — no prose, no code fences.",
  "",
  JSON.stringify(en, null, 2),
].join("\n");

console.error(`asking claude to draft ${enKeys.length} strings for ${label}…`);
const raw = execFileSync("claude", ["-p", prompt], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
const jsonStart = raw.indexOf("{");
const jsonEnd = raw.lastIndexOf("}");
if (jsonStart === -1 || jsonEnd === -1) {
  console.error("claude did not return a JSON object; raw output:\n" + raw);
  process.exit(1);
}
const draft = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
const unknown = Object.keys(draft).filter((key) => !enKeys.includes(key));
if (unknown.length) {
  console.error(`draft invented keys (${unknown.join(", ")}) — refusing to write`);
  process.exit(1);
}

const ordered = {};
for (const key of enKeys) {
  if (typeof draft[key] === "string" && draft[key].trim()) ordered[key] = draft[key];
}
writeFileSync(outFile, JSON.stringify(ordered, null, 2) + "\n");
console.error(`wrote ${outFile} — review it, then register "${code}" in src/locales/index.ts (import + locales map)`);
