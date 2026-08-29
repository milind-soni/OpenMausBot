import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { BenchmarkSandbox, SandboxPaths } from "./types.ts";

function assertInside(root: string, candidate: string): void {
  const rel = relative(normalize(root), normalize(candidate));
  if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`benchmark sandbox path escaped root: ${candidate}`);
  }
}

/** Create a disposable profile/storage/database/config namespace.
 * No process environment is mutated and every path is proven to be beneath
 * the generated root before it is created. */
export async function createBenchmarkSandbox(baseDirectory = tmpdir()): Promise<BenchmarkSandbox> {
  const base = resolve(baseDirectory);
  const root = realpathSync(await mkdtemp(join(base, "omb-agent-centipede-")));
  const paths: SandboxPaths = {
    root,
    marker: join(root, ".agent-centipede-sandbox"),
    profile: join(root, "profile"),
    storage: join(root, "storage"),
    database: join(root, "database", "benchmark.sqlite"),
    config: join(root, "config", "benchmark.json"),
    sourceCursors: join(root, "cursor-state"),
    fixtures: join(root, "fixtures"),
    traces: join(root, "traces"),
  };
  for (const path of Object.values(paths)) {
    assertInside(root, path);
  }
  await Promise.all([
    mkdir(paths.profile, { recursive: true }),
    mkdir(paths.storage, { recursive: true }),
    mkdir(dirname(paths.database), { recursive: true }),
    mkdir(dirname(paths.config), { recursive: true }),
    mkdir(paths.sourceCursors, { recursive: true }),
    mkdir(paths.fixtures, { recursive: true }),
    mkdir(paths.traces, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.marker, "agent-centipede-sandbox-v1\n", "utf8"),
    writeFile(paths.config, JSON.stringify({ profile: "agent-centipede-benchmark", production: false }, null, 2)),
    writeFile(paths.database, "agent-centipede-benchmark\n"),
  ]);
  const env = Object.freeze({
    OMB_BENCHMARK: "1",
    OMB_PROFILE_DIR: paths.profile,
    OMB_DATA_DIR: paths.storage,
    OMB_DATABASE_PATH: paths.database,
    OMB_CONFIG_PATH: paths.config,
    OMB_SOURCE_CURSORS_DIR: paths.sourceCursors,
  });
  return {
    paths,
    env,
    dispose: async () => rm(root, { recursive: true, force: true }),
  };
}

export function assertSandboxIsolated(paths: SandboxPaths): void {
  if (!basename(paths.root).startsWith("omb-agent-centipede-")) {
    throw new Error(`benchmark sandbox root is not disposable: ${paths.root}`);
  }
  let root: string;
  try {
    root = realpathSync(paths.root);
    if (readFileSync(paths.marker, "utf8") !== "agent-centipede-sandbox-v1\n") {
      throw new Error("invalid benchmark sandbox marker");
    }
  } catch (error) {
    throw new Error(`benchmark sandbox marker is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const path of Object.values(paths)) {
    assertInside(paths.root, path);
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${path}`);
      assertInside(root, realpathSync(path));
    } catch (error) {
      throw new Error(`benchmark sandbox path is not real and local: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
