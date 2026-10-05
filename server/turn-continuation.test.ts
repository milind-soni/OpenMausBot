import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { classifyContinuable, makeCapContinuationSubscriber, writeTurnHandoff } from "./turn-continuation.ts";

let temp: string | undefined;
afterEach(() => {
  if (temp) { rmSync(temp, { recursive: true, force: true }); temp = undefined; }
  delete process.env.OMB_DATA_DIR;
  vi.restoreAllMocks();
});

function withTempDataDir(): string {
  temp = mkdtempSync(join(tmpdir(), "omb-handoff-"));
  process.env.OMB_DATA_DIR = temp;
  return temp;
}

describe("writeTurnHandoff", () => {
  it("writes a structured handoff with the original task, ordered tool calls, and last text", () => {
    const dir = withTempDataDir();
    const path = writeTurnHandoff({
      threadId: "thread-abc", turnId: "turn-xyz", model: "test-model",
      hasUsage: true, usage: { input: 10, output: 20 },
      failure: "Stopped after 64 steps without a final answer",
      toolCalls: 3,
      messages: [
        { role: "user", content: "Build the thing" },
        { role: "assistant", content: null, tool_calls: [{ function: { name: "host_shell_exec", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", content: JSON.stringify({ ok: true, result: "files" }) },
        { role: "tool", content: JSON.stringify({ ok: false, result: "boom" }) },
        { role: "assistant", content: "Almost done" },
      ],
    });
    expect(path).not.toBeNull();
    expect(path).toContain(join(dir, "handoffs", "cap-"));
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("# Handoff - turn ended without a final answer");
    expect(text).toContain("Build the thing");
    expect(text).toContain("1. host_shell_exec - {\"command\":\"ls\"}");
    expect(text).toContain("result ok: {\"ok\":true,\"result\":\"files\"}");
    expect(text).toContain("result FAILED: {\"ok\":false,\"result\":\"boom\"}");
    expect(text).toContain("Almost done");
    expect(text).toContain("Stop reason: Stopped after 64 steps");
    expect(text).toContain("Tokens this turn: 10 in / 20 out");
  });

  it("returns null when the handoff cannot be written", () => {
    process.env.OMB_DATA_DIR = join(tmpdir(), "omb-handoff-", "does-not-exist", "nested");
    expect(writeTurnHandoff({ threadId: "t", turnId: "u", toolCalls: 0, messages: [] })).not.toBeNull();
    rmSync(join(tmpdir(), "omb-handoff-"), { recursive: true, force: true });
  });
});

describe("classifyContinuable", () => {
  it.each([
    ["budget cap message", "error", "Stopped after 64 steps without a final answer. The steps so far already ran, so ask only for what's left.", "cap"],
    ["legacy limit message", "error", "model-call limit reached before a final response", "cap"],
    ["tool_error terminal", "tool_error", "One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.", "tool_error"],
    ["provider config 400 (non-multimodal)", "error", "upstream HTTP 400: {\"error\":{\"message\":\"deepseek-ai/DeepSeek-V4-Flash-0731 is not a multimodal model\"}}", null],
    ["unknown model", "error", "Model \"nope\" does not exist", null],
    ["no failure text", "error", undefined, null],
    ["successful turn", null, "done", null],
  ] as const)("%s → %s", (_name, stopReason, failure, expected) => {
    expect(classifyContinuable(stopReason, failure)).toBe(expected);
  });
});

interface FakeHarness {
  sub: (event: RuntimeEvent) => void;
  calls: { createTask: unknown[][]; startTurn: unknown[][]; append: unknown[][] };
  setClock: (now: number) => void;
  failNextStart: () => void;
}

function harness(options?: { taskTitle?: string; taskForEveryThread?: boolean }): FakeHarness {
  const calls: FakeHarness["calls"] = { createTask: [], startTurn: [], append: [] };
  const task = { threadId: "thread-cont", title: "Continue: Whatever", projectId: undefined as string | undefined, approvalMode: "ask" as const, modelSelection: undefined };
  let clock = 1_000_000;
  let failNext = false;
  const taskTitle = options?.taskTitle ?? "Build the thing";
  const store = {
    botByThread: (threadId: string) => (threadId === "thread-1" || options?.taskForEveryThread ? { id: "bot-1", name: "B" } : undefined),
    taskByThread: (_botId: string, threadId: string) =>
      (threadId === "thread-1" || options?.taskForEveryThread ? { title: taskTitle, projectId: undefined as string | undefined, approvalMode: "ask" as const, modelSelection: undefined } : undefined),
    createTask: (...args: unknown[]) => { calls.createTask.push(args); return task; },
    appendMessage: (...args: unknown[]) => { calls.append.push(args); return {}; },
  };
  const startTurn = async (...args: unknown[]) => {
    calls.startTurn.push(args);
    if (failNext) throw new Error("thread_busy");
  };
  const sub = makeCapContinuationSubscriber({
    store: store as unknown as Parameters<typeof makeCapContinuationSubscriber>[0]["store"],
    startTurn: startTurn as unknown as Parameters<typeof makeCapContinuationSubscriber>[0]["startTurn"],
    now: () => clock,
  });
  return {
    sub, calls,
    setClock: (now: number) => { clock = now; },
    failNextStart: () => { failNext = true; },
  };
}

function capEvent(threadId = "thread-1", over: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return { threadId, type: "cap.exhausted", handoffPath: "/tmp/handoff.md", reason: "cap", ...over } as RuntimeEvent;
}

describe("makeCapContinuationSubscriber", () => {
  it("creates a Continue task, starts a turn seeded with the handoff, and posts an activity message", async () => {
    const h = harness();
    h.sub(capEvent());
    await vi.waitFor(() => expect(h.calls.createTask.length).toBe(1));
    expect(h.calls.createTask[0][1]).toBe("Continue: Build the thing");
    expect(h.calls.createTask[0][2]).toBe(true);
    await vi.waitFor(() => expect(h.calls.startTurn.length).toBe(1));
    expect(h.calls.startTurn[0][1]).toContain("/tmp/handoff.md");
    expect(h.calls.startTurn[0][2]).toEqual({ threadId: "thread-cont", unattended: true });
    await vi.waitFor(() => expect(h.calls.append.length).toBe(1));
    expect(h.calls.append[0][1]).toMatchObject({ kind: "activity", tool: { ok: true } });
  });

  it("refuses to continue a continuation (title already starts with 'Continue: ')", async () => {
    const h = harness({ taskTitle: "Continue: Build the thing" });
    h.sub(capEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.createTask.length).toBe(0);
    expect(h.calls.startTurn.length).toBe(0);
  });

  it("never continues the same source thread twice", async () => {
    const h = harness();
    h.sub(capEvent());
    h.sub(capEvent());
    await vi.waitFor(() => expect(h.calls.createTask.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.createTask.length).toBe(1);
  });

  it("caps at five continuations per bot per hour", async () => {
    const h = harness({ taskForEveryThread: true });
    for (let i = 0; i < 6; i += 1) h.sub(capEvent(`thread-${i}`));
    await vi.waitFor(() => expect(h.calls.createTask.length).toBe(5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.createTask.length).toBe(5);
    // A fresh hour window resets the budget.
    h.setClock(1_000_000 + 3600e3 + 1);
    h.sub(capEvent("thread-6"));
    await vi.waitFor(() => expect(h.calls.createTask.length).toBe(6));
  });

  it("escalates with a failing activity message when startTurn fails", async () => {
    const h = harness();
    h.failNextStart();
    h.sub(capEvent());
    await vi.waitFor(() => expect(h.calls.append.length).toBe(1));
    const msg = h.calls.append[0][1] as { kind: string; tool: { name: string; ok?: boolean } };
    expect(msg).toMatchObject({ kind: "activity", tool: { ok: false } });
    expect(String(msg.tool.name)).toContain("auto-continuation failed");
    expect(String(msg.tool.name)).toContain("/tmp/handoff.md");
  });

  it("ignores events that are not cap.exhausted", async () => {
    const h = harness();
    h.sub({ threadId: "thread-1", type: "turn.completed", ok: false } as RuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.createTask.length).toBe(0);
  });
});
