#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateFullTaskScopedData } from "../server/full-task-scoped-migration.ts";

function usage(): never {
  throw new Error("usage: migrate-full-task-scoped.ts --data-dir <stopped OpenMausBot data directory>");
}

function dataDirectory(argv: string[]): string {
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const at = argv.indexOf("--data-dir");
  if (at < 0 || !argv[at + 1] || argv[at + 1]!.startsWith("-")) usage();
  if (argv.length !== 2) usage();
  return resolve(argv[at + 1]!);
}

export function main(argv = process.argv.slice(2)): void {
  const receipt = migrateFullTaskScopedData({ dataDir: dataDirectory(argv) });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`full-task-scoped migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
