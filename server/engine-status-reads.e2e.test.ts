// Real server, fake Claude CLI that logs each status probe: an engine's CLI is probed once per answer, not once per reader.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-engine-status-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } },
  }));
  return home;
}

async function boot(home: string, knobs: Record<string, string> = {}) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: verificationServerEnvironment({ ...process.env, ...knobs }, home, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return response.json() as Promise<any>;
  };
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { call, control: (...args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>, stop };
}

const probeCount = (log: string, probe: "version" | "help" | "auth") =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith(`${probe} `)).length : 0;
const claudeStatus = (body: { instances: Array<{ instanceId: string; snapshot: Record<string, unknown> }> }) =>
  body.instances.find((instance) => instance.instanceId === "claude")!.snapshot;

it("probes the engine's CLI once on a later start while the model lists arrive and the engine list is read", async () => {
  const home = freshHome();
  await (await boot(home)).stop();

  const probes = join(home, "probes.log");
  const release = join(home, "release-auth");
  const server = await boot(home, { FAKE_CLAUDE_PROBE_LOG: probes, FAKE_CLAUDE_HOLD_AUTH: release });
  await expect.poll(() => probeCount(probes, "auth"), { timeout: 10_000 }).toBe(1);
  // Like the page: its first engine list, and one more on each model list's config frame.
  const lists = [server.call("GET", "/api/instances"), server.call("GET", "/api/instances"), server.call("GET", "/api/instances")];
  // Every startup model list has answered by now, each asking for the new-bot default again.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect({ version: probeCount(probes, "version"), help: probeCount(probes, "help"), auth: probeCount(probes, "auth") })
    .toEqual({ version: 1, help: 1, auth: 1 });
  writeFileSync(release, "");

  for (const list of await Promise.all(lists)) expect(claudeStatus(list)).toMatchObject({ state: "available", authenticated: true });
  expect(claudeStatus(await server.call("GET", "/api/instances"))).toMatchObject({ state: "available", authenticated: true });
  expect(probeCount(probes, "auth")).toBe(1);
}, 60_000);

it("probes again after a sign-out, a model refresh, a saved key and a Claude update, and reuses the last read otherwise", async () => {
  const home = freshHome();
  const signIn = () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "fake-auth.json"), JSON.stringify({ email: "fixture@example.test" }));
  };
  signIn();
  const probes = join(home, "probes.log");
  const server = await boot(home, { FAKE_CLAUDE_AUTH: "file", FAKE_CLAUDE_PROBE_LOG: probes });
  const engines = () => server.call("GET", "/api/instances");
  // Each step reads the engines first: the read is reused, so the probe after it is the step's own.
  const reused = async () => {
    const before = probeCount(probes, "auth");
    const status = claudeStatus(await engines());
    expect(probeCount(probes, "auth")).toBe(before);
    return { status, before };
  };

  expect(claudeStatus(await engines())).toMatchObject({ authenticated: true, account: { email: "fixture@example.test" } });
  let step = await reused();

  // The sign-out confirms itself with its own `auth status`; the engine list it answers with is read after it.
  const signedOut = await server.call("POST", "/api/instances/claude/auth/sign-out", {});
  expect(claudeStatus(signedOut)).toMatchObject({ authenticated: false });
  expect(probeCount(probes, "auth")).toBeGreaterThan(step.before);

  // Signed in again in a terminal: Settings' Check reads it at once.
  step = await reused();
  expect(step.status).toMatchObject({ authenticated: false });
  signIn();
  expect(claudeStatus(await server.call("POST", "/api/instances/claude/refresh-models", {}))).toMatchObject({ authenticated: true });
  expect(probeCount(probes, "auth")).toBe(step.before + 1);

  step = await reused();
  await server.call("PUT", "/api/config", { opencodeGo: { apiKey: "fixture-opencode-key" } });
  await engines();
  expect(probeCount(probes, "auth")).toBe(step.before + 1);

  step = await reused();
  expect(await server.call("POST", "/api/instances/claude/claude-update", {})).toMatchObject({ ok: true });
  await engines();
  expect(probeCount(probes, "auth")).toBe(step.before + 1);
}, 60_000);
