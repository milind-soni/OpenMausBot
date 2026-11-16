import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { engineStatusFile, flushEngineStatusFiles } from "./harness/engine-status-file.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

it("restores a terminal-only update through the real engine API before the startup probe finishes", async () => {
  const fixture = await launchVerificationServer();
  const release = join(fixture.info.dataDir, "release-codex-probe");
  let child: ChildProcess | undefined;
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const { dataDir, logPath } = fixture.info;
    const probed = join(dataDir, "codex-probe-started");
    const cli = join(dataDir, "codex-seed-fixture.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  writeFileSync(${JSON.stringify(probed)}, "started");
  while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 25));
  process.stdout.write("codex-cli 0.147.0\\n");
} else {
  await import(${JSON.stringify(new URL("./testing/fake-codex-app-server.ts", import.meta.url).href)});
}
`, { mode: 0o700 });
    const configFile = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.instances.codex = { driver: "codex", config: { cli } };
    writeFileSync(configFile, JSON.stringify(config));
    const update = { title: "Update Codex to 0.169.0", message: "Use the terminal for the newer release.", command: "codex update", serverInstall: false as const };
    engineStatusFile(join(dataDir, "providers", "engine-status.json")).save([
      { instanceId: "codex", driverKind: "codex", cli, snapshot: { state: "available", version: "codex-cli 0.167.0", authenticated: true, update } },
    ]);
    flushEngineStatusFiles();

    const port = await freePortBlock([0, 1]);
    const url = `http://127.0.0.1:${port}`;
    const env = verificationServerEnvironment(process.env, dataDir, port);
    const log = openSync(logPath, "a");
    child = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => {
      if (child!.exitCode !== null) throw new Error(`fixture exited; see ${logPath}`);
      try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; }
    }, { timeout: 30_000, interval: 50 }).toBe(true);
    const status = async () => {
      const response = await fetch(`${url}/api/instances`, { headers: { origin: url } });
      expect(response.status).toBe(200);
      const body = await response.json() as { instances: Array<{ instanceId: string; snapshot: { version?: string; update?: unknown } }> };
      return body.instances.find((instance) => instance.instanceId === "codex")!.snapshot;
    };
    await expect.poll(() => existsSync(probed), { timeout: 10_000 }).toBe(true);
    expect(existsSync(release)).toBe(false);
    expect(await status()).toMatchObject({ version: "codex-cli 0.167.0", update });
    writeFileSync(release, "continue");
    await expect.poll(async () => (await status()).version, { timeout: 15_000 }).toBe("codex-cli 0.147.0");
    console.info(`Codex status recovery fixture: ${url}; server log: ${logPath}`);
  } finally {
    writeFileSync(release, "cleanup");
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
