// CI check for the model manifest. A bad edit on main reaches every install within hours, so the file is held to the
// strict schema here, and `--against <rev>` refuses an edit that does not move `updatedAt` forward.
//
//   node scripts/check-model-manifest.mjs [--against <rev>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { MANIFEST_ENGINES, parseModelManifest } from "../server/model-manifest/schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_RELATIVE_PATH = "server/model-manifest/model-manifest.json";
export const MANIFEST_PATH = join(root, MANIFEST_RELATIVE_PATH);
/** Well under what an install accepts (server/model-manifest/manifest.ts), so a growing file fails here first. */
const MAX_BYTES = 128 * 1024;

/** Problems with the manifest's text, or an empty list when it is sound. */
export function manifestProblems(text, { previous = null, now = Date.now() } = {}) {
  if (Buffer.byteLength(text) > MAX_BYTES) return [`the manifest is larger than ${MAX_BYTES} bytes`];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ["the manifest is not valid JSON"];
  }
  const parsed = parseModelManifest(doc, { strict: true, nowMs: now });
  if (!parsed.ok) return [parsed.error];
  const problems = MANIFEST_ENGINES.filter((engine) => !doc.engines[engine]).map((engine) => `engines.${engine} is missing`);
  if (!parsed.manifest.prices || Object.keys(parsed.manifest.prices).length === 0) problems.push("prices is empty");
  if (previous !== null && text !== previous) {
    let before;
    try {
      before = parseModelManifest(JSON.parse(previous), { nowMs: now });
    } catch {
      before = null;
    }
    if (before?.ok && Date.parse(parsed.manifest.updatedAt) <= Date.parse(before.manifest.updatedAt)) {
      problems.push("the file changed but updatedAt did not move forward; installs compare it to pick the newest copy");
    }
  }
  return problems;
}

function main() {
  const { values } = parseArgs({ options: { against: { type: "string" } } });
  const text = readFileSync(MANIFEST_PATH, "utf8");
  let previous = null;
  if (values.against) {
    try {
      previous = execFileSync("git", ["show", `${values.against}:${MANIFEST_RELATIVE_PATH}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      console.log("model manifest: no earlier copy to compare with");
    }
  }
  const problems = manifestProblems(text, { previous });
  if (problems.length) {
    for (const problem of problems) console.error(`model manifest: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("model manifest: valid");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
