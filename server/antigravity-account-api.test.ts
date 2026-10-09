// Real server and provider registry; only synthetic Google profiles and ACP.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess | undefined;
let home: string, base: string, cli: string, logPath: string;
const evidence: unknown[] = [];
function tokenPath(id: string) { return join(home, "providers", "antigravity", createHash("sha256").update(id).digest("hex"), "antigravity-acp", "acp_token.json"); }
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  evidence.push({ method, path, status: response.status });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function launch(port: number) {
  const log = openSync(logPath, "a", 0o600);
  try {
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: verificationServerEnvironment({}, home, port), stdio: ["ignore", log, log],
    });
  } finally { closeSync(log); }
  await vi.waitFor(async () => {
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
    expect((await health.json() as { pid: number }).pid).toBe(child!.pid);
  }, { timeout: 20_000, interval: 100 });
}
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-google-accounts-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  logPath = join(tmpdir(), `omb-google-accounts-${port}-${process.pid}.log`);
  cli = join(home, "fake-antigravity.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
process.env.FAKE_ACP_AUTH_METHOD = "oauth-personal";
process.env.FAKE_ACP_MODELS = "gemini-fixture";
process.env.FAKE_ACP_AGENT_NAME = "Google Antigravity";
await import(${JSON.stringify(pathToFileURL(join(ROOT, "server/testing/fake-acp-cli.ts")).href)});
`, { mode: 0o755 });
  copyFileSync(cli, join(home, process.platform === "win32" ? "localharness_external.exe" : "localharness_external"));
  mkdirSync(join(tokenPath("google-original"), ".."), { recursive: true });
  writeFileSync(tokenPath("google-original"), "{}");
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    fixture: { driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") } },
    "google-original": { driver: "antigravityAgent", displayName: "Original Google", config: { cli, fullAuto: true }, environment: { GOOGLE_API_KEY: "synthetic-do-not-copy" } },
  } }));
  await launch(port);
}, 30_000);
afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (logPath) {
    writeFileSync(`${logPath}.requests.json`, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ url: base, logPath, evidencePath: `${logPath}.requests.json` }));
  }
  if (home) await removeTempDir(home);
});

it("validates account requests and does not allow client-only sessions to add providers", async () => {
  const saved = readFileSync(join(home, "config.json"), "utf8");
  for (const body of [{}, { displayName: " " }, { displayName: "x".repeat(81) }, { displayName: "Work", sourceInstanceId: "fixture" },
    { displayName: "Work", sourceInstanceId: "missing" }, { displayName: "Work", sourceInstanceId: "google-original", environment: { KEY: "no" } }]) {
    expect((await api("POST", "/api/instances/antigravity-accounts", body)).status).toBe(400);
  }
  expect((await api("POST", "/api/instances/antigravity-accounts", {}, { "content-type": "text/plain" })).status).toBe(415);
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
  const paired = await api("POST", "/api/auth/pair", { code: pairing.body.code, label: "Non-admin fixture" });
  expect(paired.status).toBe(200);
  expect((await api("POST", "/api/instances/antigravity-accounts", { displayName: "Work", sourceInstanceId: "google-original" }, { authorization: `Bearer ${paired.body.token}` })).status).toBe(403);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(saved);
});

it("adds independent accounts, switches a bot between their models, and preserves them across server restart", async () => {
  const ids: string[] = [];
  for (const displayName of ["  Personal  ", "Work"]) {
    const created = await api("POST", "/api/instances/antigravity-accounts", { displayName, sourceInstanceId: "google-original" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId as string; ids.push(id);
    const instance = created.body.instances.find((row: any) => row.instanceId === id);
    expect(instance).toMatchObject({ displayName: displayName.trim(), driverKind: "antigravityAgent", cli, snapshot: { authenticated: false } });
    expect(existsSync(tokenPath(id))).toBe(false);
    expect(JSON.stringify(instance)).not.toMatch(/synthetic-do-not-copy|refresh_token|client_secret/);
  }
  expect(new Set(ids).size).toBe(2);
  const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  for (const id of ids) {
    expect(saved.instances[id].config).toEqual({ cli });
    expect(saved.instances[id]).not.toHaveProperty("environment");
    writeFileSync(tokenPath(id), "{}"); // Synthetic sign-in, never a Google token.
    expect((await api("POST", `/api/instances/${id}/refresh-models`, {})).status).toBe(200);
  }
  const created = await api("POST", "/api/bots", { name: "Google switch fixture", modelSelection: { instanceId: ids[0], model: "gemini-fixture" }, requireAvailableModel: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const changed = await api("PATCH", `/api/bots/${created.body.bot.id}/model`, { instanceId: ids[1], model: "gemini-fixture" });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(readFileSync(tokenPath("google-original"), "utf8")).toBe("{}");
  await waitForExit(child, { signal: "SIGTERM" });
  await launch(Number(new URL(base).port));
  const list = await api("GET", "/api/instances");
  for (const id of ids) expect(list.body.instances.find((row: any) => row.instanceId === id).snapshot.authenticated).toBe(true);
  const bots = await api("GET", "/api/bots");
  expect(bots.body.bots.find((bot: any) => bot.id === created.body.bot.id).modelSelection).toMatchObject({ instanceId: ids[1], model: "gemini-fixture" });
}, 40_000);
