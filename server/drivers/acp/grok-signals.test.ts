// Grok's own ACP signals against the scripted peer: its prompt_complete notification, its rate-limit stop, the client type and
// stop gesture it reads, and a process that could not start its threads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { processBudget } from "../../process-room.ts";
import { outOfProcesses } from "../../process-shortage.ts";
import { classifyRoutineFailure } from "../../routine-recovery.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { CustomAcpDriver } from "./custom.ts";
import { AcpReportedFailure, acpRuntimeFailure } from "./failure-words.ts";
import { GrokAgentDriver } from "./grok.ts";
import { grokReportedFailure } from "./grok-signals.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const TOKIO = "grok: failed to start tokio runtime: blocking pool pre-warm stalled after 14 of 16 threads";

const scratches: string[] = [];
const instances: ProviderInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const dir of scratches.splice(0)) await removeTempDir(dir);
});

type Call = { method: string; sessionId?: string; meta?: Record<string, unknown> };

const start = async (extra: Record<string, string>, driver: "grok" | "custom" = "grok") => {
  ensureDirs();
  const scratch = mkdtempSync(join(tmpdir(), "omb-grok-signals-"));
  scratches.push(scratch);
  mkdirSync(join(scratch, "grok"), { recursive: true });
  writeFileSync(join(scratch, "grok", "auth.json"), "{}");
  const files = { rpc: join(scratch, "rpc.jsonl"), dump: join(scratch, "dump") };
  const environment = { GROK_HOME: join(scratch, "grok"), FAKE_ACP_RPC_APPEND_FILE: files.rpc, FAKE_ACP_DUMP: files.dump, ...extra };
  const instance = (driver === "grok"
    ? await GrokAgentDriver.create({ instanceId: `grok-signals-${scratches.length}`, displayName: "Grok", enabled: true, environment, config: { cli: FAKE_CLI, fullAuto: true } } as never)
    : await CustomAcpDriver.create({ instanceId: `custom-signals-${scratches.length}`, displayName: "Custom", enabled: true, environment, config: { cli: FAKE_CLI, fullAuto: true } })) as ProviderInstance;
  instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  const calls = (): Call[] => existsSync(files.rpc) ? readFileSync(files.rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call) : [];
  const initialize = () => JSON.parse(readFileSync(`${files.dump}.initialize.json`, "utf8")) as Record<string, unknown>;
  const ask = async (text = "hi") => {
    const threadId = `t-${scratches.length}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 15_000);
    return recorder.events.filter((event) => "turnId" in event && event.turnId === turnId);
  };
  return { instance, recorder, calls, initialize, ask };
};

const of = <T extends RuntimeEvent["type"]>(events: RuntimeEvent[], type: T) => events.filter((event) => event.type === type) as Array<Extract<RuntimeEvent, { type: T }>>;
const replyText = (events: RuntimeEvent[]) => of(events, "item.completed").map((event) => (event as { text?: string }).text ?? "").join("");

describe("Grok's prompt_complete", () => {
  it("names each prompt by an id of its own, and a reply that follows the notification still ends the turn once, with its usage", async () => {
    const { calls, ask } = await start({ FAKE_ACP_MODE: "grok-complete" });
    const events = await ask();
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: true, stopReason: null })]);
    expect(of(events, "thread.token-usage.updated")).toEqual([expect.objectContaining({ input: 20, output: 7 })]);
    const prompt = calls().find((call) => call.method === "session/prompt")!;
    expect(prompt.meta).toEqual({ promptId: expect.stringMatching(/^omb-prompt-[\w-]+$/), requestId: prompt.meta?.promptId });
  });

  it("ends the turn on the notification alone when no reply comes", async () => {
    const { ask } = await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_REPLY: "never" });
    const events = await ask();
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: true, stopReason: null })]);
    expect(replyText(events)).toBe("answered");
  });

  it("ends the turn once when the prompt's reply comes after the notification already ended it, and the thread goes on", async () => {
    const { ask, calls, recorder } = await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_REPLY: "late-bare", FAKE_ACP_COMPLETE_REPLY_MS: "3000" });
    const [firstEnd] = of(await ask(), "turn.completed");
    expect(firstEnd).toMatchObject({ ok: true });
    // The second turn starts as the first ends and itself waits out the notification's grace, past the first reply's arrival.
    const second = await ask("and now?");
    expect(of(second, "turn.completed")).toEqual([expect.objectContaining({ ok: true })]);
    expect(replyText(second)).toBe("answered");
    expect(of(recorder.events, "turn.completed").map((event) => event.turnId)).toEqual([firstEnd!.turnId, second[0]!.turnId]);
    expect(new Set(calls().filter((call) => call.method === "session/prompt").map((call) => call.meta?.promptId)).size).toBe(2);
  });

  it("takes a notification that names no prompt for its session's one prompt out", async () => {
    const { ask } = await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_REPLY: "never", FAKE_ACP_COMPLETE_NAMES: "none" });
    expect(of(await ask(), "turn.completed")).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("ignores a background task's end and another session's, and waits for the prompt's own reply", async () => {
    const { ask } = await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_REPLY: "late", FAKE_ACP_COMPLETE_NAMES: "task,other-session" });
    const events = await ask();
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: true })]);
    expect(replyText(events)).toBe("answered late words");
    expect(of(events, "thread.token-usage.updated")).toEqual([expect.objectContaining({ input: 20, output: 7 })]);
  });

  it("says what Grok said when it ended the prompt on an error", async () => {
    const { ask } = await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_REPLY: "never", FAKE_ACP_COMPLETE_STOP: "error",
      FAKE_ACP_COMPLETE_RESULT: "API error (status 400 Bad Request): invalid_request_error: the request was malformed" });
    const events = await ask();
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: false })]);
    expect(of(events, "runtime.error").map((event) => event.message).join("\n")).toContain("the request was malformed");
  });
});

describe("Grok's rate-limit stop", () => {
  const usageLimit = (events: RuntimeEvent[]) => {
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: false, stopReason: "quota" })]);
    const [error] = of(events, "runtime.error");
    expect(error).toMatchObject({ limit: "engine" });
    expect(error!.message).toMatch(/^This Grok account has reached its usage limit/);
  };

  it.each([["the notification alone", "never"], ["the JSON-RPC error reply", "rate-limit-error"], ["the reply's own stop", "after"]])(
    "is the account's usage limit, so another AI can carry on: from %s", async (_from, reply) => {
      usageLimit(await (await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_STOP: "rate_limit", FAKE_ACP_COMPLETE_REPLY: reply })).ask());
    });

  it("keeps its own words when they name another cause, such as the service being down", async () => {
    const events = await (await start({ FAKE_ACP_MODE: "grok-complete", FAKE_ACP_COMPLETE_STOP: "rate_limit", FAKE_ACP_COMPLETE_REPLY: "never",
      FAKE_ACP_COMPLETE_RESULT: "API error (status 503 Service Unavailable): capacity" })).ask();
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: false })]);
    expect(of(events, "turn.completed")[0]!.stopReason).not.toBe("quota");
    expect(of(events, "runtime.error")[0]).not.toHaveProperty("limit");
    expect(of(events, "runtime.error")[0]!.message).toMatch(/^Grok had a temporary server problem/);
  });
});

describe("what Grok is told at start and at Stop", () => {
  it("tells Grok it is an extension client, and that a Stop is Ctrl+C", async () => {
    const { instance, recorder, calls, initialize } = await start({ FAKE_ACP_MODE: "hang" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stop", text: "hi" });
    await expect.poll(() => calls().some((call) => call.method === "session/prompt"), { timeout: 10_000 }).toBe(true);
    await instance.adapter.interruptTurn("t-stop", turnId);
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(initialize()._meta).toEqual({ clientType: "extension" });
    expect(calls().find((call) => call.method === "session/cancel")?.meta).toEqual({ cancelTrigger: "ctrl_c" });
  });

  it("tells no other ACP agent any of it", async () => {
    const { instance, recorder, calls, initialize } = await start({ FAKE_ACP_MODE: "hang" }, "custom");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-other", text: "hi" });
    await expect.poll(() => calls().some((call) => call.method === "session/prompt"), { timeout: 10_000 }).toBe(true);
    await instance.adapter.interruptTurn("t-other", turnId);
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(initialize()).not.toHaveProperty("_meta");
    expect(calls().find((call) => call.method === "session/prompt")).not.toHaveProperty("meta");
    expect(calls().find((call) => call.method === "session/cancel")).not.toHaveProperty("meta");
  });
});

describe("a Grok that could not start its threads", () => {
  it("is the server's refused spawn: the budget hears EAGAIN, and the turn says there was no room, never the runtime's words", async () => {
    const before = processBudget.counts().spawnFailed.EAGAIN;
    const { ask } = await start({ FAKE_ACP_START_FAILURE: TOKIO });
    const events = await ask();
    expect(processBudget.counts().spawnFailed.EAGAIN).toBe(before + 1);
    expect(of(events, "turn.completed")).toEqual([expect.objectContaining({ ok: false })]);
    const [error] = of(events, "runtime.error");
    expect(outOfProcesses(error!.message)).toBe(true);
    expect(error!.message).toMatch(/^There is no room to start another program \(EAGAIN\)/);
    expect(JSON.stringify(events)).not.toContain("tokio");
  });

  it("keeps another early exit's own words", async () => {
    const before = processBudget.counts().spawnFailed.EAGAIN;
    const { ask } = await start({ FAKE_ACP_START_FAILURE: "grok: config.toml: unexpected key" });
    const [error] = of(await ask(), "runtime.error");
    expect(processBudget.counts().spawnFailed.EAGAIN).toBe(before);
    expect(error!.message).toContain("unexpected key");
  });
});

describe("Grok's sign-in check failing for a moment", () => {
  // grok 1.0.41's words, as a session/prompt error on a Cloud whose Grok stayed signed in.
  const BLIP = "Internal error: Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/responses: Authentication required\n\n"
    + "  Model:     grok-4.6\n  Auth:      Oidc\n  Version:   1.0.41\n  Available: grok-4.6, grok-4.5\n\n"
    + "Authentication is temporarily unavailable (often a network blip right after wake). Your session is still signed in and will "
    + "recover automatically — retry in a few seconds; no need to run /login. (session/prompt)";

  it("is a passing failure a routine run retries, never a sign-out", () => {
    expect(classifyRoutineFailure(BLIP)).toMatchObject({ kind: "owner", cause: "signed_out" });
    const reported = grokReportedFailure(Object.assign(new Error(BLIP), { code: -32603 }));
    expect(reported).toBeInstanceOf(AcpReportedFailure);
    expect(acpRuntimeFailure(reported, "Grok").message).toBe(
      "Grok couldn't confirm its sign-in for a moment (often a network error right after waking). It is still signed in: try again in a few seconds.");
    expect(classifyRoutineFailure(reported!.message)).toMatchObject({ kind: "retry" });
  });

  it("leaves a real sign-out as it was", () => {
    expect(grokReportedFailure(Object.assign(new Error("Internal error: Unauthorized (401): Authentication required. Run grok login."), { code: -32603 }))).toBeUndefined();
  });
});
