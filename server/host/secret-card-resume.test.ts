import { describe, expect, it, vi } from "vitest";

import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { Message } from "../store.ts";
import { createSecretCardResumer, roomContinuationNotStartedError } from "./secret-card-resume.ts";

function makeCard(id: string, label: string, extra: Partial<SecretRequestCardData> = {}): Message {
  return {
    id,
    at: 100,
    role: "bot",
    kind: "secret",
    text: `Provide ${label}`,
    secret: {
      target: "customSecret",
      label,
      description: `Need ${label}`,
      placeholder: "",
      helpUrl: "",
      delivery: "ref",
      requestKey: `rk-${id}`,
      ...extra,
    },
  } as Message;
}

function makeFixture(options: { group?: { id: string }; directBlocked?: boolean; roomBlocked?: boolean; waitingCards?: string[] } = {}) {
  const lines: Message[] = [];
  let directBlocked = options.directBlocked ?? false;
  let roomBlocked = options.roomBlocked ?? false;
  const waitingCards = new Set(options.waitingCards ?? []);
  const startedDirect: Array<{ botId: string; threadId: string; text: string }> = [];
  const startedRoom: Array<{ groupId: string; botId: string; threadId: string; text: string }> = [];
  let directImpl: ((botId: string, threadId: string, text: string) => Promise<unknown>) | undefined;
  let roomImpl: ((groupId: string, botId: string, threadId: string, text: string) => Promise<unknown>) | undefined;
  let drainScheduled = 0;

  const store = {
    activePath: () => [...lines],
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => {
      const target = lines.find((line) => line.id === id);
      if (target) Object.assign(target, patch);
      return target ?? null;
    },
  };

  const resumer = createSecretCardResumer({
    store,
    connectorThread: () => ({ group: options.group }),
    updateText: (messageId, secret, outcome) => `update(${messageId}:${secret.label}:${outcome})`,
    isWaitingCard: (_threadId, messageId) => waitingCards.has(messageId),
    isDirectBlocked: () => directBlocked,
    isRoomBlocked: () => roomBlocked,
    scheduleDrain: () => { drainScheduled += 1; },
    startDirectContinuation: async (botId, threadId, text) => {
      startedDirect.push({ botId, threadId, text });
      if (directImpl) return directImpl(botId, threadId, text);
    },
    startRoomContinuation: async (groupId, botId, threadId, text) => {
      startedRoom.push({ groupId, botId, threadId, text });
      if (roomImpl) return roomImpl(groupId, botId, threadId, text);
    },
  });

  return {
    lines,
    resumer,
    waitingCards,
    startedDirect,
    startedRoom,
    drainScheduled: () => drainScheduled,
    setDirectBlocked: (value: boolean) => { directBlocked = value; },
    setRoomBlocked: (value: boolean) => { roomBlocked = value; },
    setDirectImpl: (fn: ((botId: string, threadId: string, text: string) => Promise<unknown>) | undefined) => { directImpl = fn; },
    setRoomImpl: (fn: ((groupId: string, botId: string, threadId: string, text: string) => Promise<unknown>) | undefined) => { roomImpl = fn; },
  };
}

