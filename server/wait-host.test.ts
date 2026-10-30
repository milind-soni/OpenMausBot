import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../shared/notification.ts";
import type { Message } from "./store.ts";
import { cancelWaitFromCard, createWaitHost, waitRunChat, type WaitHostDeps } from "./wait-host.ts";
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
    expect(host.post(wait, { status: "fired", text: "the build: done. ci passed." })).toBe(true);
    expect(host.post(wait, { status: "fired", text: "the build: done. ci passed." })).toBe(true);
    expect(store.lines).toEqual([{ role: "bot", kind: "text", text: "the build: done. ci passed.", wait: { id: "w1", status: "fired" } }]);
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
});
