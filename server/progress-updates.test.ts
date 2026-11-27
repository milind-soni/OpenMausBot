import { afterEach, describe, expect, it, vi } from "vitest";

import { attachProgressUpdates, progressUpdatesConfig } from "./progress-updates.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

function harness(enabled = true) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const appended: Array<{ threadId: string; message: Record<string, unknown> }> = [];
  const messages: Array<{ role: "user" | "bot"; kind: "text"; text: string; progressUpdate?: true }> = [
    { role: "user", kind: "text", text: "Please analyze the large export directory and summarize findings." },
  ];
  let routine = false;
  let internal = false;
  let busy = true;
  let generateCalls = 0;
  let lastPrompt = "";
  let replyImpl: (prompt: string, signal?: AbortSignal) => Promise<string> = async () => "Still scanning the exported files now.";

  const controller = attachProgressUpdates({
    bus: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    store: {
      messagesFor: () => messages,
      appendMessage: (threadId, message) => {
        appended.push({ threadId, message });
        messages.push(message as typeof messages[number]);
        return message;
      },
    },
    sideJobs: {
      text: () => ({
        via: "engine",
        generateText: async (prompt, opts) => {
          generateCalls += 1;
          lastPrompt = prompt;
          return replyImpl(prompt, opts?.signal);
        },
      }),
    },
    botForThread: () => ({ id: "bot-1", name: "Assistant" }),
    isInternalTurn: () => internal,
    isRoutineTurn: () => routine,
    isThreadBusy: () => busy,
    shouldIgnoreProviderEvent: () => false,
    getConfig: () => ({ enabled, firstAfterMs: 20, intervalMs: 25, maxPerTurn: 3 }),
  });

  const emit = (event: Partial<RuntimeEvent> & { type: RuntimeEvent["type"] }) => {
    const full = {
      eventId: "ev-1",
      provider: "antigravityAgent",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date().toISOString(),
      ...event,
    } as RuntimeEvent;
    for (const listener of listeners) listener(full);
  };

  return {
    controller,
    emit,
    appended,
    setRoutine: (v: boolean) => { routine = v; },
    setInternal: (v: boolean) => { internal = v; },
    setBusy: (v: boolean) => { busy = v; },
    setReplyImpl: (fn: (prompt: string, signal?: AbortSignal) => Promise<string>) => { replyImpl = fn; },
    getCalls: () => generateCalls,
    getLastPrompt: () => lastPrompt,
  };
}

describe("progressUpdatesConfig", () => {
  it("defaults to disabled and honors explicit config or env opt-in", () => {
    expect(progressUpdatesConfig({}, {}).enabled).toBe(false);
    expect(progressUpdatesConfig({ progressUpdates: { enabled: true } }, {}).enabled).toBe(true);
    expect(progressUpdatesConfig({}, { OMB_PROGRESS_UPDATES: "1" }).enabled).toBe(true);
    expect(progressUpdatesConfig({ progressUpdates: { enabled: true } }, { OMB_PROGRESS_UPDATES: "0" }).enabled).toBe(false);
  });
});

describe("attachProgressUpdates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when disabled", async () => {
    const h = harness(false);
    h.emit({ type: "turn.started" });
    await new Promise((r) => setTimeout(r, 60));
    expect(h.getCalls()).toBe(0);
    expect(h.appended).toHaveLength(0);
    h.controller.dispose();
  });

  it("suppresses routine turns", async () => {
    const h = harness(true);
    h.setRoutine(true);
    h.emit({ type: "turn.started" });
    await new Promise((r) => setTimeout(r, 60));
    expect(h.getCalls()).toBe(0);
    h.controller.dispose();
  });

  it("posts marked progressUpdate messages and stops at maxPerTurn", async () => {
    const h = harness(true);
    h.emit({ type: "turn.started" });
    await expect.poll(() => h.appended.length, { timeout: 2000 }).toBe(3);
    expect(h.appended.every((item) => item.message.progressUpdate === true)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.appended).toHaveLength(3);
    h.controller.dispose();
  });

  it("passes waitingOnHuman approval state accurately into the prompt", async () => {
    const h = harness(true);
    h.emit({ type: "turn.started" });
    h.emit({ type: "request.opened", requestType: "permission", requestId: "r-1", tool: "shell", summary: "Run build" });
    await expect.poll(() => h.appended.length, { timeout: 2000 }).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(h.getLastPrompt().split("\n").at(-1)!);
    expect(parsed.waitingOnHuman).toBe(true);
    expect(parsed.waitingKind).toBe("approval");
    expect(parsed.waitingSummary).toBe("Run build");
    h.controller.dispose();
  });

  it("aborts in-flight generation when turn completes so stale updates never land after completion", async () => {
    const h = harness(true);
    let aborted = false;
    let resolveSlow!: (v: string) => void;
    h.setReplyImpl((_p, signal) => new Promise<string>((resolve) => {
      resolveSlow = resolve;
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    }));
    h.emit({ type: "turn.started" });
    await expect.poll(() => h.getCalls(), { timeout: 2000 }).toBe(1);
    h.emit({ type: "turn.completed", ok: true });
    h.setBusy(false);
    expect(aborted).toBe(true);
    resolveSlow("Late update that must be discarded");
    await new Promise((r) => setTimeout(r, 40));
    expect(h.appended).toHaveLength(0);
    h.controller.dispose();
  });

  it("counts empty normalized replies toward the failure limit and stops retrying", async () => {
    const h = harness(true);
    h.setReplyImpl(async () => '  \n> ""  ');
    h.emit({ type: "turn.started" });
    await expect.poll(() => h.getCalls(), { timeout: 2000 }).toBe(3);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.getCalls()).toBe(3);
    expect(h.appended).toHaveLength(0);
    h.controller.dispose();
  });

  it("aborts and invalidates pending generation on request.opened and request.resolved transitions, then reschedules", async () => {
    const h = harness(true);
    let callNum = 0;
    let abortedFirst = false;
    let resolveFirst!: (v: string) => void;
    let abortedSecond = false;
    let resolveSecond!: (v: string) => void;

    h.setReplyImpl(async (prompt, signal) => {
      callNum += 1;
      if (callNum === 1) {
        return await new Promise<string>((resolve) => {
          resolveFirst = resolve;
          signal?.addEventListener("abort", () => { abortedFirst = true; }, { once: true });
        });
      }
      const parsed = JSON.parse(prompt.split("\n").at(-1)!);
      if (callNum === 2) {
        expect(parsed.waitingOnHuman).toBe(true);
        return await new Promise<string>((resolve) => {
          resolveSecond = resolve;
          signal?.addEventListener("abort", () => { abortedSecond = true; }, { once: true });
        });
      }
      expect(parsed.waitingOnHuman).toBe(false);
      return "Resumed executing after approval.";
    });

    h.emit({ type: "turn.started" });
    await expect.poll(() => h.getCalls(), { timeout: 2000 }).toBe(1);

    h.emit({ type: "request.opened", requestType: "permission", requestId: "r-2", tool: "shell", summary: "Run step" });
    expect(abortedFirst).toBe(true);
    resolveFirst("Stale running message before wait");

    await expect.poll(() => h.getCalls(), { timeout: 2000 }).toBe(2);
    expect(h.appended).toHaveLength(0);

    h.emit({ type: "request.resolved", requestId: "r-2" });
    expect(abortedSecond).toBe(true);
    resolveSecond("Stale waiting message after resolve");

    await expect.poll(() => h.appended.length, { timeout: 2000 }).toBe(1);
    expect(h.appended[0]!.message.text).toBe("Resumed executing after approval.");
    h.controller.dispose();
  });
});
