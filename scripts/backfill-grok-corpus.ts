/* oxlint-disable anti-slop/no-runtime-typeof
 * -- historical exports are narrowed at their adapter boundary before
 * provenance-bearing records are written. */
import { homedir } from "node:os";
import { join } from "node:path";

import { CaptureMemory } from "../server/capture-memory.ts";
import { importConnectedSourceExports } from "../server/capture-backfill.ts";
import { importGrokCorpus } from "../server/grok-corpus.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
const botId = argument("--bot-id");
const sectionId = argument("--section-id") ?? "Grok Capture Replica";
const connectedFiles = process.argv
  .flatMap((value, index, values) => value === "--connected-source" ? [values[index + 1]] : [])
  .filter((value): value is string => typeof value === "string" && value.length > 0);
if (!botId) throw new Error("Pass --bot-id with the destination Chief bot id");

const roots = [
  argument("--desktop-corpus") ?? join(homedir(), "AppData", "Roaming", "Grok Bot", "sand-client-persistence"),
  argument("--grok-bot-os") ?? join(homedir(), "Code", "Grok Bot OS"),
];
const memory = new CaptureMemory({ file: argument("--db") ?? join(dataDir, "capture.db") });
try {
  const result = importGrokCorpus({
    memory,
    roots,
    botId,
    sectionId,
    dryRun: !process.argv.includes("--apply"),
  });
  const connected = connectedFiles.length === 0 ? null : importConnectedSourceExports({
    memory,
    files: connectedFiles,
    botId,
    sectionId,
    dryRun: !process.argv.includes("--apply"),
  });
  console.log(JSON.stringify({
    mode: process.argv.includes("--apply") ? "apply" : "dry-run",
    roots,
    connectedFiles,
    grok: result,
    connected,
  }, null, 2));
} finally {
  memory.close();
}
