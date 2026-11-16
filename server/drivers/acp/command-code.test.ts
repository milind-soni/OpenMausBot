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
import {
  classifyCommandCodeError, CommandCodeAgentDriver, commandCodeAuthFile, commandCodeSignedIn, forgetCommandCodeDiscoverySession,
  resolveCommandCodeModels,
} from "./command-code.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
// The session opens on the person's own default (command-code 1.88.4 opened on a DeepSeek model), not the list's first.
const MODELS = "deepseek/deepseek-v4.1-flash,claude-sonnet-5-5,gpt-6.1-sol";
const MODES = "default,auto-accept,plan,dont-ask,bypass";
const VARIANTS = JSON.stringify({
  "claude-sonnet-5-5": { id: "effort", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
});
const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";

describe("Command Code ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-command-code-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await CommandCodeAgentDriver.create({
      instanceId: `command-code-contract-${Math.random().toString(36).slice(2)}`, displayName: "Command Code", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_MODES: MODES, FAKE_ACP_VARIANTS: VARIANTS,
        FAKE_ACP_DUMP: join(scratch, "launch.json"), ...environment },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const prompts = () => readFileSync(join(scratch, "launch.json.prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const configCalls = () => JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: any }>;
  const signIn = (home: string, file: string, contents: string) => {
    mkdirSync(join(home, ".commandcode"), { recursive: true });
    writeFileSync(join(home, ".commandcode", file), contents);
  };

  it("is a built-in engine in fresh and existing fleets, beside a person's own custom Command Code instance", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "commandCodeAgent")).toBe(true);
    expect(instanceConfigs({}).commandCode?.driver).toBe("commandCodeAgent");
    const existing = instanceConfigs({ instances: {
      claude: { driver: "claudeAgent" },
      cmd: { driver: "customAcp", config: { cli: "cmd acp" } },
    } });
    expect(existing.commandCode?.driver).toBe("commandCodeAgent");
    expect(existing.cmd?.driver).toBe("customAcp");
    expect(CommandCodeAgentDriver.metadata.access).toBe("subscription");
    expect(CommandCodeAgentDriver.models).toEqual({ default: "agent-default", options: [{ id: "agent-default", label: "Command Code default" }] });
  });

  it("is signed in by the key `cmd login` stored or by COMMAND_CODE_API_KEY, and by nothing else", () => {
    const home = join(scratch, "home");
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(false);
    signIn(home, "auth.json", "{\"userName\":\"someone\"}");
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(false);
    signIn(home, "auth.json", "not json");
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(false);
    signIn(home, "auth.json", JSON.stringify({ apiKey: "fixture-key", userName: "someone" }));
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(true);
    // COMMANDCODE_API_ENV picks another account file, as the CLI does.
    expect(commandCodeAuthFile({ [homeVar]: home, COMMANDCODE_API_ENV: "staging" })).toBe(join(home, ".commandcode", "auth.staging.json"));
    expect(commandCodeSignedIn({ [homeVar]: home, COMMANDCODE_API_ENV: "staging" })).toBe(false);
    expect(commandCodeSignedIn({ [homeVar]: join(scratch, "empty"), COMMAND_CODE_API_KEY: "fixture-key" })).toBe(true);
    expect(commandCodeSignedIn({ [homeVar]: join(scratch, "empty"), COMMAND_CODE_API_KEY: "  " })).toBe(false);
  });

  it("lists the advertised models after Command Code's own default, each with its effort levels, without a prompt", async () => {
    const catalog = await resolveCommandCodeModels(
      { ...process.env, FAKE_ACP_MODELS: MODELS, FAKE_ACP_VARIANTS: VARIANTS }, { cli: FAKE_CLI });
    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...MODELS.split(",")]);
    expect(catalog.options.some((option) => option.custom)).toBe(false);
    expect(catalog.options.find((option) => option.id === "claude-sonnet-5-5")?.variants).toEqual([
      { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
    ]);
  });

  it("removes only the files the discovery session itself left in Command Code's projects", async () => {
    const home = join(scratch, "forget-home");
    const projects = join(home, ".commandcode", "projects");
    const file = (folder: string, name: string) => {
      mkdirSync(join(projects, folder), { recursive: true });
      writeFileSync(join(projects, folder, name), "{\"model\":\"gpt-6.1-sol\"}");
      return join(projects, folder, name);
    };
    // The folder names are command-code 1.88.4's slugs of the discovery's temporary cwd and of a real project.
    const ours = file("private-var-folders-t-omb-acp-models-1kng-q5", "c7b01536.meta.json");
    const sibling = file("private-var-folders-t-omb-acp-models-zz", "other.meta.json");
    const project = file("users-someone-code-app", "c7b01536.meta.json");
    await forgetCommandCodeDiscoverySession({ sessionId: "c7b01536", env: { [homeVar]: home } });
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(join(projects, "private-var-folders-t-omb-acp-models-1kng-q5"))).toBe(false);
    expect([existsSync(sibling), existsSync(project)]).toEqual([true, true]);
    await forgetCommandCodeDiscoverySession({ sessionId: "../../x", env: { [homeVar]: home } });
    await forgetCommandCodeDiscoverySession({ sessionId: "c7b01536", env: { [homeVar]: join(scratch, "no-home") } });
  });

  it("reads -32000 as a missing login only when Command Code says so", () => {
    expect(classifyCommandCodeError({ code: -32000, message: "Not authenticated. Run `cmd login` in a terminal first." })).toBe("invalid_credentials");
    expect(classifyCommandCodeError({ code: -32000, message: "Not authenticated. Run `cmd login` in a terminal, then retry." })).toBe("invalid_credentials");
    expect(classifyCommandCodeError({ code: -32000, message: "session already active" })).toBeUndefined();
    expect(classifyCommandCodeError({ code: -32603, message: "Not authenticated" })).toBeUndefined();
    expect(classifyCommandCodeError(null)).toBeUndefined();
  });

  it("starts nothing when the instance is created, so a `command-code` on PATH costs no launch", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
    expect(instance!.models.default).toBe("agent-default");
  });

  it("runs `command-code acp` on the picked model, through ACP, in the mode that leaves approvals to the app", async () => {
    const { instance, recorder } = await create({ COMMAND_CODE_API_KEY: "engine-fixture-key" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "command-code-chat", text: "hello", model: "claude-sonnet-5-5", approvalMode: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "commandCodeAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv.at(-1)).toBe("acp");
    expect(launch.env.COMMAND_CODE_API_KEY).toBe("engine-fixture-key");
    expect(configCalls().filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId)).toEqual(["default"]);
    expect(prompts().at(-1)).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("starts a fresh `command-code acp` when the app's MCP bearer changes, since a live session/load keeps the old one", async () => {
    const launches = join(scratch, "launches");
    const { instance, recorder } = await create({ FAKE_ACP_LAUNCH_COUNT_FILE: launches });
    const launchCount = () => Number(readFileSync(launches, "utf8"));
    const agents = (token: string) => ({
      command: process.execPath,
      args: ["/app/dist-server/agents-proxy.js"],
      env: { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_COMMS_TOKEN: token, OMB_BOT_ID: "sprout", OMB_THREAD_ID: "command-code-bearer" },
    });
    const turn = async (text: string, token: string, resume: boolean) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "command-code-bearer", text, model: "agent-default", approvalMode: "ask",
        ...(resume ? { resumeCursor: "fake-acp-session" } : {}), integrations: { agents: agents(token) },
      });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    };
    await turn("open the portal", "token-one", false);
    const afterFirst = launchCount();
    await turn("signed in, carry on", "token-two", true);
    expect(launchCount()).toBe(afterFirst + 1);
    await turn("same bearer", "token-two", true);
    expect(launchCount()).toBe(afterFirst + 1);
  });

  it("leaves Command Code on its own default model, and runs Bypass Permissions only under Full access", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "command-code-full", text: "hello", model: "agent-default", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(configCalls().some((call) => call.method === "session/set_config_option" && call.params.configId === "model")).toBe(false);
    expect(configCalls().filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId)).toEqual(["bypass"]);
    expect(prompts().at(-1)).toMatchObject({ model: "deepseek/deepseek-v4.1-flash" });
  });

  it("turns Command Code's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "command-code-permission", text: "edit", model: "agent-default", approvalMode: "ask" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("commandCodeAgent");
    expect(await instance.adapter.respondToRequest("command-code-permission", ask.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(readFileSync(answer, "utf8")).toBe("reject");
  });
});
