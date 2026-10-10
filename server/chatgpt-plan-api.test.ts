// Real HTTP server, disposable home, fake CLI; OAuth stops before its callback.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CODEX = join(ROOT, "server/testing/fake-codex-app-server.ts");
let child: ChildProcess | undefined;
let home: string;
let base: string;
let logPath: string;
const evidence: Array<{ method: string; path: string; status: number }> = [];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  evidence.push({ method, path: path.split("?")[0], status: response.status });
  return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
}

async function admin(label: string) {
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  expect(pairing.status).toBe(200);
  const paired = await api("POST", "/api/auth/pair", { code: pairing.body.code, label });
  expect(paired.status).toBe(200);
  return { authorization: `Bearer ${paired.body.token}` };
}

function expectSignedOut(instance: Record<string, any>) {
  expect(instance).toMatchObject({
    driverKind: "codex", cli: FAKE_CODEX,
    snapshot: { state: "available", authenticated: false, chatgptPlan: true, billing: "subscription" },
    models: { default: "", options: [] }, authentication: { method: "browser-pkce" },
  });
  expect(instance).not.toHaveProperty("shadow");
  expect(JSON.stringify(instance)).not.toMatch(/access_token|refresh_token|id_token|code_verifier|credentials\.json/);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-chatgpt-api-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  logPath = join(tmpdir(), `omb-chatgpt-api-${port}-${process.pid}.log`);
  // Non-product instance names avoid adding unrelated native CLIs to this fixture.
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    fixture: { driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") } },
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan", cli: FAKE_CODEX } },
  } }));
  const log = openSync(logPath, "a", 0o600);
  try {
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: verificationServerEnvironment({}, home, port), stdio: ["ignore", log, log],
    });
  } finally { closeSync(log); }
  await vi.waitFor(async () => {
    if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Fixture exited: ${logPath}`);
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
    expect(health.status).toBe(200);
    expect((await health.json() as { pid: number }).pid).toBe(child!.pid);
  }, { timeout: 20_000, interval: 100 });
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (logPath) {
    writeFileSync(`${logPath}.requests.json`, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ url: base, logPath, evidencePath: `${logPath}.requests.json` }));
  }
  if (home) await removeTempDir(home);
});

describe("ChatGPT plan accounts over isolated HTTP", () => {
  it("starts signed out with an empty live catalog and rejects invalid account names without saving", async () => {
    const list = await api("GET", "/api/instances");
    expect(list.status).toBe(200);
    expectSignedOut(list.body.instances.find((instance: { instanceId: string }) => instance.instanceId === "chatgpt"));
    const saved = readFileSync(join(home, "config.json"), "utf8");
    for (const body of [{}, { displayName: " " }, { displayName: "x".repeat(81) }, { displayName: "Bad\nName" },
      { displayName: 42 }, { displayName: "Injected", environment: { OPENAI_API_KEY: "synthetic-injection" } }]) {
      expect((await api("POST", "/api/instances/chatgpt-accounts", body)).status).toBe(400);
    }
    expect((await api("POST", "/api/instances/chatgpt-accounts", { displayName: "Wrong type" }, { "content-type": "text/plain" })).status).toBe(415);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(saved);
  });

  it("keeps account entries and locally generated sign-in flows separate and owned by their admin sessions", async () => {
    const ids: string[] = [];
    for (const displayName of ["  Personal plan  ", "Work plan"]) {
      const created = await api("POST", "/api/instances/chatgpt-accounts", { displayName });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ids.push(created.body.instanceId);
      const instance = created.body.instances.find((row: { instanceId: string }) => row.instanceId === created.body.instanceId);
      expectSignedOut(instance);
      expect(instance.displayName).toBe(displayName.trim());
    }
    expect(new Set(ids).size).toBe(2);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    for (const id of ids) {
      expect(saved.instances[id].config).toEqual({ authMode: "chatgpt-plan", cli: FAKE_CODEX });
      expect(saved.instances[id]).not.toHaveProperty("environment");
    }
    const owners = [await admin("Personal browser"), await admin("Work browser")];
    const starts = [];
    for (const [index, id] of ids.entries()) {
      const started = await api("POST", `/api/instances/${id}/auth/start`, {}, owners[index]);
      expect(started.status).toBe(200);
      expect(started.headers.get("cache-control")).toBe("no-store");
      expect(started.body.auth).toMatchObject({ phase: "waiting", flowId: expect.any(String) });
      const authorization = new URL(started.body.auth.authorizationUrl);
      expect(authorization.origin + authorization.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("scope")?.split(" ")).toContain("chatgpt.tokens.use.direct");
      expect(new URL(authorization.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1");
      expect(JSON.stringify(started.body)).not.toMatch(/access_token|refresh_token|id_token|code_verifier/);
      starts.push({ id, auth: started.body.auth, authorization });
      const relativeCredentials = `providers/chatgpt-plan/${createHash("sha256").update(id).digest("hex")}/credentials.json`;
      expect(excludedWorkspaceAuthPath(relativeCredentials)).toBe(true);
      expect(existsSync(join(home, relativeCredentials))).toBe(false);
    }
    expect(starts[0].authorization.searchParams.get("state")).not.toBe(starts[1].authorization.searchParams.get("state"));
    const first = starts[0];
    const statusPath = `/api/instances/${first.id}/auth/status?flowId=${first.auth.flowId}`;
    expect((await api("POST", `/api/instances/${first.id}/auth/start`, {}, owners[1])).status).toBe(409);
    expect((await api("GET", statusPath, undefined, owners[1])).status).toBe(404);
    expect((await api("POST", `/api/instances/${first.id}/auth/cancel`, { flowId: first.auth.flowId }, owners[1])).status).toBe(404);
    const status = await api("GET", statusPath, undefined, owners[0]);
    expect(status.status).toBe(200);
    expect(status.body.auth).toEqual(first.auth);
    const global = await api("GET", "/api/instances");
    expect(JSON.stringify(global.body)).not.toContain(first.auth.flowId);
    expect(JSON.stringify(global.body)).not.toContain(first.auth.authorizationUrl);
    for (const [index, flow] of starts.entries()) {
      expect((await api("POST", `/api/instances/${flow.id}/auth/cancel`, { flowId: flow.auth.flowId }, owners[index])).status).toBe(200);
      const cancelled = await api("GET", `/api/instances/${flow.id}/auth/status?flowId=${flow.auth.flowId}`, undefined, owners[index]);
      expect(cancelled.body.auth).toMatchObject({ phase: "cancelled", authorizationUrl: null });
    }
  });

  it("refuses proxied OAuth starts even for an authenticated admin", async () => {
    const owner = await admin("Proxy browser");
    for (const [header, value] of [
      ["x-forwarded-for", "198.51.100.21"], ["x-forwarded-proto", "https"],
      ["x-forwarded-host", "workspace.example.test"], ["forwarded", "for=198.51.100.21;proto=https"],
    ] as const) {
      const refused = await api("POST", "/api/instances/chatgpt/auth/start", {}, { ...owner, [header]: value });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("computer running OpenMausBot");
      expect(refused.body).not.toHaveProperty("auth");
    }
  });
});
