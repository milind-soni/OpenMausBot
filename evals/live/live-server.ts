import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import type { LiveInstance } from "./types.ts";

/** Boots the REAL harness server for the live tier: no fake engine, no
 * scripted room plan. The one engine instance comes from the developer's
 * opt-in configuration and lands in the data dir's config.json exactly the
 * way a user-configured instance would, so live smoke runs exercise the
 * product's real model path. Everything else stays hermetic: owned temp
 * data dir, loopback ports, only explicitly allowlisted environment. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface LiveServerSession {
  url: string;
  dataDir: string;
  logPath: string;
  child: ChildProcess;
  close(): Promise<void>;
}

export function resolveLiveEnvironment(instance: LiveInstance, parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = { ...instance.environment };
  for (const name of instance.environmentFrom ?? []) {
    const value = parentEnv[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function spawnLiveServer(
  parentEnv: NodeJS.ProcessEnv,
  instance: LiveInstance,
  passEnvNames: string[],
): Promise<LiveServerSession> {
  const port = await freePortBlock([0, 1]);
  const dataDir = mkdtempSync(join(tmpdir(), "omb-live-eval-"));
  const fixtureTemp = join(dataDir, "tmp");
  mkdirSync(fixtureTemp, { recursive: true });
  const environment = resolveLiveEnvironment(instance, parentEnv);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      [instance.instanceId]: {
        driver: instance.driver,
        displayName: instance.displayName ?? "Live eval engine",
        ...(instance.config === undefined ? {} : { config: instance.config }),
        ...(Object.keys(environment).length === 0 ? {} : { environment }),
      },
    },
  }, null, 2));
  const logPath = join(dataDir, "live-server.log");
  const childEnv = verificationServerEnvironment(parentEnv, dataDir, port);
  // Only explicitly named variables (plus PATH, so configured CLIs resolve)
  // cross from the developer's shell into the live fixture.
  for (const name of ["PATH", ...passEnvNames]) {
    const value = parentEnv[name];
    if (value !== undefined) childEnv[name] = value;
  }
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", log, log],
  });
  closeSync(log);

  const url = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await removeTempDir(dataDir);
      throw new Error("live server exited before ready; log: " + logPath);
    }
    try {
      const response = await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) });
      const body = response.ok ? await response.json() as { app?: string } : null;
      if (body?.app === "openmausbot") break;
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) {
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(dataDir);
      throw new Error("live server did not become ready; log: " + logPath);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  let closed = false;
  return {
    url,
    dataDir,
    logPath,
    child,
    async close() {
      if (closed) return;
      closed = true;
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(dataDir);
    },
  };
}
