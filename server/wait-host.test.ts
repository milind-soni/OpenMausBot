import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../shared/notification.ts";
import type { Message } from "./store.ts";
import { cancelWaitFromCard, createWaitHost, waitContinuesHere, waitContinuationCheck, waitRunChat, waitTurnRunId, type WaitHostDeps } from "./wait-host.ts";
import type { WaitRecord } from "./waits.ts";

const NOW = 1_700_000_000_000;
const wait: WaitRecord = {
  id: "w1", botId: "bot-1", threadId: "t-1", label: "the build", condition: { kind: "file_exists", path: "/tmp/x" },
  createdAt: NOW, expiresAt: NOW + 1000, nextCheckAt: NOW, errors: 0,
};

function fakeStore() {
  const messages: Message[] = [];
  let next = 0;
  const bots = new Map([["bot-1", { id: "bot-1", name: "Pepper", busy: false, avatarUrl: "/a.png" }]]);
  return {
    messages,
    get lines() { return messages.map(({ id: _id, at: _at, ...rest }) => rest); },
    message: (id: string) => messages.find((m) => m.id === id)!,
    appendMessage: vi.fn((_thread: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m-${++next}`, at: 1, ...message } as Message;
      messages.push(full);
      return full;
    }),
    patchMessage: vi.fn((_thread: string, id: string, patch: Partial<Message>) => {
      const index = messages.findIndex((m) => m.id === id);
      messages[index] = { ...messages[index]!, ...patch };
      return messages[index]!;
    }),
    patchTask: vi.fn(),
    messagesFor: vi.fn(() => messages),
    bot: vi.fn((id: string) => bots.get(id) ?? null),
  };
}

describe("the store side of waits", () => {
  let store: ReturnType<typeof fakeStore>;
  let busy: boolean;
  let wrote: ReturnType<typeof vi.fn<WaitHostDeps["wrote"]>>;
  let notify: ReturnType<typeof vi.fn<(n: Notification | null) => void>>;
  let enqueue: ReturnType<typeof vi.fn<WaitHostDeps["enqueue"]>>;
  let host: ReturnType<typeof createWaitHost>;
  let cloudHost: ReturnType<typeof createWaitHost>;

  beforeEach(() => {
    store = fakeStore();
    busy = false;
    wrote = vi.fn<WaitHostDeps["wrote"]>();
    notify = vi.fn();
    enqueue = vi.fn<WaitHostDeps["enqueue"]>(() => ({ id: "run-1" }));
    const deps = (cloudHome: boolean): WaitHostDeps => ({
      store: store as unknown as WaitHostDeps["store"], directChat: () => true, threadBusy: () => busy, wrote, notify, enqueue, cloudHome, now: () => NOW,
    });
    host = createWaitHost(deps(false));
    cloudHost = createWaitHost(deps(true));
  });

  it("posts a wait's line once, marks the chat unread and notifies only when it fired", () => {
    expect(host.post(wait, { status: "fired", text: "the build: done. /tmp/x is there now." })).toBe(true);
    expect(host.post(wait, { status: "fired", text: "the build: done. /tmp/x is there now." })).toBe(true);
    expect(store.lines).toEqual([{ role: "bot", kind: "text", text: "the build: done. /tmp/x is there now.", textCode: "chat.notice.waitDone.fileExists", textParams: { label: "the build", path: "/tmp/x" }, wait: { id: "w1", status: "fired" } }]);
    expect(store.patchTask).toHaveBeenCalledWith("bot-1", "t-1", { unread: true });
    expect(wrote).toHaveBeenCalledTimes(1);
    host.post({ ...wait, id: "w2" }, { status: "expired", text: "Stopped waiting for the build after 24 hours." });
    expect(notify.mock.calls.map(([n]) => n?.kind)).toEqual(["wait"]);
  });

  it("holds the line while a turn runs in the chat", () => {
    busy = true;
    expect(host.post(wait, { status: "fired", text: "x" })).toBe(false);
    expect(store.lines).toEqual([]);
  });

  it("shows a card with the follow-up, and settles it", () => {
    const id = host.showCard({ ...wait, followUp: "Deploy it." });
    expect(store.message(id!)).toMatchObject({ role: "bot", kind: "options", card: {
      title: "Waiting: the build", subtitle: "Then Pepper will: Deploy it.", options: [], answered: "allow", dismissed: true,
      autoApplied: true, requestId: "w1", tool: "wait_until", waitRequest: { waitId: "w1", label: "the build", followUp: "Deploy it." } } });
    host.settleCard({ ...wait, cardMessageId: id }, "cancelled");
    expect(store.message(id!).card).toMatchObject({ undone: true, waitRequest: { settled: "cancelled" } });
    host.settleCard({ ...wait, cardMessageId: id }, "fired");
    expect(store.message(id!).card?.waitRequest?.settled, "a card settles once").toBe("cancelled");
  });

  it("settles a card whose wait already ended when its Cancel finds nothing to stop, and only stops a wait that is there", () => {
    const id = host.showCard({ ...wait, followUp: "Deploy it." })!;
    const card = { botId: "bot-1", threadId: "t-1", messageId: id, waitId: "w1" };
    const cancel = vi.fn((): WaitRecord | null => wait);
    expect(cancelWaitFromCard({ cancel }, store, card)).toBe(true);
    expect([cancel.mock.calls, store.message(id).card?.waitRequest?.settled]).toEqual([[["w1", "bot-1"]], undefined]);
    cancel.mockReturnValue(null);
    expect(cancelWaitFromCard({ cancel }, store, card)).toBe(false);
    expect(store.message(id).card).toMatchObject({ waitRequest: { settled: "expired" } });
    expect(store.message(id).card).not.toHaveProperty("undone");
  });

  it("queues the follow-up as an outside event that joins the chat, except on a Cloud home", () => {
    host.followUp({ ...wait, followUp: "Deploy it." });
    expect(enqueue).toHaveBeenLastCalledWith({ webhookId: "wait:w1", webhookName: "the build", prompt: "[Wait finished: the build] Deploy it.",
      botId: "bot-1", runOn: "maus", deliveryId: "w1", receivedAt: NOW, eventSource: "wait", resultsThreadId: "t-1" });
    cloudHost.followUp({ ...wait, followUp: "Deploy it." });
    expect(enqueue.mock.lastCall![0]).not.toHaveProperty("resultsThreadId");
    expect(waitRunChat({ botId: "bot-1", resultsThreadId: "t-1" }, () => true, false)).toBe("t-1");
    expect(waitRunChat({ botId: "bot-1", resultsThreadId: "t-1" }, () => true, true)).toBeNull();
    expect(waitRunChat({ botId: "bot-1", resultsThreadId: "room" }, () => false, false)).toBeNull();
  });

  it("knows a deleted bot from an idle one", () => {
    expect([host.botBusy("bot-1"), host.botBusy("gone")]).toEqual([false, undefined]);
  });

  it("carries run identity only from dispatch or a continuation of the same known request", () => {
    const previous = { automationRunId: "run-1", messageId: "request-1" };
    expect(waitTurnRunId({ automationRunId: "run-2" }, previous, "request-2")).toBe("run-2");
    expect(waitTurnRunId({ cardContinuation: true }, previous, "request-1")).toBe("run-1");
    expect(waitTurnRunId({ computerSelectionContinuation: true }, previous, "request-1")).toBe("run-1");
    expect(waitTurnRunId(undefined, previous, "request-1")).toBeUndefined();
    expect(waitTurnRunId({ cardContinuation: true }, previous, undefined)).toBeUndefined();
    expect(waitTurnRunId({ cardContinuation: true }, previous, "unrelated-request")).toBeUndefined();
    expect(waitTurnRunId({ cardContinuation: true }, { ...previous, stopped: true }, "request-1")).toBeUndefined();
    expect(waitTurnRunId({ cardContinuation: true }, undefined, "request-1")).toBeUndefined();
  });

  it("binds a continuation capability to its own live request and run", () => {
    host.post(wait, { status: "fired", text: "done" });
    const run = { id: "run-1", eventSource: "wait" as const, triggerSource: "webhook" as const, botId: "bot-1", threadId: "t-1", resultsThreadId: "t-1", webhookId: "wait:w1", deliveryId: "w1" };
    const capability = { botId: "bot-1", threadId: "t-1", generation: "generation-1" };
    let request: { automationRunId?: string; stopped?: boolean; generations: Set<string> } = { automationRunId: run.id, generations: new Set([capability.generation]) };
    let active = true;
    let currentRun: typeof run | null = run;
    const deps = { active: () => active, request: () => request, run: () => currentRun, store };
    const allowed = waitContinuationCheck(capability, deps);
    expect(allowed()).toBe(true);
    request = { generations: new Set([capability.generation]) };
    expect(allowed()).toBe(false);
    request.automationRunId = "unrelated-run";
    expect(allowed()).toBe(false);
    request.automationRunId = run.id;
    expect(allowed()).toBe(true);
    request.generations = new Set(["unrelated-generation"]);
    expect(allowed()).toBe(false);
    request.generations.add(capability.generation);
    active = false;
    expect(allowed()).toBe(false);
    active = true;
    request.stopped = true;
    expect(allowed()).toBe(false);
    request.stopped = false;
    currentRun = { ...run, id: "different-run" };
    expect(allowed()).toBe(false);
    currentRun = null;
    expect(allowed()).toBe(false);
    currentRun = run;
    expect(waitContinuationCheck({ ...capability, externalRuntime: {} }, deps)()).toBe(false);
  });

  it("proves a wait continuation from the run and its fired notice in the same chat", () => {
    const run = { id: "run-1", eventSource: "wait" as const, triggerSource: "webhook" as const, botId: "bot-1", threadId: "t-1", resultsThreadId: "t-1", webhookId: "wait:w1", deliveryId: "w1" };
    expect(waitContinuesHere(run, "bot-1", "t-1", store, "run-1")).toBe(false);
    host.post(wait, { status: "fired", text: "done" });
    expect(waitContinuesHere(run, "bot-1", "t-1", store, "run-1")).toBe(true);
    expect(waitContinuesHere(run, "bot-1", "t-1", store, undefined)).toBe(false);
    expect(waitContinuesHere(run, "bot-1", "t-1", store, "unrelated-run")).toBe(false);
    expect(waitContinuesHere(null, "bot-1", "t-1", store, "run-1")).toBe(false);
    for (const patch of [
      { eventSource: "app" as const }, { eventSource: undefined }, { triggerSource: "schedule" as const },
      { id: "other" }, { botId: "other" }, { threadId: "other" }, { resultsThreadId: "other" },
      { deliveryId: "other" }, { deliveryId: undefined }, { webhookId: "other" },
    ]) expect(waitContinuesHere({ ...run, ...patch }, "bot-1", "t-1", store, "run-1")).toBe(false);
    store.messages[0]!.wait!.status = "expired";
    expect(waitContinuesHere(run, "bot-1", "t-1", store, "run-1")).toBe(false);
  });
});