describe("createSecretCardResumer", () => {
  it("resumes sequential saved cards when no coordinator node holds them", () => {
    const f = makeFixture();
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
      makeCard("c3", "Key Three", { provided: true }),
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    expect(f.startedDirect).toEqual([
      {
        botId: "bot-1",
        threadId: "t-1",
        text: "update(c2:Key Two:provided)\n\nupdate(c3:Key Three:provided)",
      },
    ]);
    expect(f.lines[1]!.secret!.resumed).toBe(true);
    expect(f.lines[2]!.secret!.resumed).toBe(true);

    const c4 = makeCard("c4", "Key Four", { provided: true });
    f.lines.push(c4);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    expect(f.startedDirect).toHaveLength(2);
    expect(f.startedDirect[1]!.text).toBe("update(c4:Key Four:provided)");
    expect(c4.secret!.resumed).toBe(true);
  });

  it("queues cards saved while a turn is running and coalesces them into one turn on drain", () => {
    const f = makeFixture({ directBlocked: true });
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.lines[1]!.secret!.resumed).toBeUndefined();
    expect(f.startedDirect).toEqual([]);

    f.lines.push(
      makeCard("c3", "Key Three", { provided: true }),
      makeCard("c4", "Key Four", { provided: true }),
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toEqual([]);

    f.setDirectBlocked(false);
    f.resumer.drain();
    expect(f.startedDirect).toEqual([
      {
        botId: "bot-1",
        threadId: "t-1",
        text: "update(c2:Key Two:provided)\n\nupdate(c3:Key Three:provided)\n\nupdate(c4:Key Four:provided)",
      },
    ]);
    expect(f.lines.slice(1).every((line) => line.secret?.resumed === true)).toBe(true);

    f.resumer.drain();
    expect(f.startedDirect).toHaveLength(1);
  });

  it("skips stopped, superseded, unprovided, or waiting-node cards", () => {
    const f = makeFixture({ waitingCards: ["c-waiting"] });
    f.lines.push(
      makeCard("c-stopped", "Stopped", { provided: true, stopped: true }),
      makeCard("c-superseded", "Superseded", { provided: true, superseded: true }),
      makeCard("c-dismissed", "Dismissed", { dismissed: true }),
      makeCard("c-waiting", "Waiting", { provided: true }),
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toEqual([]);
    f.resumer.drain();
    expect(f.startedDirect).toEqual([]);
  });

  it("resumes room cards via room continuation and respects room busy state", () => {
    const f = makeFixture({ group: { id: "room-1" }, roomBlocked: true });
    f.lines.push(
      { ...makeCard("c-other", "Other Bot", { provided: true }), from: { botId: "bot-2", name: "Two", color: "blue" } } as Message,
      { ...makeCard("c-mine", "Mine", { provided: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message,
    );
    expect(f.resumer.resume("bot-1", "room-t1")).toBe(false);
    expect(f.startedRoom).toEqual([]);

    f.setRoomBlocked(false);
    f.resumer.drain();
    expect(f.startedRoom).toEqual([
      { groupId: "room-1", botId: "bot-1", threadId: "room-t1", text: "update(c-mine:Mine:provided)" },
    ]);
    expect(f.lines[0]!.secret!.resumed).toBeUndefined();
    expect(f.lines[1]!.secret!.resumed).toBe(true);
  });

  it("re-queues retryable dispatch rejections and records permanent errors", async () => {
    const f = makeFixture();
    f.lines.push(makeCard("c2", "Key Two", { provided: true }));
    f.setDirectImpl(async () => {
      throw Object.assign(new Error("thread busy"), { code: "thread_busy" });
    });
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    await vi.waitFor(() => {
      expect(f.lines[0]!.secret!.resumed).toBeUndefined();
    });
    expect(f.lines[0]!.secret!.error).toBeUndefined();

    f.setDirectImpl(async () => {
      throw new Error("no cloud computer");
    });
    f.resumer.drain();
    await vi.waitFor(() => {
      expect(f.lines[0]!.secret!.error).toBe("no cloud computer");
    });
    expect(f.lines[0]!.secret!.resumed).toBeUndefined();
  });

  it("keeps pending intact while cards sit on a waiting node so sibling cards still resume after settlement", () => {
    const f = makeFixture({ waitingCards: ["c1", "c2"] });
    f.lines.push(
      makeCard("c1", "Key One", { provided: true }),
      makeCard("c2", "Key Two", { provided: true }),
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    // Draining while both cards are parked on a waiting node must not wipe pending.
    f.resumer.drain();
    expect(f.startedDirect).toEqual([]);

    // Reconcile consumes c1 and the parked node finishes, leaving c2 off any waiting node.
    f.lines[0]!.secret!.resumed = true;
    f.waitingCards.clear();
    f.resumer.drain();
    expect(f.startedDirect).toEqual([
      { botId: "bot-1", threadId: "t-1", text: "update(c2:Key Two:provided)" },
    ]);
    expect(f.lines[1]!.secret!.resumed).toBe(true);
  });

  it("rolls back, schedules drain, and retries when startRoomContinuation rejects with a skipped room error", async () => {
    const f = makeFixture({ group: { id: "room-1" } });
    f.lines.push({ ...makeCard("c-room", "Room Key", { provided: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message);
    f.setRoomImpl(async () => {
      throw roomContinuationNotStartedError(false, "One became busy in another conversation — skipped this round");
    });
    expect(f.resumer.resume("bot-1", "room-t1")).toBe(true);
    await vi.waitFor(() => {
      expect(f.lines[0]!.secret!.resumed).toBeUndefined();
    });
    expect(f.lines[0]!.secret!.error).toBeUndefined();
    expect(f.drainScheduled()).toBe(1);

    f.setRoomImpl(undefined);
    f.resumer.drain();
    expect(f.startedRoom).toHaveLength(2);
    expect(f.lines[0]!.secret!.resumed).toBe(true);

    const permanent = roomContinuationNotStartedError(false, "no cloud computer");
    expect(permanent.code).toBeUndefined();
    expect(roomContinuationNotStartedError(true, undefined).code).toBe("thread_busy");
  });

  it("keeps (botId, threadId) pending when one provided card starts while another card is still waiting", () => {
    const f = makeFixture({ waitingCards: ["c-wait"] });
    f.lines.push(
      makeCard("c-wait", "Waiting Key", { provided: true }),
      makeCard("c-ready", "Ready Key", { provided: true }),
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    expect(f.startedDirect).toEqual([
      { botId: "bot-1", threadId: "t-1", text: "update(c-ready:Ready Key:provided)" },
    ]);
    expect(f.lines[0]!.secret!.resumed).toBeUndefined();
    expect(f.lines[1]!.secret!.resumed).toBe(true);

    f.waitingCards.clear();
    f.resumer.drain();
    expect(f.startedDirect).toEqual([
      { botId: "bot-1", threadId: "t-1", text: "update(c-ready:Ready Key:provided)" },
      { botId: "bot-1", threadId: "t-1", text: "update(c-wait:Waiting Key:provided)" },
    ]);
    expect(f.lines[0]!.secret!.resumed).toBe(true);
  });
});
