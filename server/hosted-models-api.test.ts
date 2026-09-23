// Real HTTP runtime, owned temporary home, fake native engines, no provider calls.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = `omb_workspace_${"s".repeat(43)}`;
const ORIGINAL_TEXT = "Preserve this synthetic conversation through model changes.";
const INITIAL = {
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-6-astra", "gpt-5.6-sol"],
  openrouter: ["fixture/primary", "fixture/secondary"],
};
type Grants = typeof INITIAL;
type Selection = { instanceId: string; model: string; effort?: string; variant?: string };
type SavedTask = {
  threadId: string; title: string; modelSelection: Selection;
  resumeCursors: Record<string, unknown>; lastInstanceId?: string; rewound?: boolean;
};
type SavedBot = { id: string; threadId: string; name: string; modelSelection: Selection; tasks: SavedTask[] };

let fixture: VerificationServer | undefined;
let child: ChildProcess | undefined;
let layer: string | undefined;
let primary: SavedBot;
let beforeTasks: SavedTask[];
let history: Record<string, any>;
const ids: Record<string, string> = {};
const openRouterHistory: Record<string, Record<string, any>> = {};
const evidence: unknown[] = [];

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture!.info.url}${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as Record<string, any>;
  evidence.push({ method, path, status: response.status, body: result });
  return { status: response.status, body: result, headers: response.headers };
}

async function bots(): Promise<SavedBot[]> {
  const result = await api("GET", "/api/bots?messages=0");
  expect(result.status).toBe(200);
  return result.body.bots;
}

async function create(name: string, modelSelection?: Selection): Promise<SavedBot> {
  const result = await api("POST", "/api/bots", { name, ...(modelSelection ? { modelSelection } : {}) });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  ids[name] = result.body.bot.id;
  return result.body.bot;
}

