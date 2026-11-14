import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { ClineAgentDriver } from "./cline.ts";
import { supportsApprovalMode } from "../../../shared/approval-mode.ts";
import { assertToolScopeSupported } from "../../../shared/tool-scope-support.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

describe("Cline ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-cline-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  async function create(mode = "happy") {
    const dir = join(scratch, "cline", "settings");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "providers.json"))) writeFileSync(join(dir, "providers.json"), JSON.stringify({
      version: 1, lastUsedProvider: "openai-compatible",
      providers: { "openai-compatible": { settings: { provider: "openai-compatible", model: "fixture-model", apiKey: "saved-fixture-key" } } },
    }));
    instance = await ClineAgentDriver.create({
      instanceId: "cline-contract", displayName: "Cline", enabled: true,
      environment: { CLINE_DATA_DIR: join(scratch, "cline"), FAKE_ACP_MODE: mode, FAKE_ACP_DUMP: join(scratch, "launch.json"), FAKE_ACP_PERMISSION_ANSWER: join(scratch, "permission.txt") },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  it("is discoverable in fresh and existing product fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "clineAgent")).toBe(true);
    expect(instanceConfigs({}).cline?.driver).toBe("clineAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).cline?.driver).toBe("clineAgent");
    expect(instanceConfigs({ instances: { fixture: { driver: "fake" } } }).cline).toBeUndefined();
    expect(ClineAgentDriver.models.options).toContainEqual({ id: "cline-default", label: "Cline default (configured)" });
  });

  it("preserves Cline's configured provider and mounts scoped team tools", async () => {
    const { instance, recorder } = await create();
    vi.stubEnv("CLINE_API_KEY", "cline-fixture-key");
    vi.stubEnv("OMB_LICENSE_KEY", "operator-fixture-secret");
    vi.stubEnv("BOX_TOKEN", "workspace-fixture-secret");
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "cline-chat", text: "hello", model: "cline-default", approvalMode: "ask",
      integrations: { agents: { command: "fixture-mcp", args: ["agents"], env: { TOKEN: "turn-fixture-token" } } },
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(true);
    expect(recorder.events.every((event) => event.provider === "clineAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toContain("--acp");
    expect(launch.argv.slice(launch.argv.indexOf("--auto-approve"), launch.argv.indexOf("--auto-approve") + 2)).toEqual(["--auto-approve", "false"]);
    expect(launch.argv).not.toContain("cline-default");
    expect(launch.argv).not.toContain("--provider");
    expect(launch.env.CLINE_API_KEY).toBe("cline-fixture-key");
    expect(launch.env.OMB_LICENSE_KEY).toBeUndefined();
    expect(launch.env.BOX_TOKEN).toBeUndefined();
    const session = JSON.parse(readFileSync(join(scratch, "launch.json.session.json"), "utf8"));
    expect(session.mcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "agents" })]));
  });

  it("reuses the saved API provider and model without rewriting Cline settings", async () => {
    const { instance, recorder } = await create();
    const path = join(scratch, "cline", "settings", "providers.json");
    const before = readFileSync(path, "utf8");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cline-saved", text: "hello" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.env.CLINE_PROVIDER).toBe("openai-compatible");
    expect(launch.env.CLINE_MODEL).toBe("fixture-model");
    expect(launch.env.CLINE_API_KEY).toBe("saved-fixture-key");
    const calls = JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8"));
    expect(calls).toContainEqual({ method: "session/set_model", params: { sessionId: expect.any(String), modelId: "fixture-model" } });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("isolates native MCP settings by thread, removes revoked tools and leaves the user's settings intact", async () => {
    const ambient = join(scratch, "user-mcp.json");
    const before = '{"mcpServers":{"private-server":{"command":"must-not-run"}}}';
    writeFileSync(ambient, before);
    vi.stubEnv("CLINE_MCP_SETTINGS_PATH", ambient);
    const { instance, recorder } = await create();
    const run = async (threadId: string, integrations?: Parameters<typeof instance.adapter.sendTurn>[0]["integrations"], toolScope?: Parameters<typeof instance.adapter.sendTurn>[0]["toolScope"]) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hello", integrations, toolScope });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const path = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8")).env.CLINE_MCP_SETTINGS_PATH as string;
      return { path, settings: JSON.parse(readFileSync(path, "utf8")) };
    };
    const first = await run("cline-one", {
      agents: { command: "fixture-mcp", args: [], env: { TOKEN: "first-fixture-token" } },
      custom: { hidden: { command: "must-not-run", args: [], env: {} } },
    }, { allow: ["native:*", "mcp:agents:*"] });
    expect(Object.keys(first.settings.mcpServers)).toEqual(["agents"]);
    expect(JSON.stringify(first.settings)).toContain("first-fixture-token");
    expect(first.path).not.toBe(ambient);
    const second = await run("cline-two");
    expect(second.path).not.toBe(first.path);
    expect(second.settings).toEqual({ mcpServers: {} });
    expect(readFileSync(first.path, "utf8")).toContain("first-fixture-token");
    const revoked = await run("cline-one", { agents: { command: "fixture-mcp", args: [], env: { TOKEN: "second-fixture-token" } } }, { allow: ["native:*"] });
    expect(revoked.path).toBe(first.path);
    expect(revoked.settings).toEqual({ mcpServers: {} });
    expect(readFileSync(ambient, "utf8")).toBe(before);
    await instance.dispose();
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  it("fails the turn rather than silently using a fallback model", async () => {
    const { instance, recorder } = await create("set-model-invalid-params");
    await instance.adapter.sendTurn({ threadId: "cline-model-refused", text: "hello", model: "cline-default" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
  });

  it("refuses a malformed saved provider before dispatching a prompt", async () => {
    const dir = join(scratch, "cline", "settings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "providers.json"), '{"version":1,"lastUsedProvider":"missing","providers":[]}');
    const { instance, recorder } = await create();
    await instance.adapter.sendTurn({ threadId: "cline-unconfigured", text: "hello" });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });

  it("rejects malformed OAuth credentials without throwing or starting interactive login", async () => {
    const dir = join(scratch, "cline", "settings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ version: 1, lastUsedProvider: "cline", providers: {
      cline: { settings: { provider: "cline", auth: { accessToken: {} } } },
    } }));
    const { instance, recorder } = await create();
    await instance.adapter.sendTurn({ threadId: "cline-bad-oauth", text: "hello" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("stops when the selected OAuth account cannot authenticate", async () => {
    const dir = join(scratch, "cline", "settings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ version: 1, lastUsedProvider: "cline", providers: {
      cline: { settings: { provider: "cline", auth: { accessToken: "fixture-token" } } },
      "openai-codex": { settings: { provider: "openai-codex", auth: { accessToken: "other-fixture-token" } } },
    } }));
    vi.stubEnv("FAKE_ACP_AUTH_METHOD", "cline");
    const { instance, recorder } = await create("authenticate-failed");
    await instance.adapter.sendTurn({ threadId: "cline-expired", text: "hello" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
    expect(existsSync(join(scratch, "launch.json.session.json"))).toBe(false);
    await expect(instance.generateMemoryText!("remember this")).rejects.toThrow("not configured");
  });

  it("uses the configured model for tool-free memory upkeep too", async () => {
    const { instance } = await create();
    vi.stubEnv("FAKE_ACP_TEXT_REPLY", "memory fixture");
    expect(await instance.generateMemoryText!("remember this")).toBe("memory fixture");
    expect(JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8"))).toContainEqual({
      method: "session/set_model", params: { sessionId: expect.any(String), modelId: "fixture-model" },
    });
  });

  it("does not execute a permission request after the user rejects it", async () => {
    const { instance, recorder } = await create("permission");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cline-deny", text: "edit", approvalMode: "ask" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(await instance.adapter.respondToRequest("cline-deny", ask.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(readFileSync(join(scratch, "permission.txt"), "utf8")).toBe("reject");
  });

  it("keeps ACP permissions under Full access and cannot inherit a native grant on the next Ask turn", async () => {
    expect(supportsApprovalMode("clineAgent", "full")).toBe(true);
    const { instance, recorder } = await create("permission");
    const first = await instance.adapter.sendTurn({ threadId: "cline-policy", text: "edit", approvalMode: "full" });
    const fullAsk = await recorder.until((event) => event.type === "request.opened" && event.turnId === first.turnId);
    // The native process must still ask, so no provider-wide auto-approval can outlive the turn.
    await instance.adapter.respondToRequest("cline-policy", fullAsk.requestId!, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toContain("false");
    const second = await instance.adapter.sendTurn({ threadId: "cline-policy", text: "edit again", approvalMode: "ask" });
    const ask = await recorder.until((event) => event.type === "request.opened" && event.turnId === second.turnId);
    await instance.adapter.respondToRequest("cline-policy", ask.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
  });

  it("settles a cancelled native turn", async () => {
    const { instance, recorder } = await create("hang");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cline-stop", text: "wait" });
    await recorder.until((event) => event.type === "session.started");
    await instance.adapter.interruptTurn("cline-stop");
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ stopReason: "cancelled" });
  });

  it("reports a missing CLI as unavailable", async () => {
    instance = await ClineAgentDriver.create({
      instanceId: "cline-missing", displayName: "Cline", enabled: true, environment: {},
      config: { cli: join(scratch, "missing-cline"), fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("supports MCP selection without claiming it can suppress native Cline tools", () => {
    expect(assertToolScopeSupported("clineAgent", { allow: ["native:*", "mcp:agents:*" ] })).toBeDefined();
    expect(() => assertToolScopeSupported("clineAgent", { allow: ["mcp:agents:*" ] })).toThrow(/native tool selection/);
  });
});
