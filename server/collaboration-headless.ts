import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startCollaborationService } from "./collaboration/service.ts";

interface HeadlessArguments {
  dataDirectory: string;
  healthOnly: boolean;
}

function usage(): string {
  return [
    "Usage: pnpm collaboration:headless [--data-dir PATH] [--health]",
    "",
    "  --data-dir PATH  Store collaboration state below PATH",
    "  --health         Print deterministic health JSON and exit",
  ].join("\n");
}

export function parseHeadlessArguments(argv: readonly string[], environment: NodeJS.ProcessEnv): HeadlessArguments {
  let dataDirectory = environment.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
  let healthOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--health") {
      healthOnly = true;
    } else if (argument === "--data-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--data-dir requires a path");
      dataDirectory = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { dataDirectory: resolve(dataDirectory), healthOnly };
}

export function runCollaborationHeadless(argv = process.argv.slice(2), environment = process.env): void {
  const options = parseHeadlessArguments(argv, environment);
  const service = startCollaborationService({ dataDirectory: options.dataDirectory });
  process.stdout.write(`${JSON.stringify(service.health())}\n`);
  if (options.healthOnly) {
    service.close();
    return;
  }

  const keepAlive = setInterval(() => {}, 60 * 60 * 1_000);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    service.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCollaborationHeadless();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`collaboration-headless: ${message}\n`);
    process.exitCode = 1;
  }
}