async function restart(grants: Grants) {
  await waitForExit(child, { signal: "SIGTERM" });
  const owned = fixture!;
  const log = openSync(owned.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: {
      ...verificationServerEnvironment({}, owned.info.dataDir, Number(new URL(owned.info.url).port)),
      FAKE_CLAUDE_TEXT_DUMP: join(owned.info.dataDir, "fake-claude-helper-dump.json"),
      OMB_ENTERPRISE_DIR: layer, OMB_LICENSE_KEY: "fixture-only",
      OMB_ADMIN_URL: "https://admin.example.test", OMB_ADMIN_WORKSPACE: "fixture",
      OMB_PUBLIC_URL: "https://fixture.example.test", OMB_ADMIN_MEMBERSHIP: "portal",
      OMB_HOSTED_MODELS: JSON.stringify(grants), OMB_HOSTED_MODEL_TOKEN: TOKEN,
      OMB_HOSTED_CLAUDE_CLI: join(ROOT, "server/testing/fake-claude-cli.ts"),
      OMB_HOSTED_CODEX_CLI: join(ROOT, "server/testing/fake-codex-app-server.ts"),
    },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  await vi.waitFor(async () => {
    if (child!.exitCode !== null || child!.signalCode !== null) {
      throw new Error(`Owned hosted-model fixture exited; see ${owned.info.logPath}`);
    }
    const response = await fetch(`${owned.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
    expect(response.status).toBe(200);
    expect((await response.json() as { pid?: number }).pid).toBe(child!.pid);
  }, { timeout: 20_000, interval: 100 });
}

async function expectCatalog(grants: Grants) {
  const response = await api("GET", "/api/instances");
  expect(response.status).toBe(200);
  const instances = response.body.instances as Array<{
    instanceId: string; driverKind: string; readOnly?: boolean;
    models: { default: string; options: Array<{ id: string }> };
  }>;
  const expected = [
    { id: "claude", driver: "claudeAgent", models: grants.anthropic },
    { id: "codex", driver: "codex", models: grants.openai },
    { id: "opencode", driver: "openai-compat", models: grants.openrouter },
  ].filter((entry) => entry.models.length);
  expect(instances.map((entry) => entry.instanceId).sort()).toEqual(expected.map((entry) => entry.id).sort());
  for (const entry of expected) {
    const instance = instances.find((candidate) => candidate.instanceId === entry.id)!;
    expect(instance).toMatchObject({ driverKind: entry.driver, readOnly: true });
    expect(instance.models.default).toBe(entry.models[0]);
    expect(instance.models.options.map((option) => option.id)).toEqual(entry.models);
  }
  expect(JSON.stringify(response.body)).not.toContain(TOKEN);
}

beforeAll(async () => {
  layer = mkdtempSync(join(tmpdir(), "omb-hosted-model-layer-"));
  mkdirSync(join(layer, "server"));
  writeFileSync(join(layer, "server/index.ts"), `
    import { createWorkspaceAccess as create } from ${JSON.stringify(pathToFileURL(join(ROOT, "enterprise/server/workspace-access.ts")).href)};
    export function register() { return { customer: "Hosted models fixture", features: ["admin"], expiresAt: null }; }
    export function createWorkspaceAccess(options) {
      return create({ ...options, fetchImpl: async () => { throw new Error("The model fixture must not contact a portal"); } });
    }
  `);
  fixture = await launchVerificationServer({}, undefined, undefined, undefined,
    { dir: layer, licenseKey: "fixture-only" }, undefined, ["codex"]);
  child = fixture.child;
  primary = await create("Stale selections");
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture!.info.url]);
  evidence.push({ command: "send", result: await control(["send", "--bot", primary.id,
    "--task", primary.threadId, "--text", ORIGINAL_TEXT]) });
  const settled = await control(["wait", "--bot", primary.id, "--task", primary.threadId, "--timeout", "15"]);
  evidence.push({ command: "wait", result: settled });
  expect(settled).toMatchObject({ status: "settled" });
  history = (await api("GET", `/api/threads/${primary.threadId}/messages?limit=50`)).body;
  expect(JSON.stringify(history)).toContain("hello from fake claude");
  for (const title of ["Keep valid selection", "Legacy OpenRouter task", "Revoked OpenAI task", "Raw OpenRouter variant task", "Raw OpenRouter effort task"]) {
    expect((await api("POST", `/api/bots/${primary.id}/tasks`, { title })).status).toBe(201);
  }
  await create("Valid choice", { instanceId: "codex", model: INITIAL.openai[1], effort: "high" });
  await create("Legacy OpenAI", { instanceId: "codex", model: `omb-managed-openai::${INITIAL.openai[1]}` });
  await create("Legacy OpenRouter", { instanceId: "opencode", model: `omb-managed-openrouter/${INITIAL.openrouter[1]}` });
  for (const [name, metadata] of [["Raw OpenRouter variant", { variant: "high" }], ["Raw OpenRouter effort", { effort: "high" }]] as const) {
    const bot = await create(name, { instanceId: "opencode", model: INITIAL.openrouter[1], ...metadata });
    openRouterHistory[name] = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body;
  }
  await create("Personal provider", { instanceId: "personal", model: "personal-model" });

  // Seed a prior release's saved selections only after the owned server exits.
  await waitForExit(child, { signal: "SIGTERM" });
  const botsPath = join(fixture.info.dataDir, "bots.json");
  const saved = JSON.parse(readFileSync(botsPath, "utf8")) as SavedBot[];
  for (const bot of saved) for (const task of bot.tasks) {
    task.resumeCursors = { [task.modelSelection.instanceId]: "synthetic-old-provider-session" };
    task.lastInstanceId = task.modelSelection.instanceId;
  }
  const stale = saved.find((bot) => bot.id === primary.id)!;
  stale.modelSelection = { instanceId: "claude", model: "claude-retired" };
  stale.tasks.find((task) => task.threadId === primary.threadId)!.modelSelection = { instanceId: "claude", model: INITIAL.anthropic[1] };
  stale.tasks.find((task) => task.title === "Revoked OpenAI task")!.modelSelection = { instanceId: "codex", model: "gpt-retired" };
  stale.tasks.find((task) => task.title === "Keep valid selection")!.modelSelection = { instanceId: "codex", model: INITIAL.openai[1], effort: "high" };
  stale.tasks.find((task) => task.title === "Legacy OpenRouter task")!.modelSelection = { instanceId: "opencode", model: `omb-managed-openrouter/${INITIAL.openrouter[1]}` };
  stale.tasks.find((task) => task.title === "Raw OpenRouter variant task")!.modelSelection = { instanceId: "opencode", model: INITIAL.openrouter[1], variant: "high" };
  stale.tasks.find((task) => task.title === "Raw OpenRouter effort task")!.modelSelection = { instanceId: "opencode", model: INITIAL.openrouter[1], effort: "high" };
  beforeTasks = structuredClone(stale.tasks);
  writeFileSync(botsPath, JSON.stringify(saved));
  const configPath = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.defaultModelSelection = { instanceId: "opencode", model: INITIAL.openrouter[1], variant: "high" };
  config.instances.personal = { driver: "fixture-unavailable-driver" };
  config.instances.claude.config.cli = "fixture-personal-cli-must-not-run";
  config.instances.codex.config.cli = "fixture-personal-cli-must-not-run";
  config.anthropic = { key: "synthetic-personal-key", url: "https://personal.example.test" };
  writeFileSync(configPath, JSON.stringify(config));
  await restart(INITIAL);
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (fixture) {
    const evidencePath = `${fixture.info.logPath}.hosted-models.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
  if (layer) await removeTempDir(layer);
});

describe("hosted model policy in the full runtime", () => {
  it("advertises only assignments and reconciles saved choices without changing conversation history", async () => {
    await expectCatalog(INITIAL);
    const health = await api("GET", "/api/health/hosted");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-omb-hosted-model-policy")).toBe("1");
    const current = await bots();
    const stale = current.find((bot) => bot.id === primary.id)!;
    expect(stale.modelSelection).toEqual({ instanceId: "claude", model: INITIAL.anthropic[0] });
    expect(stale.tasks.map((task) => ({ threadId: task.threadId, title: task.title })))
      .toEqual(beforeTasks.map((task) => ({ threadId: task.threadId, title: task.title })));
    expect(stale.tasks.find((task) => task.threadId === primary.threadId)!.modelSelection)
      .toEqual({ instanceId: "claude", model: INITIAL.anthropic[1] });
    expect(stale.tasks.find((task) => task.title === "Revoked OpenAI task")!.modelSelection)
      .toEqual({ instanceId: "codex", model: INITIAL.openai[0] });
    expect(stale.tasks.find((task) => task.title === "Keep valid selection")!.modelSelection)
      .toEqual({ instanceId: "codex", model: INITIAL.openai[1], effort: "high" });
    expect(stale.tasks.find((task) => task.title === "Legacy OpenRouter task")!.modelSelection)
      .toEqual({ instanceId: "opencode", model: INITIAL.openrouter[1] });
    for (const title of ["Raw OpenRouter variant task", "Raw OpenRouter effort task"]) {
      expect(stale.tasks.find((task) => task.title === title)!.modelSelection)
        .toEqual({ instanceId: "opencode", model: INITIAL.openrouter[1] });
    }
    for (const [name, expected] of [
      ["Valid choice", { instanceId: "codex", model: INITIAL.openai[1], effort: "high" }],
      ["Legacy OpenAI", { instanceId: "codex", model: INITIAL.openai[1] }],
      ["Legacy OpenRouter", { instanceId: "opencode", model: INITIAL.openrouter[1] }],
      ["Raw OpenRouter variant", { instanceId: "opencode", model: INITIAL.openrouter[1] }],
      ["Raw OpenRouter effort", { instanceId: "opencode", model: INITIAL.openrouter[1] }],
      ["Personal provider", { instanceId: "claude", model: INITIAL.anthropic[0] }],
    ] as const) {
      const bot = current.find((candidate) => candidate.id === ids[name])!;
      expect(bot.modelSelection).toEqual(expected);
      expect(bot.tasks[0].modelSelection).toEqual(expected);
      if (openRouterHistory[name]) {
        expect((await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body).toEqual(openRouterHistory[name]);
      }
    }
    expect((await api("GET", `/api/threads/${primary.threadId}/messages?limit=50`)).body).toEqual(history);
    expect((await create("Default hosted bot")).modelSelection).toEqual({ instanceId: "opencode", model: INITIAL.openrouter[1] });
    const persisted = readFileSync(join(fixture!.info.dataDir, "config.json"), "utf8");
    expect(JSON.parse(persisted).defaultModelSelection).toEqual({ instanceId: "opencode", model: INITIAL.openrouter[1] });
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain("/api/gateway/");
    const migrated = JSON.parse(readFileSync(join(fixture!.info.dataDir, "bots.json"), "utf8")) as SavedBot[];
    for (const bot of migrated.filter((candidate) => candidate.id !== ids["Default hosted bot"])) {
      for (const task of bot.tasks) {
        expect(task.resumeCursors).toEqual({});
        expect(task.lastInstanceId).toBeUndefined();
        expect(task.rewound).toBe(true);
      }
    }
    expect(JSON.parse(readFileSync(join(fixture!.info.dataDir, "hosted-model-policy.json"), "utf8")))
      .toEqual({ version: 1, admin: "https://admin.example.test", workspace: "fixture" });
  });

  it("continues an existing Claude task through the managed route with its previous transcript replayed once", async () => {
    const control = (args: string[]) => runControlOmb([...args, "--url", fixture!.info.url]);
    evidence.push({ command: "hosted send", result: await control(["send", "--bot", primary.id,
      "--task", primary.threadId, "--text", "Continue this conversation after its managed model migration."]) });
    const settled = await control(["wait", "--bot", primary.id, "--task", primary.threadId, "--timeout", "15"]);
    evidence.push({ command: "hosted wait", result: settled });
    expect(settled).toMatchObject({ status: "settled" });
    const dump = JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8"));
    expect(dump.argv[dump.argv.indexOf("--model") + 1]).toBe(INITIAL.anthropic[1]);
    expect(dump.argv).not.toContain("--resume");
    expect(JSON.stringify(dump.prompt).split(ORIGINAL_TEXT)).toHaveLength(2);
    expect(dump.env.ANTHROPIC_BASE_URL).toBe("https://admin.example.test/api/gateway/fixture/anthropic");
    expect(dump.env.ANTHROPIC_API_KEY).toBe(TOKEN);
    const after = (await api("GET", `/api/threads/${primary.threadId}/messages?limit=50`)).body;
    const originalIds = new Set(history.messages.map((message: { id: string }) => message.id));
    expect(after.messages.filter((message: { id: string }) => originalIds.has(message.id))).toEqual(history.messages);
    expect(after.messages.length).toBeGreaterThan(history.messages.length);
    history = after;
    const persisted = JSON.parse(readFileSync(join(fixture!.info.dataDir, "bots.json"), "utf8")) as SavedBot[];
    const task = persisted.find((bot) => bot.id === primary.id)!.tasks.find((item) => item.threadId === primary.threadId)!;
    expect(task.modelSelection).toEqual({ instanceId: "claude", model: INITIAL.anthropic[1] });
    expect(task.resumeCursors.claude).toBeTruthy();
    expect(task.resumeCursors.claude).not.toBe("synthetic-old-provider-session");
    evidence.push({ hostedTurn: { model: task.modelSelection, replayCount: 1, resumed: false, cursorSaved: true } });
  });

  it("rejects explicit unassigned models and provider changes while allowing an assigned default", async () => {
    const before = await bots();
    for (const selection of [
      { instanceId: "codex", model: "gpt-unassigned" },
      { instanceId: "personal", model: "personal-model" },
      { instanceId: "claude", model: "claude-retired" },
    ]) {
      for (const [method, path] of [
        ["POST", "/api/bots"], ["PATCH", `/api/bots/${primary.id}`],
        ["PATCH", `/api/bots/${primary.id}/tasks/${primary.threadId}`],
      ]) {
        const denied = await api(method, path, { modelSelection: selection });
        expect(denied.status, `${method} ${path}: ${JSON.stringify(denied.body)}`).toBe(400);
      }
      expect((await api("PUT", "/api/config", { defaultModelSelection: selection })).status).toBe(400);
    }
    const configBefore = readFileSync(join(fixture!.info.dataDir, "config.json"), "utf8");
    for (const [method, path, body] of [
      ["PATCH", "/api/instances/claude", { cli: "fixture-forbidden-cli" }],
      ["POST", "/api/instances/claude/auth/start", {}],
      ["POST", "/api/instances/codex/auth/sign-out", {}],
      ["POST", "/api/instances/claude-accounts", { displayName: "Personal account" }],
      ["DELETE", "/api/instances/claude", {}],
      ["PUT", "/api/config", { anthropic: { key: "synthetic-forbidden-key" } }],
      ["PATCH", "/api/config", { openaiCompat: { url: "https://personal.example.test" } }],
      ["PUT", "/api/config", { opencodeGo: { apiKey: "synthetic-forbidden-key" } }],
    ] as const) {
      const denied = await api(method, path, body);
      expect(denied.status, `${method} ${path}: ${JSON.stringify(denied.body)}`).toBe(403);
    }
    expect(await bots()).toEqual(before);
    expect(readFileSync(join(fixture!.info.dataDir, "config.json"), "utf8")).toBe(configBefore);
    const selected = { instanceId: "codex", model: INITIAL.openai[1] };
    expect((await api("PUT", "/api/config", { defaultModelSelection: selected })).status).toBe(200);
    expect((await create("Assigned default")).modelSelection).toEqual(selected);
    await expectCatalog(INITIAL);
  });

  it("resets native continuation handles for both compatibility model-switch endpoints", async () => {
    const bot = await create("Compatibility model switches", { instanceId: "claude", model: INITIAL.anthropic[0] });
    const control = (args: string[]) => runControlOmb([...args, "--url", fixture!.info.url]);
    for (const [path, model] of [
      [`/api/bots/${bot.id}/model`, INITIAL.anthropic[1]],
      [`/api/bots/${bot.id}`, INITIAL.anthropic[0]],
    ]) {
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Remember this synthetic message before switching models."]);
      expect(await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "15"])).toMatchObject({ status: "settled" });
      const botPath = join(fixture!.info.dataDir, "bots.json");
      const before = JSON.parse(readFileSync(botPath, "utf8")) as SavedBot[];
      expect(before.find(row => row.id === bot.id)!.tasks[0].resumeCursors.claude).toBeTruthy();
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body;
      const modelSelection = { instanceId: "claude", model };
      const result = await api("PATCH", path, path.endsWith("/model") ? modelSelection : { modelSelection });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const after = JSON.parse(readFileSync(botPath, "utf8")) as SavedBot[];
      const task = after.find(row => row.id === bot.id)!.tasks[0];
      expect(task.modelSelection).toEqual(modelSelection);
      expect(task.resumeCursors).toEqual({});
      expect(task.lastInstanceId).toBeUndefined();
      expect(task.rewound).toBe(true);
      expect((await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body).toEqual(messages);
    }
  }, 40_000);

  it("applies changed grants to existing bots and tasks after a fresh restart and persists the migration", async () => {
    const changed = { anthropic: [], openai: [INITIAL.openai[1]], openrouter: [] };
    await restart(changed);
    await expectCatalog(changed);
    for (const bot of await bots()) {
      expect(bot.modelSelection).toMatchObject({ instanceId: "codex", model: INITIAL.openai[1] });
      for (const task of bot.tasks) expect(task.modelSelection).toMatchObject({ instanceId: "codex", model: INITIAL.openai[1] });
    }
    expect((await api("GET", `/api/threads/${primary.threadId}/messages?limit=50`)).body).toEqual(history);
    const first = await bots();
    // A later managed session must survive an unchanged policy restart.
    await waitForExit(child, { signal: "SIGTERM" });
    const botsPath = join(fixture!.info.dataDir, "bots.json");
    const persisted = JSON.parse(readFileSync(botsPath, "utf8")) as SavedBot[];
    const validTask = persisted.find((bot) => bot.id === ids["Valid choice"])!.tasks[0];
    validTask.resumeCursors = { codex: "synthetic-current-managed-session" };
    validTask.lastInstanceId = "codex";
    writeFileSync(botsPath, JSON.stringify(persisted));
    await restart(changed);
    expect(await bots()).toEqual(first);
    const restarted = JSON.parse(readFileSync(botsPath, "utf8")) as SavedBot[];
    expect(restarted.find((bot) => bot.id === ids["Valid choice"])!.tasks[0]).toMatchObject({
      resumeCursors: { codex: "synthetic-current-managed-session" }, lastInstanceId: "codex",
    });
    expect((await api("GET", `/api/threads/${primary.threadId}/messages?limit=50`)).body).toEqual(history);
  }, 50_000);

  it("offers no personal fallback when the workspace has no assigned models", async () => {
    await restart({ anthropic: [], openai: [], openrouter: [] });
    await expectCatalog({ anthropic: [], openai: [], openrouter: [] });
    for (const selection of [
      { instanceId: "codex", model: INITIAL.openai[1] },
      { instanceId: "claude", model: "claude-sonnet-4-6" },
      { instanceId: "personal", model: "personal-model" },
    ]) {
      expect((await api("POST", "/api/bots", { name: "Must not use personal account", modelSelection: selection })).status).toBe(400);
    }
    const defaultBot = await api("POST", "/api/bots", { name: "No assigned default" });
    expect(defaultBot.status).toBeGreaterThanOrEqual(400);
    expect((await api("GET", `/api/threads/${primary.threadId}/messages?limit=50`)).body).toEqual(history);
  }, 30_000);
});
