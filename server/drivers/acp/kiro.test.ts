import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { KiroAgentDriver, kiroDataDir, kiroSignedIn, kiroUpdateFilter, resolveKiroModels } from "./kiro.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const MODELS = "auto,claude-sonnet-5-5,gpt-6.1-sol";
const VARIANTS = JSON.stringify({
  "claude-sonnet-5-5": { id: "effortLevel", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
});

/** Writes Kiro's sign-in store as kiro-cli 3.1.0 lays it out: an `auth_kv` table of key and value rows. */
function writeStore(dir: string, rows: Array<[string, string]>): void {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "data.sqlite3"));
  try {
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
    for (const [key, value] of rows) insert.run(key, value);
  } finally {
    db.close();
  }
}

describe("Kiro sign-in", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-kiro-sign-in-"));
  });
  afterEach(async () => {
    await removeTempDir(scratch);
  });

  it("looks for Kiro's store in the system's local data folder on each platform", () => {
    const home = join(scratch, "home");
    expect(kiroDataDir({ HOME: home }, "darwin")).toBe(join(home, "Library", "Application Support", "kiro-cli"));
    expect(kiroDataDir({ HOME: home }, "linux")).toBe(join(home, ".local", "share", "kiro-cli"));
    expect(kiroDataDir({ HOME: home, XDG_DATA_HOME: join(scratch, "data") }, "linux")).toBe(join(scratch, "data", "kiro-cli"));
    expect(kiroDataDir({ USERPROFILE: home, LOCALAPPDATA: join(scratch, "local") }, "win32")).toBe(join(scratch, "local", "kiro-cli"));
  });

  it("is signed in by a token `kiro-cli login` stored, or by KIRO_API_KEY, and by nothing else", () => {
    const home = join(scratch, "home");
    const env = { HOME: home };
    expect(kiroSignedIn(env, "linux")).toBe(false);
    // Kiro's own agent settings are not a sign-in.
    mkdirSync(join(home, ".kiro"), { recursive: true });
    writeFileSync(join(home, ".kiro", "config.json"), "{}");
    expect(kiroSignedIn(env, "linux")).toBe(false);
    // A store holding only the device registration is what a started but unfinished login leaves.
    writeStore(kiroDataDir(env, "linux"), [["kirocli:odic:device-registration", "{\"client_id\":\"fixture\"}"]]);
    expect(kiroSignedIn(env, "linux")).toBe(false);
    expect(kiroSignedIn({ HOME: home, KIRO_API_KEY: "fixture-key" }, "linux")).toBe(true);
    expect(kiroSignedIn({ HOME: home, KIRO_API_KEY: "  " }, "linux")).toBe(false);
  });

  it("reads a Builder ID, Identity Center or social login token from the store", () => {
    for (const [index, key] of ["kirocli:odic:token", "kirocli:social:token", "codewhisperer:odic:token"].entries()) {
      const home = join(scratch, `home-${index}`);
      writeStore(kiroDataDir({ HOME: home }, "darwin"), [[key, "{\"access_token\":\"fixture\"}"]]);
      expect(kiroSignedIn({ HOME: home }, "darwin"), key).toBe(true);
      // The same store in another platform's folder is not this one's.
      expect(kiroSignedIn({ HOME: home }, "linux"), key).toBe(false);
    }
  });
});

