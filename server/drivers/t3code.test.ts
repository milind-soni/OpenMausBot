import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instanceConfigs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { T3_NOT_RUNNING, T3_ONLY_FULL_ACCESS, T3CodeDriver, t3ErrorText, t3Selection } from "./t3code.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../testing/fake-t3-cli.ts");

describe("T3 Code engine", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-t3code-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await T3CodeDriver.create({
      instanceId: "t3code-test", displayName: "T3 Code", enabled: true,
      environment: { FAKE_T3_LOG: join(scratch, "calls.jsonl"), ...environment },
      config: { cli: FAKE_CLI },
    });
    recorder = recordEvents(instance.adapter);
    return { adapter: instance.adapter, recorder };
  }
  const calls = () => readFileSync(join(scratch, "calls.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
    .filter((call) => call.argv[0] !== "--version" && call.argv[1] !== "list");
  const ended = (turnId: string) => (event: RuntimeEvent) => event.type === "turn.completed" && event.turnId === turnId;
  const ofTurn = (turnId: string) => recorder!.events.filter((event) => event.turnId === turnId).map((event) => event.type);

  it("is a built-in engine in fresh and existing fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "t3codeAgent")).toBe(true);
    expect(instanceConfigs({}).t3code?.driver).toBe("t3codeAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).t3code?.driver).toBe("t3codeAgent");
  });

  it("starts a T3 thread with the persona, then resumes it by its id", async () => {
    const { adapter, recorder } = await create();
    const cwd = scratch;
    const first = await adapter.sendTurn({ threadId: "c1", text: "hello\nthere", system: "You are Maus.", cwd, model: "codex/gpt-6.2-sol", approvalMode: "full" });
    await recorder.until(ended(first.turnId));
    expect(recorder.events.find((e) => e.type === "item.completed" && e.turnId === first.turnId)).toMatchObject({ text: "echo: You are Maus.\n\nhello\nthere" });
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({ sessionId: "mcp:new-thread" });
    expect(recorder.events.find(ended(first.turnId))).toMatchObject({ ok: true });

    const second = await adapter.sendTurn({ threadId: "c1", text: "again", cwd, resumeCursor: "mcp:new-thread", approvalMode: "full" });
    await recorder.until(ended(second.turnId));
    expect(calls().map((call) => call.argv)).toEqual([
      ["thread", "start", cwd, "-", "--title", "hello", "--provider", "codex", "--model", "gpt-6.2-sol", "--wait", "--json"],
      ["thread", "send", "mcp:new-thread", "-", "--wait", "--json"],
    ]);
    expect(adapter.hasSession("c1")).toBe(true);
  });

  it("adds the folder as a T3 project when T3 Code has none for it", async () => {
    const marker = join(scratch, "no-project");
    writeFileSync(marker, "");
    const { adapter, recorder } = await create({ FAKE_T3_NO_PROJECT: marker });
    const turn = await adapter.sendTurn({ threadId: "c1", text: "hi", cwd: scratch, approvalMode: "full" });
    await recorder.until(ended(turn.turnId));
    expect(calls().map((call) => call.argv.slice(0, 2))).toEqual([["thread", "start"], ["project", "add"], ["thread", "start"]]);
    expect(existsSync(marker)).toBe(false);
    expect(recorder.events.find(ended(turn.turnId))).toMatchObject({ ok: true });
  });

  it("rebuilds a thread T3 Code no longer has from the replayed conversation, and fails without one", async () => {
    const { adapter, recorder } = await create();
    const rebuilt = await adapter.sendTurn({ threadId: "c1", text: "next", recoveryText: "earlier\nnext", resumeCursor: "mcp:gone", cwd: scratch, approvalMode: "full" });
    await recorder.until(ended(rebuilt.turnId));
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({ sessionId: "mcp:new-thread", rebuilt: true });
    expect(calls().at(-1)!.stdin).toBe("earlier\nnext");

    const blank = await adapter.sendTurn({ threadId: "c2", text: "next", resumeCursor: "mcp:gone", cwd: scratch, approvalMode: "full" });
    await recorder.until(ended(blank.turnId));
    expect(recorder.events.find((e) => e.type === "runtime.error" && e.turnId === blank.turnId)).toMatchObject({ message: "T3 Code no longer has this conversation's thread." });
  });

  it("refuses every level but Full access, since T3 Code keeps its own", async () => {
    const { adapter, recorder } = await create();
    const turn = await adapter.sendTurn({ threadId: "c1", text: "hi", cwd: scratch, approvalMode: "ask" });
    await recorder.until(ended(turn.turnId));
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ message: T3_ONLY_FULL_ACCESS, setup: true });
    expect(existsSync(join(scratch, "calls.jsonl"))).toBe(false);
  });

  it("points at the T3 thread when it waits for an answer", async () => {
    const { adapter, recorder } = await create({ FAKE_T3_ASK: "1" });
    const turn = await adapter.sendTurn({ threadId: "c1", text: "hi", cwd: scratch, approvalMode: "full" });
    await recorder.until(ended(turn.turnId));
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "T3 Code is waiting for your answer in https://app.t3.codes/threads/x/mcp:new-thread. Answer it in T3 Code, then send your next message here.",
    });
  });

  it("stops waiting on interrupt and ends the turn once", async () => {
    const { adapter, recorder } = await create({ FAKE_T3_HANG: "1" });
    const turn = await adapter.sendTurn({ threadId: "c1", text: "hi", cwd: scratch, approvalMode: "full" });
    await vi.waitFor(() => expect(existsSync(join(scratch, "calls.jsonl"))).toBe(true));
    await adapter.interruptTurn("c1", turn.turnId);
    expect(recorder.events.find(ended(turn.turnId))).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(ofTurn(turn.turnId).filter((type) => type === "turn.completed")).toHaveLength(1);
    expect(ofTurn(turn.turnId)).not.toContain("runtime.error");
  });

  it("reports T3 Code closed or missing in its snapshot", async () => {
    await create();
    expect(await instance!.snapshot()).toMatchObject({ state: "available", version: "0.1.11" });
    await instance!.dispose();
    instance = await T3CodeDriver.create({ instanceId: "t3code-down", displayName: undefined, enabled: true, environment: { FAKE_T3_DOWN: "1" }, config: { cli: FAKE_CLI } });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: T3_NOT_RUNNING });
    await instance.dispose();
    instance = await T3CodeDriver.create({ instanceId: "t3code-missing", displayName: undefined, enabled: true, environment: {}, config: { cli: join(scratch, "no-t3") } });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("parses model ids and T3's error lines", () => {
    expect(t3Selection("claudeAgent_2/claude-opus-5-5")).toEqual({ provider: "claudeAgent_2", model: "claude-opus-5-5" });
    expect(() => t3Selection("claude-opus-5-5")).toThrow(/<provider>\/<model>/);
    expect(t3ErrorText("[20:22:43.256] ERROR (#2): ProjectAlreadyExistsError: exists.\n    at x (y)")).toBe("ProjectAlreadyExistsError: exists.");
    expect(t3ErrorText("No running T3 Code server uses /x. Start T3 Code, then retry.")).toBe(T3_NOT_RUNNING);
  });
});
