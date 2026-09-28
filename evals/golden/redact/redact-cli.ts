#!/usr/bin/env -S node --experimental-strip-types
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { goldenExportSchema, redactThread } from "./redact-thread.ts";

/** Turns one real thread export into one synthetic golden fixture. The
 * export is read from a file the developer controls (never a live store);
 * the redacted fixture is written only after the leak scans pass. */

const USAGE = "usage: node --experimental-strip-types evals/golden/redact/redact-cli.ts --input export.json --out evals/golden/scenarios/<id>.json";

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const input = argument(args, "--input");
  const out = argument(args, "--out");
  if (input === undefined || out === undefined) {
    console.error(USAGE);
    return 2;
  }
  const exported = goldenExportSchema.parse(JSON.parse(readFileSync(input, "utf8")));
  const { serialized, report } = redactThread(exported);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serialized);
  console.log(JSON.stringify({ ok: true, out, report }, null, 2));
  console.log("next: pnpm eval --golden --update-baseline --scenario " + report.scenarioId);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
