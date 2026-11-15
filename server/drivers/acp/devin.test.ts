import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { classifyDevinError, DevinAgentDriver, devinConfigDir, devinPermissionRequest, devinSignedIn, resolveDevinModels } from "./devin.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const MODELS = "swe-1-6-fast,claude-sonnet-5-5";
const MODES = "accept-edits,smart,ask,plan,bypass";

describe("Devin sign-in", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-devin-sign-in-"));
  });
  afterEach(async () => {
    await removeTempDir(scratch);
  });

  it("looks for Devin's config in %APPDATA% on Windows and ~/.config elsewhere", () => {
    const home = join(scratch, "home");
    expect(devinConfigDir({ HOME: home }, "linux")).toBe(join(home, ".config", "devin"));
    expect(devinConfigDir({ HOME: home }, "darwin")).toBe(join(home, ".config", "devin"));
    expect(devinConfigDir({ HOME: home, XDG_CONFIG_HOME: join(scratch, "cfg") }, "linux")).toBe(join(scratch, "cfg", "devin"));
    expect(devinConfigDir({ USERPROFILE: home, APPDATA: join(scratch, "roaming") }, "win32")).toBe(join(scratch, "roaming", "devin"));
  });

  it("is signed in by the credentials `devin auth login` stored, or by WINDSURF_API_KEY", () => {
    const home = join(scratch, "home");
    expect(devinSignedIn({ HOME: home }, "linux")).toBe(false);
    expect(devinSignedIn({ HOME: home, WINDSURF_API_KEY: "  " }, "linux")).toBe(false);
    expect(devinSignedIn({ HOME: home, WINDSURF_API_KEY: "fixture-key" }, "linux")).toBe(true);
    const dir = devinConfigDir({ HOME: home }, "linux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    expect(devinSignedIn({ HOME: home }, "linux")).toBe(false);
    writeFileSync(join(dir, "credentials.toml"), "token = \"fixture\"\n");
    expect(devinSignedIn({ HOME: home }, "linux")).toBe(true);
  });

  it("reads Devin's signed-out prompt refusal as a missing login, and nothing else", () => {
    expect(classifyDevinError({ code: -32000, message: "Please log in to use Devin. Use `/login` to authenticate again." })).toBe("invalid_credentials");
    expect(classifyDevinError({ code: -32000, message: "MCP server telegram: please log in" })).toBeUndefined();
    expect(classifyDevinError({ code: -32603, message: "Please log in to use Devin." })).toBeUndefined();
  });
});

describe("Devin permission requests", () => {
  const request = {
    sessionId: "s1",
    toolCall: { toolCallId: "call_1", _meta: { "cognition.ai/editableCommand": "curl -s https://example.com", "cognition.ai/permissionRule": "Exec(curl)" } },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_session", name: "Yes, allow `curl` commands (this session)", kind: "allow_always" },
      { optionId: "allow_always", name: "Yes, always allow `curl` commands in `project`", kind: "allow_always" },
      { optionId: "allow_always_global", name: "Yes, always allow `curl` commands in all projects", kind: "allow_always" },
      { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  };

  it("keeps only the grants that end with the session, whatever order Devin lists them in", () => {
    for (const options of [request.options, [...request.options].reverse()]) {
      expect(devinPermissionRequest({ ...request, options }).options.map((option: { optionId: string }) => option.optionId).sort())
        .toEqual(["allow_once", "allow_session", "reject_once"]);
    }
  });

  it("names the command Devin asks to run on the card", () => {
    expect(devinPermissionRequest(request).toolCall).toMatchObject({
      toolCallId: "call_1", kind: "execute", title: "curl -s https://example.com", rawInput: { command: "curl -s https://example.com" },
    });
    const edit = { toolCallId: "call_2", kind: "edit", title: "Edit a.ts" };
    expect(devinPermissionRequest({ ...request, toolCall: edit }).toolCall).toBe(edit);
  });
});

describe("Devin ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-devin-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await DevinAgentDriver.create({
      instanceId: `devin-contract-${Math.random().toString(36).slice(2)}`, displayName: "Devin", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_MODES: MODES,
        FAKE_ACP_DUMP: join(scratch, "launch.json"), WINDSURF_API_KEY: "engine-fixture-key", ...environment },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const prompts = () => readFileSync(join(scratch, "launch.json.prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const configCalls = () => JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: any }>;
  const modeCalls = () => configCalls().filter((call) => call.params.configId === "mode").map((call) => call.params.value);

  it("is a built-in engine in fresh and existing fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "devinAgent")).toBe(true);
    expect(instanceConfigs({}).devin?.driver).toBe("devinAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).devin?.driver).toBe("devinAgent");
    expect(DevinAgentDriver.metadata.displayName).toBe("Devin");
    expect(DevinAgentDriver.models).toEqual({ default: "agent-default", options: [{ id: "agent-default", label: "Devin default" }] });
  });

  it("lists the advertised models after Devin's own default", async () => {
    const catalog = await resolveDevinModels({ ...process.env, FAKE_ACP_MODELS: MODELS }, { cli: FAKE_CLI });
    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...MODELS.split(",")]);
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("runs `devin acp` on the picked model in Code mode on Ask", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "devin-ask", text: "hello", model: "claude-sonnet-5-5", approvalMode: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "devinAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv.at(-1)).toBe("acp");
    expect(launch.env.WINDSURF_API_KEY).toBe("engine-fixture-key");
    expect(modeCalls()).toEqual(["accept-edits"]);
    expect(prompts().at(-1)).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("leaves Devin on its own default model, and bypasses permissions only under Full access", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "devin-full", text: "hello", model: "agent-default", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(configCalls().some((call) => call.params.configId === "model")).toBe(false);
    expect(modeCalls()).toEqual(["bypass"]);
  });

  it("fails the turn instead of prompting when Devin does not confirm the permission mode", async () => {
    const ack = join(scratch, "mode-ack.txt");
    writeFileSync(ack, "empty");
    const { instance, recorder } = await create({ FAKE_ACP_MODE_ACK_FILE: ack });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "devin-unconfirmed", text: "hello", model: "agent-default", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(existsSync(join(scratch, "launch.json.prompts.jsonl"))).toBe(false);
  });
});
