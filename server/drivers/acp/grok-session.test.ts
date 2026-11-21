// A Grok conversation's session across turns, against the scripted ACP peer: resuming it when the load goes unanswered
// after its replay, changing model or effort without a second process, and what "this session" approves.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { GrokAgentDriver, grokPermissionRequest } from "./grok.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

const scratches: string[] = [];
afterEach(async () => { for (const dir of scratches.splice(0)) await removeTempDir(dir); });

const start = async (id: string, extra: Record<string, string> = {}) => {
  ensureDirs();
  const scratch = mkdtempSync(join(tmpdir(), "omb-grok-session-"));
  scratches.push(scratch);
  mkdirSync(join(scratch, "grok"), { recursive: true });
  writeFileSync(join(scratch, "grok", "auth.json"), "{}");
  const files = { rpc: join(scratch, "rpc.jsonl"), dump: join(scratch, "dump.json"), answer: join(scratch, "answer.txt") };
  const instance = await GrokAgentDriver.create({
    instanceId: id,
    displayName: "Grok",
    enabled: true,
    environment: {
      GROK_HOME: join(scratch, "grok"), FAKE_ACP_RPC_APPEND_FILE: files.rpc, FAKE_ACP_DUMP: files.dump, FAKE_ACP_PERMISSION_ANSWER: files.answer, ...extra,
    },
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  const recorder = recordEvents(instance.adapter);
  const calls = () => existsSync(files.rpc)
    ? readFileSync(files.rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method: string; sessionId?: string }) : [];
  const processes = () => new Set(calls().map((call) => call.pid)).size;
  const ask = async (turn: Omit<SendTurnInput, "text"> & { text?: string }) => {
    const { turnId } = await instance.adapter.sendTurn({ text: "go", ...turn } as SendTurnInput);
    return recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000);
  };
  const sent = (threadId: string, method: string) => readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((entry) => entry.dir === "out" && entry.msg?.method === method).map((entry) => entry.msg.params);
  return { instance, recorder, calls, processes, ask, sent, files };
};

