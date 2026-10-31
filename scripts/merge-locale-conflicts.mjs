import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const en = JSON.parse(readFileSync("src/locales/en.json", "utf8"));
const codes = ["de", "es", "fr", "hi", "it", "ja", "pl", "pt-br", "ru", "tr", "uk", "vi", "zh-tw", "zh"];

for (const code of codes) {
  const path = `src/locales/${code}.json`;
  const ours = JSON.parse(execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" }));
  const theirs = JSON.parse(execFileSync("git", ["show", `MERGE_HEAD:${path}`], { encoding: "utf8" }));
  const merged = { ...theirs, ...ours };
  for (const key of Object.keys(merged)) {
    if (!Object.hasOwn(en, key)) delete merged[key];
  }
  for (const key of Object.keys(en)) {
    if (!(key in merged) && key in theirs) merged[key] = theirs[key];
  }
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((key) => [key, merged[key]]));
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(`${code}: ${Object.keys(sorted).length} keys`);
}
