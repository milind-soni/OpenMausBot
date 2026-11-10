// Real HTTP boundary, disposable home/data, synthetic Claude accounts only.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-sonnet-5";
let home: string;
let dataDir: string;
let cli: string;
let base: string;
let clientToken: string;
let child: ChildProcess;
let stderr = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

function saved() {
  return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
}

async function addAccount(displayName: string) {
  const response = await api("POST", "/api/instances/claude-accounts", { displayName });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const instance = response.body.instances.find((row: any) => row.instanceId === response.body.instanceId);
  return { id: response.body.instanceId as string, dir: instance.claudeAccount.configDir as string, instance };
}

async function addBot(instanceId: string) {
  const response = await api("POST", "/api/bots", {
    name: "Fixture bot", modelSelection: { instanceId, model: MODEL }, requireAvailableModel: true,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.bot;
}

async function addBotOn(instanceId: string, model: string) {
  const response = await api("POST", "/api/bots", {
    name: "Endpoint bot", modelSelection: { instanceId, model }, requireAvailableModel: true,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.bot;
}

async function bot(id: string) {
  return (await api("GET", "/api/bots?messages=30")).body.bots.find((row: any) => row.id === id);
}

async function idle(id: string) {
  await expect.poll(async () => (await bot(id))?.busy, { timeout: 10_000 }).toBe(false);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-claude-account-api-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  cli = join(home, "fixture-claude.mjs");
  // The official-style auth probe stays synthetic; turns reuse the repository
  // fake CLI. A per-account marker makes only that account hang until stopped.
  writeFileSync(cli, `#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
const dir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, ".claude");
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: basename(dir) + "@example.test", orgName: "Fixture team", accessToken: "fixture-must-not-leak" }));
  process.exit(0);
}
if (process.argv[2] !== "--version") {
  mkdirSync(dir, { recursive: true });
  process.env.FAKE_CLAUDE_MODE = existsSync(join(dir, "hang")) ? "hang" : "happy";
  process.env.FAKE_CLAUDE_DUMP = join(dir, "spawn.json");
  process.env.FAKE_CLAUDE_REPLIES = JSON.stringify(["account:" + basename(dir)]);
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ghost: { driver: "not-a-real-driver", displayName: "Preserved shadow" },
      // The `claude` product fleet auto-adds these IDs unless configured.
      // Pin shadows so this test never probes an installed provider CLI.
      ...Object.fromEntries(["cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map(id => [id, { driver: "not-a-real-driver" }])),
      "broken-account": {
        driver: "claudeAgent", displayName: "Repairable shadow", config: { cli, configDir: "relative/saved-directory" },
      },
      codex: { driver: "codex", config: { cli: join(SERVER_DIR, "testing", "fake-codex-app-server.ts") } },
      claude: {
        driver: "claudeAgent", displayName: "Default fixture", config: { cli },
        environment: { ANTHROPIC_AUTH_TOKEN: "fixture-base-secret", BASE_ONLY_SENTINEL: "base-only" },
      },
    },
  }));
  const sessions = new SessionRegistry({ file: join(dataDir, "sessions.json") });
  const paired = sessions.exchange({ code: sessions.openPairing({ scopes: ["client"] }).code, label: "Fixture client", source: "fixture" });
  if (!paired.ok) throw new Error("fixture session failed");
  clientToken = paired.token;
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('let refreshes = 0; globalThis.fetch = async (url) => String(url).startsWith("https://catalog-fixture.example/") ? Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] }) : String(url).startsWith("https://growing-fixture.example/") ? Response.json({ data: [{ id: "model-a" }, ...(refreshes++ ? [{ id: "model-new" }] : [])] }) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_SSE_HEARTBEAT_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${stderr}`);
    try { if ((await api("GET", "/api/health")).body.pid === child.pid) break; } catch {}
    if (Date.now() > deadline) throw new Error(`fixture did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
  if (child) expect(child.exitCode === 0 || (process.platform === "win32" && child.signalCode === "SIGTERM"), stderr).toBe(true);
});

describe("Claude account HTTP API", () => {
  it.each(["claude", "codex"])("connects %s without a model and keeps independent bot choices", async engine => {
    const created = await api("POST", `/api/instances/${engine}-endpoint`, { displayName: "Catalog fixture", baseUrl: "https://catalog-fixture.example/v1", token: "catalog-fixture-key" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId;
    const instance = created.body.instances.find((row: any) => row.instanceId === id);
    expect(instance.models.options).toEqual(expect.arrayContaining([expect.objectContaining({ id: "model-a", custom: true }), expect.objectContaining({ id: "model-b", custom: true })]));
    const first = await addBotOn(id, "model-a");
    const second = await addBotOn(id, "model-b");
    expect((await bot(first.id)).modelSelection.model).toBe("model-a");
    expect((await bot(second.id)).modelSelection.model).toBe("model-b");
    if (engine === "claude") {
      for (const [launched, model] of [[first, "model-a"], [second, "model-b"]] as const) {
        expect((await api("POST", `/api/bots/${launched.id}/messages`, { text: "which model" })).status).toBe(202);
        await idle(launched.id);
        const spawn = JSON.parse(readFileSync(join(saved().instances[id].config.configDir, "spawn.json"), "utf8"));
        expect(spawn.argv[spawn.argv.indexOf("--model") + 1]).toBe(model);
      }
    }
    expect((await api("PATCH", `/api/instances/${id}/${engine}-endpoint`, { displayName: "Renamed", baseUrl: "https://catalog-fixture.example/v1" })).status).toBe(200);
    const configs = saved().instances[id].config;
    expect(engine === "codex" ? configs.endpoint.models : configs.endpointModels).toEqual(["model-a", "model-b"]);
  });

  it.each([
    ["claude", "https://api.anthropic.com"],
    ["codex", "https://api.openai.com/v1"],
  ])("connects official %s without choosing a provider-wide model", async (engine, baseUrl) => {
    const result = await api("POST", `/api/instances/${engine}-endpoint`, { displayName: "Official fixture", baseUrl, token: "official-fixture-key" });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const instance = result.body.instances.find((row: any) => row.instanceId === result.body.instanceId);
    expect(instance.models.options.length).toBeGreaterThan(1);
    expect(instance.models.options.every((option: any) => option.custom)).toBe(true);
    expect(saved().instances[result.body.instanceId].environment).not.toHaveProperty("ANTHROPIC_MODEL");
  });

  it("does not persist an endpoint when gateway model discovery fails", async () => {
    const before = Object.keys(saved().instances);
    const result = await api("POST", "/api/instances/codex-endpoint", { displayName: "Failed fixture", baseUrl: "https://offline.example/v1", token: "failed-fixture-secret" });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Could not discover gateway models");
    expect(JSON.stringify(result.body)).not.toContain("failed-fixture-secret");
    expect(Object.keys(saved().instances)).toEqual(before);
  });

  it("reads a gateway's model list again on Refresh models", async () => {
    const created = await api("POST", "/api/instances/codex-endpoint", { displayName: "Growing fixture", baseUrl: "https://growing-fixture.example/v1", token: "growing-fixture-key" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId;
    expect(saved().instances[id].config.endpoint.models).toEqual(["model-a"]);
    const refreshed = await api("POST", `/api/instances/${id}/refresh-models`, {});
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(saved().instances[id].config.endpoint.models).toEqual(["model-a", "model-new"]);
    expect(refreshed.body.instances.find((row: any) => row.instanceId === id).models.options.map((option: any) => option.id)).toContain("model-new");
    expect((await api("DELETE", `/api/instances/${id}`)).status).toBe(200);
  });

  it("keeps a Codex endpoint's fixed model when its key changes on the official URL", async () => {
    const created = await api("POST", "/api/instances/codex-endpoint", { displayName: "Fixed fixture", baseUrl: "https://api.openai.com/v1", token: "fixed-fixture-key", model: "fixed-model" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId;
    expect((await api("PATCH", `/api/instances/${id}/codex-endpoint`, { token: "fixed-rotated-key" })).status).toBe(200);
    expect(saved().instances[id].config.endpoint.models).toEqual(["fixed-model"]);
    expect((await api("DELETE", `/api/instances/${id}`)).status).toBe(200);
  });

  it("rotates a legacy Claude endpoint's key without a model catalog", async () => {
    const created = await api("POST", "/api/instances/claude-endpoint", { displayName: "Legacy fixture", baseUrl: "https://offline.example", token: "legacy-fixture-key", model: "legacy-model" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId;
    const rotated = await api("PATCH", `/api/instances/${id}/claude-endpoint`, { token: "legacy-rotated-key" });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(saved().instances[id].environment).toMatchObject({ ANTHROPIC_API_KEY: "legacy-rotated-key", ANTHROPIC_MODEL: "legacy-model" });
    expect((await api("DELETE", `/api/instances/${id}`)).status).toBe(200);
  });

  it("creates, edits and removes an isolated Codex API endpoint without OAuth or key disclosure", async () => {
    const fields = { displayName: "CLIProxyAPI", baseUrl: "https://gateway.example/v1", token: "codex-api-fixture-secret", model: "gateway-model" };
    const created = await api("POST", "/api/instances/codex-endpoint", fields);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId;
    const instance = created.body.instances.find((row: any) => row.instanceId === id);
    expect(instance.codexEndpoint).toEqual({ baseUrl: fields.baseUrl, models: ["gateway-model"], tokenSaved: true });
    expect(instance.authentication).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain(fields.token);
    expect(saved().instances[id].environment.CODEX_HOME).toContain(id);
    expect(saved().instances[id].environment.OPENMAUSBOT_CODEX_API_KEY).toBe(fields.token);
    expect((await api("POST", `/api/instances/${id}/auth/start`)).status).not.toBe(200);
    expect((await api("PATCH", `/api/instances/${id}/codex-endpoint`, { baseUrl: "https://other.example/v1" })).status).toBe(400);
    expect((await api("PATCH", `/api/instances/${id}/codex-endpoint`, { model: "another-model" })).status).toBe(200);
    expect(saved().instances[id].config.endpoint.models).toEqual(["another-model"]);
    expect((await api("PATCH", `/api/instances/${id}/codex-endpoint`, { token: "codex-api-rotated-secret" })).status).toBe(200);
    expect(saved().instances[id].config.endpoint.models).toEqual(["another-model"]);
    const bot = await addBotOn(id, "another-model");
    expect((await api("DELETE", `/api/instances/${id}`)).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${bot.id}/model`, { instanceId: "claude", model: MODEL })).status).toBe(200);
    expect((await api("DELETE", `/api/instances/${id}`)).status).toBe(200);
    expect(saved().instances[id]).toBeUndefined();
    for (const baseUrl of ["http://gateway.example/v1", "https://user:secret@gateway.example/v1", "invalid"]) {
      expect((await api("POST", "/api/instances/codex-endpoint", { ...fields, baseUrl })).status).toBe(400);
    }
    expect((await api("POST", "/api/instances/codex-endpoint", fields, { authorization: `Bearer ${clientToken}` })).status).toBe(403);
  });

  it("creates beside an invalid saved directory and repairs that unused shadow without accepting invalid replacements", async () => {
    const initial = (await api("GET", "/api/instances")).body.instances.find((row: any) => row.instanceId === "broken-account");
    expect(initial.snapshot.state).toBe("unavailable");
    expect(initial.install?.signInCommand).toBeUndefined();
    await addAccount("Alongside repairable shadow");
    const repairedDir = join(home, "repaired-account");
    const repaired = await api("PATCH", "/api/instances/broken-account", { configDir: repairedDir });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect(repaired.body.instances.find((row: any) => row.instanceId === "broken-account")).toMatchObject({
      snapshot: { state: "available", authenticated: true }, claudeAccount: { configDir: repairedDir },
    });
    expect((await api("PATCH", "/api/instances/broken-account", { configDir: "still/relative" })).status).toBe(400);
    expect((await api("POST", "/api/instances/claude-accounts", { displayName: "Invalid new account", configDir: "still/relative" })).status).toBe(400);
    expect(saved().instances["broken-account"].config.configDir).toBe(repairedDir);
  });

  it("creates isolated named accounts, renames without changing IDs, and removes only the saved entry", async () => {
    const first = await addAccount("Work");
    const second = await addAccount("Personal");
    expect(first.id).not.toBe(second.id);
    expect(first.dir).not.toBe(second.dir);
    expect(first.dir).toBe(join(dataDir, "providers", first.id));
    expect(first.instance).toMatchObject({
      displayName: "Work", cli,
      snapshot: { authenticated: true, account: { email: `${basename(first.dir)}@example.test`, organization: "Fixture team" } },
      claudeAccount: { isDefault: false, signInCommand: expect.stringContaining(first.dir) },
    });
    expect(first.instance.install.signInCommand).toBe(first.instance.claudeAccount.signInCommand);
    expect(first.instance.install.signInCommand).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(first.instance.install.signInCommand).toContain("login");
    const listing = await api("GET", "/api/instances");
    expect(JSON.stringify(listing.body)).not.toMatch(/fixture-base-secret|fixture-must-not-leak|BASE_ONLY_SENTINEL/);
    expect(saved().instances[first.id]).toMatchObject({ driver: "claudeAgent", config: { cli, configDir: first.dir } });
    expect(saved().instances[first.id]).not.toHaveProperty("environment");
    expect(saved().instances.claude.environment).toEqual({ ANTHROPIC_AUTH_TOKEN: "fixture-base-secret", BASE_ONLY_SENTINEL: "base-only" });
    const renamed = await api("PATCH", `/api/instances/${first.id}`, { displayName: "Renamed work" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.instances.find((row: any) => row.instanceId === first.id).displayName).toBe("Renamed work");
    expect(saved().instances[first.id].config.configDir).toBe(first.dir);

    mkdirSync(first.dir, { recursive: true });
    const marker = join(first.dir, "user-owned-marker.txt");
    writeFileSync(marker, "Keep the user's CLI account files");
    expect((await api("DELETE", `/api/instances/${first.id}`)).status).toBe(200);
    expect(saved().instances).not.toHaveProperty(first.id);
    expect(saved().instances).toHaveProperty("ghost");
    expect(saved().instances).toHaveProperty("claude");
    expect(readFileSync(marker, "utf8")).toBe("Keep the user's CLI account files");
    expect((await api("GET", "/api/instances")).body.instances.some((row: any) => row.instanceId === first.id)).toBe(false);
    expect((await api("DELETE", "/api/instances/claude")).status).toBe(400);
    expect((await api("DELETE", "/api/instances/ghost")).status).toBe(400);
  });

  it("keeps per-bot account selections separate and protects directories referenced by bots or past tasks", async () => {
    const first = await addAccount("History account");
    const second = await addAccount("Other bot account");
    const firstBot = await addBot(first.id);
    const secondBot = await addBot(second.id);
    expect((await bot(firstBot.id)).modelSelection.instanceId).toBe(first.id);
    expect((await bot(secondBot.id)).modelSelection.instanceId).toBe(second.id);
    const changeDirectory = () => api("PATCH", `/api/instances/${first.id}`, { configDir: join(home, "different-history-account") });
    expect((await changeDirectory()).status).toBe(409);
    expect((await api("DELETE", `/api/instances/${first.id}`)).status).toBe(409);
    expect((await api("POST", `/api/bots/${firstBot.id}/messages`, { text: "record fixture history" })).status).toBe(202);
    await idle(firstBot.id);
    expect((await bot(firstBot.id)).messages.some((message: any) => message.text === `account:${basename(first.dir)}`)).toBe(true);
    expect((await api("PATCH", `/api/bots/${firstBot.id}/model`, { instanceId: second.id, model: MODEL })).status).toBe(200);
    expect((await api("POST", `/api/bots/${firstBot.id}/tasks`, { title: "New empty task" })).status).toBe(201);
    expect((await bot(firstBot.id)).modelSelection.instanceId).toBe(second.id);
    expect((await changeDirectory()).status).toBe(409);
    expect(saved().instances[first.id].config.configDir).toBe(first.dir);
    expect((await bot(secondBot.id)).modelSelection.instanceId).toBe(second.id);
  });

  it("rejects busy-account edits while sibling changes preserve the running process and later SSE events", async () => {
    const active = await addAccount("Running account");
    const sibling = await addAccount("Idle sibling");
    const runningBot = await addBot(active.id);
    mkdirSync(active.dir, { recursive: true });
    writeFileSync(join(active.dir, "hang"), "fixture only");
    const stream = await openSse(`${base}/api/events`);
    try {
      await stream.until(frame => frame.kind === "hello");
      expect((await api("POST", `/api/bots/${runningBot.id}/messages`, { text: "remain active" })).status).toBe(202);
      await expect.poll(() => existsSync(join(active.dir, "spawn.json")), { timeout: 10_000 }).toBe(true);
      const originalPid = JSON.parse(readFileSync(join(active.dir, "spawn.json"), "utf8")).pid;
      expect((await bot(runningBot.id)).busy).toBe(true);
      expect((await api("PATCH", `/api/instances/${active.id}`, { cli })).status).toBe(409);
      expect((await api("PATCH", `/api/instances/${sibling.id}`, { displayName: "Changed sibling" })).status).toBe(200);
      await addAccount("Added while sibling is busy");
      expect((await api("DELETE", `/api/instances/${sibling.id}`)).status).toBe(200);
      expect((await bot(runningBot.id)).busy).toBe(true);
      expect(() => process.kill(originalPid, 0)).not.toThrow();
      expect(JSON.parse(readFileSync(join(active.dir, "spawn.json"), "utf8")).pid).toBe(originalPid);
      expect((await api("POST", `/api/bots/${runningBot.id}/interrupt`, {})).status).toBe(200);
      await idle(runningBot.id);
      unlinkSync(join(active.dir, "hang"));
      expect((await api("POST", `/api/bots/${runningBot.id}/messages`, { text: "reply after interruption" })).status).toBe(202);
      await stream.until(frame => frame.kind === "message" && frame.threadId === runningBot.threadId && frame.message?.text === `account:${basename(active.dir)}`);
      await idle(runningBot.id);
      expect((await bot(runningBot.id)).messages.some((message: any) => message.text === `account:${basename(active.dir)}`)).toBe(true);
    } finally {
      stream.close();
      await api("POST", `/api/bots/${runningBot.id}/interrupt`, {});
    }
  });

  it("creates a custom endpoint as its own engine, keeps its token server-side, and runs its model against its host", async () => {
    // A settings.json the person's own Claude Code uses: an endpoint must not inherit any of it.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://user-settings.test", ANTHROPIC_AUTH_TOKEN: "user-settings-secret", ANTHROPIC_MODEL: "claude-from-settings" },
    }));
    const endpoint = {
      displayName: "DeepSeek", baseUrl: "https://api.deepseek.test/anthropic/", token: "sk-endpoint-secret",
      model: "deepseek-chat", opusModel: "deepseek-reasoner",
    };
    const created = await api("POST", "/api/instances/claude-endpoint", endpoint);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.instanceId as string;
    const row = created.body.instances.find((candidate: any) => candidate.instanceId === id);
    expect(row).toMatchObject({
      displayName: "DeepSeek",
      driverKind: "claudeAgent",
      access: "custom",
      url: "https://api.deepseek.test/anthropic",
      claudeEndpoint: { baseUrl: "https://api.deepseek.test/anthropic", models: ["deepseek-chat", "deepseek-reasoner"], tokenSaved: true },
    });
    expect(JSON.stringify(created.body)).not.toContain("sk-endpoint-secret");
    expect(JSON.stringify((await api("GET", "/api/instances")).body)).not.toContain("sk-endpoint-secret");
    expect(saved().instances[id]).toMatchObject({
      driver: "claudeAgent", access: "custom",
      config: { cli, requireApiKey: true, endpointModels: ["deepseek-chat", "deepseek-reasoner"] },
      environment: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.test/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-endpoint-secret", ANTHROPIC_API_KEY: "sk-endpoint-secret",
        ANTHROPIC_MODEL: "deepseek-chat", ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-reasoner",
      },
    });

    const endpointBot = await addBotOn(id, "deepseek-chat");
    expect((await api("POST", `/api/bots/${endpointBot.id}/messages`, { text: "which host" })).status).toBe(202);
    await idle(endpointBot.id);
    const directory = saved().instances[id].config.configDir as string;
    const spawn = JSON.parse(readFileSync(join(directory, "spawn.json"), "utf8"));
    expect(spawn.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.test/anthropic",
      ANTHROPIC_MODEL: "deepseek-chat",
      ANTHROPIC_AUTH_TOKEN: "sk-endpoint-secret",
    });
    expect(spawn.env.ANTHROPIC_AUTH_TOKEN).not.toBe("user-settings-secret");
    expect(spawn.env.ANTHROPIC_BASE_URL).not.toBe("https://user-settings.test");
    const model = spawn.argv[spawn.argv.indexOf("--model") + 1];
    expect(model).toBe("deepseek-chat");
    expect((await bot(endpointBot.id)).messages.some((message: any) => message.text === `account:${basename(directory)}`)).toBe(true);

    const edited = await api("PATCH", `/api/instances/${id}/claude-endpoint`, { model: "deepseek-reasoner", opusModel: "" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const afterEdit = saved().instances[id];
    expect(afterEdit.environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "sk-endpoint-secret",
      ANTHROPIC_BASE_URL: "https://api.deepseek.test/anthropic",
      ANTHROPIC_MODEL: "deepseek-reasoner",
    });
    expect(afterEdit.environment).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(afterEdit.config.endpointModels).toEqual(["deepseek-reasoner"]);
    expect(edited.body.instances.find((candidate: any) => candidate.instanceId === id).claudeEndpoint.models).toEqual(["deepseek-reasoner"]);

    expect((await api("PATCH", "/api/instances/claude/claude-endpoint", { model: "deepseek-chat" })).status).toBe(400);
    expect((await api("PATCH", "/api/instances/missing/claude-endpoint", { model: "deepseek-chat" })).status).toBe(404);
    for (const invalid of [{}, { displayName: "Only" }, { ...endpoint, baseUrl: "ftp://api.deepseek.test" }, { ...endpoint, model: "has space" }, { ...endpoint, token: "" }]) {
      expect((await api("POST", "/api/instances/claude-endpoint", invalid)).status, JSON.stringify(invalid)).toBe(400);
    }
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, "user-owned-marker.txt");
    writeFileSync(marker, "Keep the endpoint's own files");
    expect((await api("PATCH", `/api/bots/${endpointBot.id}/model`, { instanceId: "claude", model: MODEL })).status).toBe(200);
    expect((await api("DELETE", `/api/instances/${id}`)).status).toBe(200);
    expect(saved().instances).not.toHaveProperty(id);
    expect(readFileSync(marker, "utf8")).toBe("Keep the endpoint's own files");
  });

  it("enforces JSON, validation, duplicate-directory and admin-only mutation gates", async () => {
    const target = await addAccount("Validation account");
    for (const [method, path, body] of [
      ["POST", "/api/instances/claude-accounts", { displayName: "Blocked" }],
      ["PATCH", `/api/instances/${target.id}`, { displayName: "Blocked" }],
    ] as const) {
      expect((await api(method, path, body, { "content-type": "text/plain" })).status).toBe(415);
      const malformed = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: "{" });
      expect(malformed.status).toBe(400);
    }
    for (const body of [{}, { displayName: " " }, { displayName: "x".repeat(81) }, { displayName: "Bad\nname" }, { displayName: "Valid", environment: {} }]) {
      expect((await api("POST", "/api/instances/claude-accounts", body)).status).toBe(400);
    }
    expect((await api("POST", "/api/instances/claude-accounts", { displayName: "Relative", configDir: "relative/path" })).status).toBe(400);
    expect((await api("POST", "/api/instances/claude-accounts", { displayName: "Duplicate", configDir: target.dir })).status).toBe(409);
    expect((await api("PATCH", `/api/instances/${target.id}`, { configDir: "relative/path" })).status).toBe(400);
    expect((await api("PATCH", `/api/instances/${target.id}`, {})).status).toBe(400);
    expect((await api("PATCH", `/api/instances/${target.id}`, { displayName: 7 })).status).toBe(400);
    expect((await api("PATCH", "/api/instances/ghost", { displayName: "Not Claude" })).status).toBe(400);
    expect((await api("PATCH", "/api/instances/missing", { cli })).status).toBe(404);
    expect((await api("DELETE", "/api/instances/missing")).status).toBe(404);
    for (const [method, path, body] of [
      ["POST", "/api/instances/claude-accounts", { displayName: "Client blocked" }],
      ["PATCH", `/api/instances/${target.id}`, { displayName: "Client blocked" }],
      ["DELETE", `/api/instances/${target.id}`, undefined],
    ] as const) {
      expect((await api(method, path, body, { authorization: `Bearer ${clientToken}` })).status).toBe(403);
    }
    expect(saved().instances[target.id].displayName).toBe("Validation account");
  });
});