describe("Kiro session updates", () => {
  it("hides Kiro's cloud-settings tool from its start to its end, and nothing after it", () => {
    const filter = kiroUpdateFilter();
    const cloud = { sessionUpdate: "tool_call", toolCallId: "cloud-1", title: "Fetching your cloud config", status: "in_progress", _meta: { kiro: { toolId: "fetch_cloud_config" } } };
    expect(filter(cloud)).toBeNull();
    expect(filter({ sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "in_progress" })).toBeNull();
    expect(filter({ sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "completed" })).toBeNull();
    // Once it ended, an update under the same id is the agent's own again.
    const later = { sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "completed" };
    expect(filter(later)).toBe(later);
    const work = { sessionUpdate: "tool_call", toolCallId: "write-1", title: "Write File", status: "in_progress" };
    expect(filter(work)).toBe(work);
  });

  it("cuts Kiro's steering echo out of the reply's text and keeps the text before it", () => {
    const filter = kiroUpdateFilter();
    const plain = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } };
    expect(filter(plain)).toBe(plain);
    expect(filter({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done. [STEERING steer-42] also do this" } }))
      .toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    expect(filter({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[STEERING steer-42] also do this" } })).toBeNull();
    // Only the reply is cut: the agent's reasoning may quote the marker.
    const thought = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[STEERING steer-42]" } };
    expect(filter(thought)).toBe(thought);
  });
});

describe("Kiro ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-kiro-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await KiroAgentDriver.create({
      instanceId: `kiro-contract-${Math.random().toString(36).slice(2)}`, displayName: "Kiro", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_VARIANTS: VARIANTS, FAKE_ACP_AUTOPILOT: "1",
        FAKE_ACP_DUMP: join(scratch, "launch.json"), KIRO_API_KEY: "engine-fixture-key", ...environment },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const prompts = () => readFileSync(join(scratch, "launch.json.prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const configCalls = () => JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: any }>;
  const autopilot = () => configCalls().filter((call) => call.params.configId === "autopilot").map((call) => call.params.value);

  it("is a built-in engine in fresh and existing fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "kiroAgent")).toBe(true);
    expect(instanceConfigs({}).kiro?.driver).toBe("kiroAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).kiro?.driver).toBe("kiroAgent");
    expect(KiroAgentDriver.metadata.displayName).toBe("Kiro");
    expect(KiroAgentDriver.models).toEqual({ default: "agent-default", options: [{ id: "agent-default", label: "Kiro default" }] });
  });

  it("lists the advertised models after Kiro's own default, each with its effort levels", async () => {
    const catalog = await resolveKiroModels({ ...process.env, FAKE_ACP_MODELS: MODELS, FAKE_ACP_VARIANTS: VARIANTS }, { cli: FAKE_CLI });
    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...MODELS.split(",")]);
    expect(catalog.options.find((option) => option.id === "claude-sonnet-5-5")?.variants).toEqual([
      { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
    ]);
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("runs Kiro's V3 engine over ACP on the picked model, with Autopilot off on Ask", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kiro-ask", text: "hello", model: "claude-sonnet-5-5", approvalMode: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "kiroAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv.slice(-3)).toEqual(["acp", "--agent-engine=v3", "--auth-method=cli"]);
    expect(launch.env.KIRO_API_KEY).toBe("engine-fixture-key");
    expect(autopilot()).toEqual(["off"]);
    expect(prompts().at(-1)).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("leaves Kiro on its own default model, and turns Autopilot on only under Full access", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kiro-full", text: "hello", model: "agent-default", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(configCalls().some((call) => call.params.configId === "model")).toBe(false);
    expect(autopilot()).toEqual(["on"]);
    expect(prompts().at(-1)).toMatchObject({ model: "auto" });
  });

  it("shows neither Kiro's cloud-settings tool nor its steering echo in a turn", async () => {
    const updates = join(scratch, "updates.json");
    writeFileSync(updates, JSON.stringify([
      { update: { sessionUpdate: "tool_call", toolCallId: "cloud-1", title: "Fetching your cloud config", kind: "other", status: "in_progress", _meta: { kiro: { toolId: "fetch_cloud_config" } } } },
      { update: { sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "completed" } },
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "visible reply" } } },
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " kept[STEERING steer-7] hidden note" } } },
    ]));
    const { instance, recorder } = await create({ FAKE_ACP_UPDATES_FILE: updates });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kiro-filter", text: "hello", model: "agent-default", approvalMode: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const text = recorder.events.filter((event) => event.type === "content.delta").map((event) => (event as { delta?: string }).delta ?? "").join("");
    expect(text).toContain("visible reply kept");
    expect(text).not.toContain("STEERING");
    expect(text).not.toContain("hidden note");
    expect(JSON.stringify(recorder.events)).not.toContain("cloud config");
  });

  it("turns Kiro's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kiro-permission", text: "edit", model: "agent-default", approvalMode: "ask" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("kiroAgent");
    expect(await instance.adapter.respondToRequest("kiro-permission", ask.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(readFileSync(answer, "utf8")).toBe("reject");
  });
});