describe("Grok resumes a session whose load goes unanswered after its replay", () => {
  it.each([["unmarked", "0"], ["marked as replay", "1"]])("goes on in the loaded session once a %s replay goes quiet", async (_, marked) => {
    const { instance, recorder, calls, ask } = await start(`grok-replay-${marked}`, {
      FAKE_ACP_LOAD_REPLAY: "3", FAKE_ACP_LOAD_REPLAY_MARKED: marked, FAKE_ACP_LOAD_UNANSWERED: "1",
    });
    try {
      const threadId = `t-grok-replay-${marked}`;
      const startedAt = Date.now();
      expect(await ask({ threadId, resumeCursor: "saved-session" })).toMatchObject({ ok: true });
      // The load's own deadline is 120 s; the replay going quiet ends the wait in seconds.
      expect(Date.now() - startedAt).toBeLessThan(60_000);
      expect(calls().filter((call) => call.method === "session/new")).toEqual([]);
      expect(calls().filter((call) => call.method === "session/prompt").map((call) => call.sessionId)).toEqual(["saved-session"]);
      expect(JSON.stringify(recorder.events)).not.toContain("REPLAYED");
      expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ sessionId: "saved-session" });
      expect(recorder.events.some((event) => event.type === "session.started" && "rebuilt" in event)).toBe(false);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  }, 60_000);

  it("still takes an answered load's own reply", async () => {
    const { instance, recorder, calls, ask } = await start("grok-replay-answered", { FAKE_ACP_LOAD_REPLAY: "2" });
    try {
      expect(await ask({ threadId: "t-grok-replay-answered", resumeCursor: "saved-session" })).toMatchObject({ ok: true });
      expect(calls().filter((call) => call.method === "session/prompt").map((call) => call.sessionId)).toEqual(["saved-session"]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

describe("Grok changes model and effort inside the running session", () => {
  it("switches the model with session/set_model and keeps its one process", async () => {
    const { instance, recorder, calls, processes, ask, sent } = await start("grok-live-model");
    const threadId = "t-grok-live-model";
    try {
      expect(await ask({ threadId, model: "grok-4.5", effort: "high" })).toMatchObject({ ok: true });
      expect(await ask({ threadId, model: "grok-4.6", effort: "high", resumeCursor: "fake-acp-session" })).toMatchObject({ ok: true });
      expect(processes()).toBe(1);
      expect(sent(threadId, "session/set_model").map((params) => params.modelId)).toEqual(["grok-4.5", "grok-4.6"]);
      expect(calls().filter((call) => call.method === "session/prompt").map((call) => call.sessionId)).toEqual(["fake-acp-session", "fake-acp-session"]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("changes the effort with session/set_config_option, without set_model", async () => {
    const { instance, recorder, processes, ask, sent } = await start("grok-live-effort", { FAKE_ACP_GROK_EFFORT: "1" });
    const threadId = "t-grok-live-effort";
    try {
      expect(await ask({ threadId, model: "grok-4.5", effort: "high" })).toMatchObject({ ok: true });
      expect(await ask({ threadId, model: "grok-4.5", effort: "low", resumeCursor: "fake-acp-session" })).toMatchObject({ ok: true });
      expect(await ask({ threadId, model: "grok-4.5", effort: "low", resumeCursor: "fake-acp-session" })).toMatchObject({ ok: true });
      expect(processes()).toBe(1);
      expect(sent(threadId, "session/set_config_option")).toEqual([{ sessionId: "fake-acp-session", configId: "reasoning_effort", value: "low" }]);
      expect(sent(threadId, "session/set_model")).toHaveLength(1);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("changes the effort of a session whose load went quiet, which reported no options", async () => {
    const { instance, recorder, processes, ask, sent } = await start("grok-live-effort-quiet", {
      FAKE_ACP_GROK_EFFORT: "1", FAKE_ACP_LOAD_REPLAY: "2", FAKE_ACP_LOAD_UNANSWERED: "1",
    });
    const threadId = "t-grok-live-effort-quiet";
    try {
      expect(await ask({ threadId, model: "grok-4.5", effort: "high", resumeCursor: "saved-session" })).toMatchObject({ ok: true });
      expect(await ask({ threadId, model: "grok-4.5", effort: "low", resumeCursor: "saved-session" })).toMatchObject({ ok: true });
      expect(processes()).toBe(1);
      expect(sent(threadId, "session/set_config_option")).toEqual([{ sessionId: "saved-session", configId: "reasoning_effort", value: "low" }]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  }, 30_000);

  it("restarts with the new effort on its argv when Grok refuses the change, and the turn still runs", async () => {
    const { instance, recorder, calls, processes, ask, files } = await start("grok-live-refused", { FAKE_ACP_GROK_EFFORT: "refuse" });
    const threadId = "t-grok-live-refused";
    try {
      expect(await ask({ threadId, model: "grok-4.5", effort: "high" })).toMatchObject({ ok: true });
      const second = await ask({ threadId, model: "grok-4.5", effort: "medium", resumeCursor: "fake-acp-session" });
      expect(second).toMatchObject({ ok: true });
      expect(processes()).toBe(2);
      const argv = JSON.parse(readFileSync(files.dump, "utf8")).argv as string[];
      expect(argv[argv.indexOf("--reasoning-effort") + 1]).toBe("medium");
      expect(calls().filter((call) => call.method === "session/load").map((call) => call.sessionId)).toEqual(["fake-acp-session"]);
      expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("keeps the model in the process contract when a narrowed tool profile names it", async () => {
    const { instance, recorder, processes, ask } = await start("grok-live-narrowed", {
      FAKE_ACP_GROK_VERSION: "1.0.41", FAKE_ACP_SESSION_MODELS: "grok-4.5|Grok 4.5,grok-4.6|Grok 4.6",
    });
    const threadId = "t-grok-live-narrowed";
    try {
      const toolScope = { allow: ["native:read_file"] };
      expect(await ask({ threadId, model: "grok-4.5", toolScope })).toMatchObject({ ok: true });
      await ask({ threadId, model: "grok-4.6", toolScope, resumeCursor: "fake-acp-session" });
      expect(processes()).toBe(2);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("starts a new process when the effort is cleared, since a running session cannot drop one", async () => {
    const { instance, recorder, processes, ask } = await start("grok-live-cleared", { FAKE_ACP_GROK_EFFORT: "1" });
    const threadId = "t-grok-live-cleared";
    try {
      await ask({ threadId, model: "grok-4.5", effort: "low" });
      await ask({ threadId, model: "grok-4.5", resumeCursor: "fake-acp-session" });
      expect(processes()).toBe(2);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

// grok 1.0.41's options, as recorded for a bash command and for an edit.
const BASH_OPTIONS = [
  { optionId: "always-allow", name: "Yes, and don't ask again for bash commands", kind: "allow_always" },
  { optionId: "allow-once", name: "Yes, proceed", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
  { optionId: "reject-always", name: "No, and don't ask again for this command", kind: "reject_always" },
];
const EDIT_OPTIONS = [
  { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
];

describe("Grok's \"allow for this session\"", () => {
  it("keeps only the allow_always option that ends with the session", () => {
    const filtered = (options: object[]) => grokPermissionRequest({ toolCall: { toolCallId: "call-1" }, options }).options.map((option: { optionId: string }) => option.optionId);
    expect(filtered(BASH_OPTIONS)).toEqual(["allow-once", "reject-once", "reject-always"]);
    expect(filtered(EDIT_OPTIONS)).toEqual(["allow-edits-session", "allow-once", "reject-once"]);
    expect(filtered([{ optionId: "enable-always-approve", kind: "allow_always" }, { optionId: "allow-once", kind: "allow_once" }])).toEqual(["allow-once"]);
    const question = { toolCall: { toolCallId: "interaction_1" }, options: [{ optionId: "a", kind: "allow_always", name: "A" }] };
    expect(grokPermissionRequest(question)).toBe(question);
  });

  it.each([
    ["a bash command", BASH_OPTIONS, { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" }, "allow-once"],
    ["an edit", EDIT_OPTIONS, { kind: "edit", title: "Edit notes.md", rawInput: { path: "notes.md" } }, "allow-edits-session"],
  ])("answers %s with the session-scoped choice, never a saved grant", async (_, options, toolCall, expected) => {
    const { instance, recorder, files } = await start(`grok-allow-${expected}`, {
      FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify(options), FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(toolCall),
    });
    const threadId = `t-grok-allow-${expected}`;
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "go", approvalMode: "ask" });
      const opened = await recorder.until((event) => event.type === "request.opened");
      expect(opened).toHaveProperty("allowSession", true);
      await instance.adapter.respondToRequest(threadId, (opened as { requestId: string }).requestId, { behavior: "allow", always: true });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(readFileSync(files.answer, "utf8")).toBe(expected);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
