// omp's contract is exercised through a real subprocess speaking its JSONL
// dialect, not a child_process mock. spawnCli resolves the shebang through
// Node on Windows; all waits follow observable events, never sleeps.
import { randomUUID } from "node:crypto";
import { on } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  OmpDriver,
  fetchOmpModels,
  ompApprovalMode,
  ompApprovalRequest,
  ompAskAnswers,
  ompToolCall,
  ompUpdateCommand,
  parseOmpCatalog,
} from "./omp.ts";

// The npm freshness check is the network boundary; each test picks what the
// registry "says" (null is offline).
const release = vi.hoisted(() => ({ latest: null as string | null }));
vi.mock("./omp-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./omp-release.ts")>(),
  readLatestOmpRelease: async () => release.latest,
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-omp-cli.ts");
const APPROVALS: Array<[ApprovalMode | undefined, string]> = [
  ["ask", "always-ask"], ["auto", "always-ask"], ["custom", "always-ask"],
  [undefined, "always-ask"], ["edits", "write"], ["full", "yolo"],
];
const DumpRow = z.object({
  argv: z.array(z.string()).optional(),
  pid: z.number().optional(),
  lifecycle: z.string().optional(),
  envConfigured: z.array(z.string()).optional(),
  mcpConfig: z.object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    toolScope: z.unknown().optional(),
    scopeReadyPath: z.string().optional(),
    approvalMode: z.string().optional(),
    localProvider: z.object({ name: z.string(), baseUrl: z.string(), apiKey: z.string(), model: z.string() }).optional(),
  }).nullable().optional(),
  command: z.looseObject({ type: z.string(), id: z.string(), message: z.string().optional() }).optional(),
  state: z.object({ sessionFile: z.string().optional(), sessionId: z.string(), model: z.unknown().optional() }).optional(),
});

// Dump parsing is a test seam: validate the subprocess boundary once before
// callers assert the wire-level choices that affect the person or billing.
function readDump(path: string): Array<z.infer<typeof DumpRow>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => DumpRow.parse(JSON.parse(line)));
}

// Filesystem checkpoints prove subprocess delivery without sleeps or polling.
async function untilDump(path: string, predicate: (row: z.infer<typeof DumpRow>) => boolean): Promise<void> {
  const watcher = watch(dirname(path));
  const changes = on(watcher, "change");
  try {
    if (readDump(path).some(predicate)) return;
    for await (const _change of changes) {
      if (readDump(path).some(predicate)) return;
    }
  } finally {
    await changes.return?.();
    watcher.close();
  }
}

describe("ompApprovalMode", () => {
  it.each(APPROVALS)("maps %s to omp's %s policy", (mode, expected) => {
    expect(ompApprovalMode(mode)).toBe(expected);
  });
});

describe("parseOmpCatalog", () => {
  const models = { models: [
    { provider: "anthropic", id: "shared", name: "Claude", contextWindow: 200_000 },
    { provider: "openai", id: "shared", contextWindow: 128_000 },
    { provider: "x", id: "without-window", name: "", contextWindow: 0 },
  ] };

  it("keeps composite ids, labels and windows and defaults to omp's current listed model", () => {
    expect(parseOmpCatalog(models, { model: { provider: "openai", id: "shared" } })).toEqual({
      default: "openai/shared",
      options: [
        { id: "anthropic/shared", label: "Claude", custom: true, provider: "anthropic", contextWindow: 200_000 },
        { id: "openai/shared", label: "shared", custom: true, provider: "openai", contextWindow: 128_000 },
        { id: "x/without-window", label: "without-window", custom: true, provider: "x" },
      ],
    });
  });

  it("falls back to the first model when get_state is missing or names an unlisted model", () => {
    for (const state of [undefined, {}, { model: { provider: "openai", id: "missing" } }]) {
      expect(parseOmpCatalog(models, state).default).toBe("anthropic/shared");
    }
  });

  it("discards malformed rows instead of producing unusable picker ids", () => {
    expect(parseOmpCatalog({ models: [null, {}, { provider: "", id: "x" }, { provider: "x", id: 1 },
      { provider: "x", id: "usable", name: 42, contextWindow: -1 }] }, null)).toEqual({
      default: "x/usable", options: [{ id: "x/usable", label: "usable", provider: "x", custom: true }],
    });
  });

  it.each([undefined, null, "garbage", [], { models: [] }, { models: "not an array" }])("keeps an empty catalog for %j", (value) => {
    expect(parseOmpCatalog(value, null)).toEqual({ default: "", options: [] });
  });
});

describe("ompAskAnswers", () => {
  it("sends exact single labels, free text and unanswered questions in request order", () => {
    expect(ompAskAnswers([
      { id: "one", options: [{ label: "Blue" }] },
      { id: "two", options: [{ label: "Paris" }] },
      { id: "three", options: [{ label: "Yes" }] },
    ], { one: "Blue", two: "  Somewhere else  " })).toEqual([
      { id: "one", selectedOptions: ["Blue"] },
      { id: "two", selectedOptions: [], customInput: "Somewhere else" },
      { id: "three", selectedOptions: [] },
    ]);
  });

  it("reconstructs multi-select labels containing commas without swallowing unknown parts", () => {
    expect(ompAskAnswers([{ id: "multi", multi: true, options: [{ label: "Red, green" }, { label: "Blue" }] }],
      { multi: "Red, green, Blue, other, custom" })).toEqual([
      { id: "multi", selectedOptions: ["Red, green", "Blue"], customInput: "other, custom" },
    ]);
  });

  it("matches the card's trimmed and capped labels but returns the original omp labels", () => {
    const long = "L".repeat(140);
    expect(ompAskAnswers([
      { id: "trim", options: [{ label: "  Blue  " }] }, { id: "cap", options: [{ label: long }] },
    ], { trim: " Blue ", cap: "L".repeat(120) })).toEqual([
      { id: "trim", selectedOptions: ["  Blue  "] }, { id: "cap", selectedOptions: [long] },
    ]);
  });

  it("does not guess between labels rendered identically after trimming or capping", () => {
    const prefix = "X".repeat(120);
    expect(ompAskAnswers([
      { id: "trim", options: [{ label: " Blue" }, { label: "Blue " }] },
      { id: "cap", multi: true, options: [{ label: prefix + "a" }, { label: prefix + "b" }] },
    ], { trim: "Blue", cap: prefix })).toEqual([
      { id: "trim", selectedOptions: [], customInput: "Blue" },
      { id: "cap", selectedOptions: [], customInput: prefix },
    ]);
  });
});

describe("ompApprovalRequest", () => {
  it("recognizes only the native Allow tool title and exact Approve/Deny choices", () => {
    expect(ompApprovalRequest("Allow tool: bash\n  echo hi\n  ", ["Approve", "Deny"])).toEqual({ tool: "bash", summary: "echo hi" });
    expect(ompApprovalRequest("Allow tool: write", ["Approve", "Deny"])).toEqual({ tool: "write", summary: "write" });
    for (const [title, options] of [
      ["Which action?", ["Approve", "Deny"]], ["Allow tool: bash", ["Allow once", "Deny"]],
      ["Allow tool: bash", ["Deny", "Approve"]], ["Allow tool: bash", ["Approve", "Deny", "Always"]],
      ["Allow tool: ", ["Approve", "Deny"]], [null, null],
    ]) expect(ompApprovalRequest(title, options)).toBeNull();
  });
});

describe("ompToolCall", () => {
  it("names xd writes after their device and exposes the device payload", () => {
    expect(ompToolCall("write", { path: "xd://browser", content: { action: "navigate" } })).toEqual({ title: "browser", input: { action: "navigate" } });
  });

  it("leaves ordinary tools and files alone, including a bare xd scheme", () => {
    for (const [name, args] of [["bash", { command: "pwd" }], ["write", { path: "note.txt", content: "hello" }], ["write", { path: "xd://" }]]) {
      expect(ompToolCall(name, args)).toEqual({ title: name, input: args });
    }
    expect(ompToolCall(undefined, null)).toEqual({ title: "tool", input: null });
  });
});


describe("ompUpdateCommand", () => {
  it("updates the configured executable in place, one quoted token per path", () => {
    expect(ompUpdateCommand("omp")).toBe("omp update");
    const spaced = join(mkdtempSync(join(process.env.HOME!, "omp update ")), "bin", "o'mp");
    mkdirSync(dirname(spaced), { recursive: true });
    writeFileSync(spaced, "");
    expect(ompUpdateCommand(spaced, "darwin")).toBe(`'${spaced.replaceAll("'", `'\\''`)}' update`);
    expect(ompUpdateCommand("C:\\Tools\\omp.exe", "win32")).toBe("& 'C:\\Tools\\omp.exe' update");
  });
});

describe("OmpDriver contract (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let directory: string;
  let dump: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    directory = mkdtempSync(join(process.env.HOME!, "omp-contract-"));
    dump = join(directory, "rpc.jsonl");
  });
  afterEach(async () => {
    vi.useRealTimers();
    recorder?.stop();
    await instance?.dispose();
    vi.unstubAllGlobals();
    release.latest = null;
  });

  const create = async (mode = "happy", environment: Record<string, string> = {}, cli = FAKE_CLI) => {
    instance = await OmpDriver.create({
      instanceId: "omp-test", displayName: "omp Test", enabled: true, config: { cli },
      environment: {
        HOME: directory, USERPROFILE: directory, FAKE_OMP_MODE: mode,
        FAKE_OMP_SESSION_DIR: directory, FAKE_OMP_DUMP: dump, ...environment,
      },
    });
    recorder = recordEvents(instance.adapter);
  };
  const run = async (turn: SendTurnInput) => {
    const { turnId } = await instance.adapter.sendTurn(turn);
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return turnId;
  };
  const sessionFor = (turnId: string) => {
    const event = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId);
    if (!event || event.type !== "session.started" || !event.sessionId) throw new Error("Missing session file cursor");
    return event.sessionId;
  };

  it("normalizes a full turn in order and sums assistant usage including cache reads and cost", async () => {
    await create();
    const turnId = await run({ threadId: "happy", text: "hi", model: "anthropic/claude-sonnet" });
    expect(recorder.events.map((event) => event.type)).toEqual([
      "turn.started", "session.started", "content.delta", "content.delta", "thread.token-usage.updated",
      "content.delta", "content.delta", "thread.token-usage.updated", "item.completed", "turn.completed",
    ]);
    expect(recorder.events.every((event) => event.turnId === turnId && event.provider === "ompAgent" && event.providerInstanceId === "omp-test")).toBe(true);
    const state = readDump(dump).find((row) => row.state?.sessionFile)?.state;
    expect(sessionFor(turnId)).toBe(state?.sessionFile);
    expect(sessionFor(turnId)).not.toBe(state?.sessionId);
    expect(existsSync(sessionFor(turnId))).toBe(true);
    expect(recorder.events.filter((event) => event.type === "content.delta")).toMatchObject([
      { streamKind: "reasoning_text", delta: "Checking the request" },
      { streamKind: "assistant_text", delta: "Hello" }, { delta: " from" }, { delta: " omp" },
    ]);
    expect(recorder.events.find((event) => event.type === "item.completed")).toMatchObject({ itemType: "assistant_text", text: "Hello from omp" });
    expect(recorder.events.filter((event) => event.type === "thread.token-usage.updated")).toMatchObject([
      { input: 17, cachedInput: 5, output: 3, contextTokens: 19, contextWindow: 200_000 },
      { input: 9, cachedInput: 2, output: 4, contextTokens: 10, contextWindow: 200_000 },
    ]);
    expect(recorder.events.at(-1)).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 26, cachedInput: 7, output: 7 }, cost: 0.375 });
    expect(instance.adapter.hasSession("happy")).toBe(false);
  });

  it("loads every model in a catalog larger than the physical frame limit", async () => {
    const modelsFile = join(directory, "large-catalog.json");
    const models = Array.from({ length: 100 }, (_, index) => ({
      provider: "test", id: `model-${index}`, name: `Model ${index} 🙂`, contextWindow: 128_000 + index,
    }));
    writeFileSync(modelsFile, JSON.stringify(models));
    await create("happy", { FAKE_OMP_FRAME_LIMIT: "2048", FAKE_OMP_MODELS_FILE: modelsFile });
    expect(instance.models).toEqual({
      default: "test/model-0",
      options: models.map((model) => ({ id: `${model.provider}/${model.id}`, label: model.name, provider: model.provider, custom: true, contextWindow: model.contextWindow })),
    });
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
  });

  it("delivers a large turn frame intact, including UTF-8 characters split across chunks", async () => {
    await create("large-turn", { FAKE_OMP_FRAME_LIMIT: "2048" });
    await run({ threadId: "large-turn", text: "go" });
    const expected = "🙂é".repeat(4096);
    expect(recorder.events.filter((event) => event.type === "content.delta")).toMatchObject([{ delta: expected }]);
    expect(recorder.events.find((event) => event.type === "item.completed")).toMatchObject({ itemType: "assistant_text", text: expected });
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
  });

  const chunkFaults = [
    ["start", /start at index 0/],
    ["index", /sequence mismatch/],
    ["id", /sequence mismatch/],
    ["count", /sequence mismatch/],
    ["length", /sequence mismatch/],
    ["count-min", /count/],
    ["count-max", /metadata/],
    ["id-empty", /chunkId/],
    ["oversized", /reassembly limit/],
    ["base64", /invalid rpc chunk data/],
    ["noncanonical", /invalid rpc chunk data/],
    ["payload", /payload exceeds/],
    ["short", /length mismatch/],
    ["excess", /exceeds declared length/],
    ["utf8", /encoded data|UTF-8/],
    ["json", /JSON|Unexpected token/],
    ["object", /object/],
    ["interrupted", /sequence interrupted/],
    ["truncated", /incomplete rpc chunk sequence/],
  ] as const;

  it.each(chunkFaults)("fails a corrupt %s turn sequence without leaving an active turn", async (fault, message) => {
    await create("corrupt-turn", { FAKE_OMP_FRAME_LIMIT: "2048", FAKE_OMP_CHUNK_FAULT: fault });
    await run({ threadId: "corrupt", text: "go" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringMatching(message) });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
    expect(instance.adapter.hasSession("corrupt")).toBe(false);
  });

  it.each(chunkFaults)("rejects a corrupt %s catalog instead of returning an empty catalog", async (fault, message) => {
    const modelsFile = join(directory, "large-catalog.json");
    writeFileSync(modelsFile, JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ provider: "test", id: `model-${index}` }))));
    await expect(fetchOmpModels(FAKE_CLI, {
      ...process.env, HOME: directory, USERPROFILE: directory,
      FAKE_OMP_MODE: "corrupt-catalog", FAKE_OMP_FRAME_LIMIT: "2048",
      FAKE_OMP_MODELS_FILE: modelsFile, FAKE_OMP_CHUNK_FAULT: fault,
    })).rejects.toThrow(message);
  });

  it("enforces the ready frame's advertised reassembly ceiling", async () => {
    await create("large-turn", { FAKE_OMP_FRAME_LIMIT: "2048", FAKE_OMP_ADVERTISED_REASSEMBLY_LIMIT: "4096" });
    await run({ threadId: "oversized", text: "go" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("reassembly limit exceeded") });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
  });

  it("surfaces an oversized event's overflow stub as a failed turn", async () => {
    await create("large-turn", { FAKE_OMP_FRAME_LIMIT: "2048", FAKE_OMP_REASSEMBLY_LIMIT: "4096" });
    await run({ threadId: "overflow-event", text: "go" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("transport overflow") });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
  });

  it("reports an overflow response as a transport failure rather than a signed-out catalog", async () => {
    const modelsFile = join(directory, "large-catalog.json");
    writeFileSync(modelsFile, JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ provider: "test", id: `model-${index}` }))));
    await create("overflow", { FAKE_OMP_FRAME_LIMIT: "2048", FAKE_OMP_MODELS_FILE: modelsFile });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("RPC response exceeded the transport limit") });
  });

  it.each(APPROVALS)("reasserts %s approval policy as %s on turn argv", async (approvalMode, expected) => {
    await create();
    await run({ threadId: "argv", text: "hi", approvalMode });
    expect(readDump(dump).find((row) => row.argv?.includes("rpc-ui"))?.argv).toEqual(["--mode", "rpc-ui", "--approval-mode", expected]);
  });

  it("strips OpenMausBot-managed provider keys and workspace credentials from probes and turns", async () => {
    await create("happy", {
      ANTHROPIC_API_KEY: "anthropic-secret", OPENAI_API_KEY: "openai-secret", XAI_API_KEY: "xai-secret",
      GEMINI_API_KEY: "gemini-secret", BOX_TOKEN: "workspace-secret",
    });
    await run({ threadId: "env", text: "hi" });
    const launches = readDump(dump).filter((row) => row.argv);
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      expect(launch.envConfigured).toEqual(expect.arrayContaining(["PATH", "HOME"]));
      expect(launch.envConfigured?.filter((key) => ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "BOX_TOKEN"].includes(key))).toEqual([]);
    }
  });

  it("loads the extension for integrations and passes their config outside argv", async () => {
    await create();
    await run({ threadId: "integration", text: "hi", integrations: { agents: { command: "node", args: ["agents"], env: { TOKEN: "integration-secret" } } } });
    const launch = readDump(dump).find((row) => row.argv?.includes("rpc-ui"));
    expect(launch?.argv?.slice(0, 5)).toEqual(["--mode", "rpc-ui", "--approval-mode", "always-ask", "-e"]);
    expect(launch?.argv).toHaveLength(6);
    expect(launch?.argv?.[5]).toMatch(/pi-mcp-extension/);
    expect(launch?.argv?.join(" ")).not.toContain("integration-secret");
    expect(launch?.mcpConfig?.mcpServers).toEqual({ agents: { command: "node", args: ["agents"], env: { TOKEN: "integration-secret" } } });
  });

  it("loads the extension for tool selection and dispatches only after enforcement readiness", async () => {
    await create("happy", { FAKE_OMP_SCOPE_READY: "1" });
    await run({ threadId: "scope", text: "hi", toolScope: { allow: ["native:read"] } });
    const launch = readDump(dump).find((row) => row.argv?.includes("rpc-ui"));
    expect(launch?.argv).toContain("-e");
    expect(launch?.mcpConfig?.toolScope).toEqual({ allow: ["native:read"] });
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
  });

  it("fails closed before prompting when the extension does not confirm tool selection", async () => {
    await create();
    await run({ threadId: "missing-scope", text: "must not run", toolScope: { allow: [] } });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringMatching(/tool selection enforcement is unavailable/i) });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
    expect(readDump(dump).some((row) => row.command?.type === "prompt")).toBe(false);
  });

  it("resumes an existing session file rather than silently starting a new conversation", async () => {
    await create();
    const first = await run({ threadId: "resume", text: "first" });
    const cursor = sessionFor(first);
    const second = await run({ threadId: "resume", text: "second", resumeCursor: cursor });
    expect(sessionFor(second)).toBe(cursor);
    const commands = readDump(dump).flatMap((row) => row.command ? [row.command] : []);
    expect(commands.filter((command) => command.type === "new_session")).toHaveLength(1);
    expect(commands.filter((command) => command.type === "switch_session")).toEqual([{ type: "switch_session", id: expect.any(String), sessionPath: cursor }]);
  });

  it.each(["FAKE_OMP_SWITCH_CANCEL", "FAKE_OMP_SWITCH_MISMATCH"])("rebuilds a refused resume from %s rather than trusting a successful response", async (flag) => {
    await create("happy", { [flag]: "1" });
    const cursor = join(directory, "vetoed.jsonl");
    writeFileSync(cursor, "");
    const turnId = await run({ threadId: "vetoed-resume", text: "continue", resumeCursor: cursor, recoveryText: "Earlier conversation" });
    expect(sessionFor(turnId)).not.toBe(cursor);
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ rebuilt: true });
    expect(readDump(dump).find((row) => row.command?.type === "prompt")?.command?.message).toContain("Earlier conversation");
  });

  it.each(["FAKE_OMP_SWITCH_CANCEL", "FAKE_OMP_SWITCH_MISMATCH"])("fails a refused resume from %s without recovery before prompting", async (flag) => {
    await create("happy", { [flag]: "1" });
    const cursor = join(directory, "vetoed.jsonl");
    writeFileSync(cursor, "");
    await run({ threadId: "vetoed-resume", text: "continue", resumeCursor: cursor });
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    expect(readDump(dump).some((row) => row.command?.type === "prompt")).toBe(false);
  });

  it("waits for the preceding child's EOF flush before resuming a queued turn", async () => {
    const gate = join(directory, "allow-exit");
    await create("delayed-exit", { FAKE_OMP_EXIT_GATE: gate });
    const first = await run({ threadId: "flush", text: "first" });
    const cursor = sessionFor(first);
    const second = instance.adapter.sendTurn({ threadId: "flush", text: "second", resumeCursor: cursor });
    await untilDump(dump, (row) => row.lifecycle === "stdin-ended");
    expect(readDump(dump).filter((row) => row.argv?.includes("rpc-ui"))).toHaveLength(1);
    expect(readDump(dump).some((row) => row.command?.type === "switch_session")).toBe(false);
    writeFileSync(gate, "");
    const { turnId } = await second;
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(sessionFor(turnId)).toBe(cursor);
    expect(recorder.events.find((event) => event.type === "content.delta" && event.turnId === turnId)).toMatchObject({ delta: "Resumed: flushed first turn" });
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
  });

  it("rebuilds a missing cursor with recovery text without ever sending switch_session", async () => {
    await create();
    const turnId = await run({ threadId: "rebuild", text: "continue", resumeCursor: join(directory, "missing.jsonl"), recoveryText: "Earlier user: remember blue.\nCurrent user: continue" });
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ rebuilt: true });
    expect(existsSync(sessionFor(turnId))).toBe(true);
    const commands = readDump(dump).flatMap((row) => row.command ? [row.command] : []);
    expect(commands.some((command) => command.type === "switch_session")).toBe(false);
    expect(commands.some((command) => command.type === "new_session")).toBe(true);
    expect(commands.find((command) => command.type === "prompt")?.message).toContain("Earlier user: remember blue.");
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
  });

  it("fails a missing cursor without recovery instead of sending a blank-session prompt", async () => {
    await create();
    await run({ threadId: "no-recovery", text: "continue", resumeCursor: join(directory, "missing.jsonl") });
    expect(recorder.events.map((event) => event.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(recorder.events.at(-1)).toMatchObject({ ok: false, stopReason: "failed" });
    expect(readDump(dump).some((row) => ["switch_session", "new_session", "prompt"].includes(row.command?.type ?? ""))).toBe(false);
  });

  it("rebuilds when omp explicitly refuses an existing cursor before prompt admission", async () => {
    await create("happy", { FAKE_OMP_SWITCH_REFUSE: "1" });
    const cursor = join(directory, "refused.jsonl");
    writeFileSync(cursor, "");
    const turnId = await run({ threadId: "refused-resume", text: "continue", resumeCursor: cursor, recoveryText: "Recovered conversation" });
    expect(sessionFor(turnId)).not.toBe(cursor);
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ rebuilt: true });
    expect(readDump(dump).find((row) => row.command?.type === "prompt")?.command?.message).toContain("Recovered conversation");
  });

  it("sessionReset ignores an existing cursor and establishes a new session", async () => {
    await create();
    const first = await run({ threadId: "reset", text: "first" });
    const second = await run({ threadId: "reset", text: "reset", sessionReset: true, resumeCursor: sessionFor(first) });
    expect(sessionFor(second)).not.toBe(sessionFor(first));
    expect(readDump(dump).some((row) => row.command?.type === "switch_session")).toBe(false);
  });

  it("keeps an async turn open after prompt_result until session_settled and includes late work", async () => {
    await create("async");
    await instance.adapter.sendTurn({ threadId: "async", text: "go" });
    await recorder.until((event) => event.type === "content.delta" && event.delta === "; background work pending");
    expect(recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(instance.adapter.hasSession("async")).toBe(true);
    await expect(instance.adapter.steer!("async", "finish background work")).resolves.toBe("steered");
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, usage: { input: 17, cachedInput: 5, output: 3 }, cost: 0.375 });
    expect(recorder.events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Initial reply; background work pending; background finished" });
    expect(instance.adapter.hasSession("async")).toBe(false);
  });

  it.each(["async-error", "async-aborted"])("waits for session settlement after %s and preserves its outcome and late work", async (mode) => {
    await create(mode);
    await instance.adapter.sendTurn({ threadId: "async-outcome", text: "go" });
    await recorder.until((event) => event.type === "content.delta" && event.delta === "; background work pending");
    expect(instance.adapter.hasSession("async-outcome")).toBe(true);
    expect(recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
    await instance.adapter.steer!("async-outcome", "finish background work");
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({
      ok: mode !== "async-error", stopReason: mode === "async-error" ? "failed" : "cancelled",
      usage: { input: 17, cachedInput: 5, output: 3 },
    });
    expect(recorder.events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Initial reply; background work pending; background finished" });
  });

  it("surfaces prompt_result provider errors as a failed turn", async () => {
    await create("error");
    await run({ threadId: "error", text: "go" });
    expect(recorder.events.slice(-2)).toMatchObject([{ type: "runtime.error", message: "Provider quota exhausted" }, { type: "turn.completed", ok: false, stopReason: "failed" }]);
  });

  it("interrupts an admitted turn, sends abort and reports cancellation exactly once", async () => {
    await create("editor");
    await instance.adapter.sendTurn({ threadId: "interrupt", text: "go" });
    await recorder.until((event) => event.type === "request.opened");
    const delivered = untilDump(dump, (row) => row.command?.type === "abort");
    await instance.adapter.interruptTurn("interrupt");
    const done = await recorder.until((event) => event.type === "turn.completed");
    await delivered;
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(instance.adapter.hasSession("interrupt")).toBe(false);
  });

  it("ignores all content, tool and dialog frames piped after Stop", async () => {
    await create("late-frames");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await instance.adapter.sendTurn({ threadId: "late", text: "first" });
    await recorder.until((event) => event.type === "request.opened");
    await instance.adapter.interruptTurn("late");
    const completed = recorder.events.findIndex((event) => event.type === "turn.completed");
    const second = await instance.adapter.sendTurn({ threadId: "late", text: "second", resumeCursor: sessionFor(first.turnId) });
    await recorder.until((event) => event.type === "request.opened" && event.turnId === second.turnId);
    expect(readDump(dump).some((row) => row.lifecycle === "late-frames-sent")).toBe(true);
    expect(recorder.events.slice(completed + 1).filter((event) => event.turnId === first.turnId)).toEqual([]);
    // Only the new turn's answerable card remains, never the late old card.
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["stopAll", "dispose"] as const)("reaps a completed child stalled on EOF during %s", async (method) => {
    await create("stall-exit");
    await run({ threadId: "shutdown", text: "go" });
    await untilDump(dump, (row) => row.lifecycle === "stdin-ended");
    const pid = readDump(dump).find((row) => row.argv?.includes("rpc-ui"))?.pid;
    if (!pid) throw new Error("Missing turn process id");
    if (method === "stopAll") await instance.adapter.stopAll();
    else await instance.dispose();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("fails a refused model pick before any prompt and names the selected model", async () => {
    await create();
    await run({ threadId: "unknown-model", text: "go", model: "anthropic/not-a-model" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringMatching(/anthropic\/not-a-model.*Model not found/) });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
    expect(readDump(dump).some((row) => row.command?.type === "prompt")).toBe(false);
  });

  it.each([["allow", "Approve", "allowed-once"], ["deny", "Deny", "rejected"]] as const)("brokers %s for native bash approvals with the exact command and cwd", async (behavior, value, outcome) => {
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "approval", text: "go", cwd: directory });
    const request = await recorder.until((event) => event.type === "request.opened");
    if (request.type !== "request.opened" || !request.requestId) throw new Error("Expected permission card");
    expect(request).toMatchObject({ requestType: "permission", tool: "bash", summary: "echo hi", command: { command: "echo hi", cwd: realpathSync(directory) } });
    await expect(instance.adapter.respondToRequest("approval", request.requestId, { behavior })).resolves.toBe(outcome);
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).find((row) => row.command?.type === "extension_ui_response")?.command).toEqual({ type: "extension_ui_response", id: "approval-1", value });
    expect(recorder.events.find((event) => event.type === "request.resolved")).toMatchObject({ behavior, source: "user" });
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
    expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "tool")).toMatchObject({ ok: behavior === "allow" });
  });

  it("stamps host-computer permission cards with local-computer approval scope", async () => {
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "host-approval", text: "go", cwd: directory, integrations: { localComputer: { command: "node", args: ["computer"], env: {}, scope: "local-computer" } } });
    const request = await recorder.until((event) => event.type === "request.opened");
    expect(request).toMatchObject({ requestType: "permission", approvalScope: "local-computer" });
    if (request.type !== "request.opened" || !request.requestId) throw new Error("Expected permission card");
    await instance.adapter.respondToRequest("host-approval", request.requestId, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed");
  });

  it("opens one complete ask card and returns ordered exact-label and free-text answers", async () => {
    await create("ask");
    await instance.adapter.sendTurn({ threadId: "ask", text: "go" });
    const request = await recorder.until((event) => event.type === "request.opened");
    if (request.type !== "request.opened" || !request.requestId) throw new Error("Expected question card");
    expect(request).toMatchObject({ requestType: "question", tool: "ask_user", questions: [
      { question: "Which color?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] },
      { question: "Which city?", options: [{ label: "Paris" }, { label: "Tokyo" }] },
    ] });
    await expect(instance.adapter.respondToRequest("ask", request.requestId, { behavior: "answer", message: "Q: Which color?\nA: Blue\n\nQ: Which city?\nA: free text" })).resolves.toBe("answered");
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).find((row) => row.command?.type === "extension_ui_response")?.command).toEqual({
      type: "extension_ui_response", id: "ask-1", answers: [
        { id: "color", selectedOptions: ["Blue"] }, { id: "city", selectedOptions: [], customInput: "free text" },
      ],
    });
  });

  it("cancels an ask rather than fabricating answers when the person denies it", async () => {
    await create("ask");
    await instance.adapter.sendTurn({ threadId: "ask-deny", text: "go" });
    await recorder.until((event) => event.type === "request.opened");
    await expect(instance.adapter.respondToRequest("ask-deny", "ask-1", { behavior: "deny" })).resolves.toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).find((row) => row.command?.type === "extension_ui_response")?.command).toEqual({ type: "extension_ui_response", id: "ask-1", cancelled: true });
  });

  it.each([
    ["ask", { cancelled: true }],
    ["approval", { value: "Deny" }],
    ["confirm", { confirmed: false }],
    ["input", { cancelled: true }],
    ["editor", { cancelled: true }],
    ["select", { cancelled: true }],
  ] as const)("denies a timed-out %s without passing recommended or approved answers to omp", async (mode, reply) => {
    await create(mode);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await instance.adapter.sendTurn({ threadId: "timeout", text: "go" });
    await recorder.until((event) => event.type === "request.opened");
    vi.advanceTimersByTime(15 * 60_000);
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).find((row) => row.command?.type === "extension_ui_response")?.command).toEqual({
      type: "extension_ui_response", id: `${mode}-1`, ...reply,
    });
    expect(recorder.events.find((event) => event.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "timeout" });
  });

  it.each(["ask-too-many", "ask-duplicate"])("notifies the person when %s cannot be represented as one complete card", async (mode) => {
    await create(mode);
    await run({ threadId: "unsupported-ask", text: "go" });
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(recorder.events.find((event) => event.type === "runtime.notice")).toMatchObject({ message: expect.stringMatching(/declined/) });
    expect(readDump(dump).find((row) => row.command?.type === "extension_ui_response")?.command).toEqual({ type: "extension_ui_response", id: "ask-1", cancelled: true });
  });

  it("answers an editor with verbatim free text instead of an ask answers array", async () => {
    await create("editor");
    await instance.adapter.sendTurn({ threadId: "editor", text: "go" });
    const request = await recorder.until((event) => event.type === "request.opened");
    expect(request).toMatchObject({ requestType: "question", summary: "Describe the change" });
    await expect(instance.adapter.respondToRequest("editor", "editor-1", { behavior: "answer", message: "line one\nline two" })).resolves.toBe("answered");
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).find((row) => row.command?.type === "extension_ui_response")?.command).toEqual({ type: "extension_ui_response", id: "editor-1", value: "line one\nline two" });
  });

  it("closes an omp-cancelled card with a system denial and refuses a stale answer while still running", async () => {
    await create("cancel");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await instance.adapter.sendTurn({ threadId: "cancel", text: "go" });
    const resolved = await recorder.until((event) => event.type === "request.resolved" && event.requestId === "cancelled-1");
    expect(resolved).toMatchObject({ behavior: "deny", source: "system" });
    expect(instance.adapter.hasSession("cancel")).toBe(true);
    await expect(instance.adapter.respondToRequest("cancel", "cancelled-1", { behavior: "answer", message: "stale" })).resolves.toBe("unavailable");
    await recorder.until((event) => event.type === "request.opened" && event.requestId === "continue-1");
    expect(vi.getTimerCount()).toBe(1);
    await instance.adapter.respondToRequest("cancel", "continue-1", { behavior: "answer", message: "continue" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).some((row) => row.command?.type === "extension_ui_response" && row.command.id === "cancelled-1")).toBe(false);
  });

  it("steers a running turn through an acknowledged frame and refuses after settlement", async () => {
    await create("editor");
    await instance.adapter.sendTurn({ threadId: "steer", text: "go" });
    await recorder.until((event) => event.type === "request.opened");
    await expect(instance.adapter.steer!("steer", "Use the blue option")).resolves.toBe("steered");
    expect(readDump(dump).find((row) => row.command?.type === "steer")?.command).toEqual({ type: "steer", id: expect.any(String), message: "Use the blue option" });
    await instance.adapter.respondToRequest("steer", "editor-1", { behavior: "answer", message: "done" });
    await recorder.until((event) => event.type === "turn.completed");
    await expect(instance.adapter.steer!("steer", "too late")).resolves.toBe("refused");
  });

  it("reports an explicit steer refusal without failing the running turn", async () => {
    await create("editor", { FAKE_OMP_STEER_REFUSE: "1" });
    await instance.adapter.sendTurn({ threadId: "steer-refused", text: "go" });
    await recorder.until((event) => event.type === "request.opened");
    await expect(instance.adapter.steer!("steer-refused", "aside")).resolves.toBe("refused");
    expect(instance.adapter.hasSession("steer-refused")).toBe(true);
    await instance.adapter.respondToRequest("steer-refused", "editor-1", { behavior: "answer", message: "done" });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("preserves text/tool/text order and waits for prompt_result rather than a tool end", async () => {
    await create("tooluse");
    await run({ threadId: "tools", text: "go" });
    expect(recorder.events.map((event) => event.type)).toEqual([
      "turn.started", "session.started", "content.delta", "item.completed", "item.started", "item.completed",
      "content.delta", "item.completed", "turn.completed",
    ]);
    expect(recorder.events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject([{ text: "Before shell" }, { text: "After shell" }]);
  });

  it("shows an xd write as its actual device in the activity row", async () => {
    await create("xdev");
    await run({ threadId: "xd", text: "go" });
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({ itemType: "tool", itemId: "device-1", title: "browser", input: expect.stringContaining("navigate") });
    expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "tool")).toMatchObject({ itemId: "device-1", ok: true });
  });

  it("refuses overlapping turns on one thread without disturbing the running turn", async () => {
    await create("editor");
    await instance.adapter.sendTurn({ threadId: "overlap", text: "first" });
    await recorder.until((event) => event.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "overlap", text: "second" })).rejects.toThrow(/already running/);
    await instance.adapter.respondToRequest("overlap", "editor-1", { behavior: "answer", message: "done" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(readDump(dump).filter((row) => row.command?.type === "prompt")).toHaveLength(1);
  });

  it("completes builtin slash commands that never invoke the agent", async () => {
    await create("slash");
    await run({ threadId: "slash", text: "/help" });
    expect(recorder.events.map((event) => event.type)).toEqual(["turn.started", "session.started", "turn.completed"]);
    expect(recorder.events.at(-1)).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("surfaces a refused prompt admission without leaving a hanging active turn", async () => {
    await create("prompt-reject");
    await run({ threadId: "prompt-reject", text: "go" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: "fake omp: prompt rejected" });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
    expect(instance.adapter.hasSession("prompt-reject")).toBe(false);
  });

  it("fails before prompting when omp refuses the required ask-dialog command", async () => {
    await create("ask-refuse");
    await run({ threadId: "ask-refuse", text: "must not run" });
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    expect(readDump(dump).some((row) => ["new_session", "prompt"].includes(row.command?.type ?? ""))).toBe(false);
    expect(instance.adapter.hasSession("ask-refuse")).toBe(false);
  });

  it("reports an unexpected process exit with its stderr rather than hanging", async () => {
    await create("exit-early");
    await run({ threadId: "exit", text: "go" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("fake omp: runtime crashed") });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
  });

  it.each(["omp/18.3.0", "omp v18.2.99", "omp/18.4.8", "omp/18.4.9-beta.1"])("rejects old version %s and offers the configured omp's own update", async (version) => {
    await create("happy", { FAKE_OMP_VERSION: version });
    expect(await instance.snapshot()).toMatchObject({
      state: "unavailable",
      version,
      reason: expect.stringContaining("too old"),
      update: { command: ompUpdateCommand(FAKE_CLI) },
    });
  });

  it("offers an update only when npm publishes a newer stable omp", async () => {
    release.latest = "18.5.0";
    await create("happy", { FAKE_OMP_VERSION: "omp/18.4.12 (fake)" });
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      update: { title: "Update omp to 18.5.0", command: ompUpdateCommand(FAKE_CLI) },
    });
    await instance.dispose();
    await create("happy", { FAKE_OMP_VERSION: "omp/18.5.0" });
    expect(await instance.snapshot()).not.toHaveProperty("update");
    release.latest = null;
    await instance.dispose();
    await create("happy", { FAKE_OMP_VERSION: "omp/18.4.12" });
    expect(await instance.snapshot()).not.toHaveProperty("update");
  });

  it("reports a missing CLI as unavailable and a failed spawn as a failed turn", async () => {
    await create("happy", {}, join(directory, "missing-omp"));
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("CLI not found") });
    await run({ threadId: "missing", text: "go" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ setup: true, message: expect.stringContaining("missing-omp") });
    expect(recorder.events.at(-1)).toMatchObject({ ok: false });
  });

  it.each([["omp/18.4.9", true], ["omp/18.4.12", false]] as const)("reports supported version %s with authenticated=%s from omp's own catalog", async (version, authenticated) => {
    await create("happy", { FAKE_OMP_VERSION: version, ...(authenticated ? {} : { FAKE_OMP_MODELS: "[]" }) });
    expect(await instance.snapshot()).toEqual({ state: "available", version, authenticated });
  });

  it("does not mistake a local-host catalog for being authenticated with omp", async () => {
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).includes(":11434")) return new Response(JSON.stringify({ data: [{ id: "some-model" }] }), { status: 200 });
      return new Response("not available", { status: 503 });
    });
    await create("happy", { FAKE_OMP_MODELS: "[]", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" });
    expect(instance.models.options.some((option) => option.id === "ollama::some-model")).toBe(true);
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });

  it("refreshes the catalog only on explicit action through models refresh then a fresh probe", async () => {
    await create();
    expect(readDump(dump).filter((row) => row.argv).map((row) => row.argv)).toEqual([["--mode", "rpc", "--no-session"]]);
    writeFileSync(dump, "");
    await instance.refreshModels!();
    expect(readDump(dump).filter((row) => row.argv).map((row) => row.argv)).toEqual([["models", "refresh"], ["--mode", "rpc", "--no-session"]]);
    expect(instance.models.options).toHaveLength(2);
  });

  it("clears revoked omp models and sign-in after a successful empty refresh while keeping live local models", async () => {
    vi.stubGlobal("fetch", async (url: string | URL | Request) => String(url).includes(":11434")
      ? new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 })
      : new Response("not available", { status: 503 }));
    const modelsFile = join(directory, "catalog.json");
    writeFileSync(modelsFile, JSON.stringify([{ provider: "anthropic", id: "claude-sonnet" }]));
    await create("happy", { FAKE_OMP_MODELS_FILE: modelsFile, OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" });
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    expect(instance.models.options.some((option) => option.id === "anthropic/claude-sonnet")).toBe(true);
    writeFileSync(modelsFile, "[]");
    await instance.refreshModels!();
    expect(await instance.snapshot()).toMatchObject({ authenticated: false });
    expect(instance.models.options.map((option) => option.id)).toEqual(["ollama::local-model"]);
  });

  it("keeps the last signed-in catalog when a refresh probe fails rather than returning an empty catalog", async () => {
    const modelsFile = join(directory, "catalog.json");
    writeFileSync(modelsFile, JSON.stringify([{ provider: "anthropic", id: "claude-sonnet" }]));
    await create("happy", { FAKE_OMP_MODELS_FILE: modelsFile });
    writeFileSync(modelsFile, "not JSON");
    await instance.refreshModels!();
    expect(instance.models.options.map((option) => option.id)).toEqual(["anthropic/claude-sonnet"]);
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
  });

  it("does not treat an unknown prompt-result status as a successful completed turn", async () => {
    await create("malformed-result");
    await instance.adapter.sendTurn({ threadId: "malformed", text: "go" });
    await recorder.until((event) => event.type === "content.delta" && event.delta === "Invalid result ignored");
    expect(instance.adapter.hasSession("malformed")).toBe(true);
    expect(recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
    await instance.adapter.interruptTurn("malformed");
  });

  it("registers a selected local model through the extension without rewriting user model settings", async () => {
    await create();
    const modelsDirectory = join(directory, ".omp", "agent");
    mkdirSync(modelsDirectory, { recursive: true });
    const settings = join(modelsDirectory, "models.yml");
    writeFileSync(settings, "# personal model configuration\n");
    await run({ threadId: "local", text: "go", model: "ollama::some-model" });
    const launch = readDump(dump).find((row) => row.argv?.includes("rpc-ui"));
    expect(launch?.argv).toContain("-e");
    expect(launch?.mcpConfig?.localProvider).toEqual({ name: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama", model: "some-model" });
    expect(readDump(dump).find((row) => row.command?.type === "set_model")?.command).toEqual({ type: "set_model", id: expect.any(String), provider: "ollama", modelId: "some-model" });
    expect(recorder.events.at(-1)).toMatchObject({ ok: true });
    expect(readFileSync(settings, "utf8")).toBe("# personal model configuration\n");
  });

  it("delivers the full prompt once per session and rides volatile changes as notes", async () => {
    await create();
    const threadId = "split-" + randomUUID();
    const send = async (text: string, volatile: string, cursor?: string) => {
      const turnId = await run({ threadId, text, system: "Standing rules.\n\n" + volatile,
        systemStable: "Standing rules.", systemVolatile: volatile, resumeCursor: cursor });
      const message = readDump(dump).filter((row) => row.command?.type === "prompt").at(-1)?.command?.message;
      return { message, cursor: sessionFor(turnId) };
    };
    const first = await send("first", "Memory: likes quiet hours.");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    const second = await send("second", "Memory: likes quiet hours.", first.cursor);
    expect(second.message).toBe("second");
    expect(second.message!.length).toBeLessThan(first.message!.length);
    const third = await send("third", "Memory: moved to Toronto.", first.cursor);
    expect(third.message).toBe("Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nMemory: moved to Toronto.\n\nthird");
  });

  it("reestablishes the full prompt after auto compaction invalidates its receipt", async () => {
    await create("compaction");
    const threadId = "compaction-" + randomUUID();
    const system = { system: "Standing rules.\n\nMemory: blue.", systemStable: "Standing rules.", systemVolatile: "Memory: blue." };
    const first = await run({ threadId, text: "first", ...system });
    await run({ threadId, text: "second", resumeCursor: sessionFor(first), ...system });
    expect(readDump(dump).filter((row) => row.command?.type === "prompt").map((row) => row.command?.message)).toEqual([
      "Standing rules.\n\nMemory: blue.\n\nfirst", "Standing rules.\n\nMemory: blue.\n\nsecond",
    ]);
  });

  it("reestablishes standing instructions after a local manual compact with no compaction event", async () => {
    await create("manual-compaction");
    const threadId = "manual-compact-" + randomUUID();
    const system = { system: "Standing rules.\n\nMemory: blue.", systemStable: "Standing rules.", systemVolatile: "Memory: blue." };
    const first = await run({ threadId, text: "first", ...system });
    const cursor = sessionFor(first);
    await run({ threadId, text: "/compact", resumeCursor: cursor, ...system });
    await run({ threadId, text: "after compact", resumeCursor: cursor, ...system });
    expect(readDump(dump).filter((row) => row.command?.type === "prompt").map((row) => row.command?.message)).toEqual([
      "Standing rules.\n\nMemory: blue.\n\nfirst", "/compact", "Standing rules.\n\nMemory: blue.\n\nafter compact",
    ]);
  });

  it("records rebuilt-session prompt delivery so the next resumed turn does not resend standing instructions", async () => {
    await create();
    const threadId = "rebuilt-split-" + randomUUID();
    const system = { system: "Standing rules.\n\nMemory: blue.", systemStable: "Standing rules.", systemVolatile: "Memory: blue." };
    const first = await run({ threadId, text: "continue", resumeCursor: join(directory, "lost.jsonl"), recoveryText: "Earlier conversation: blue.\nContinue", ...system });
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ rebuilt: true });
    const firstMessage = readDump(dump).find((row) => row.command?.type === "prompt")?.command?.message;
    expect(firstMessage).toContain("Standing rules.");
    expect(firstMessage).toContain("Earlier conversation: blue.");
    await run({ threadId, text: "next", resumeCursor: sessionFor(first), ...system });
    expect(readDump(dump).filter((row) => row.command?.type === "prompt").at(-1)?.command?.message).toBe("next");
  });
});
