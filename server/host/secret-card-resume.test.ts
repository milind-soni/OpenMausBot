import { describe, expect, it, vi } from "vitest";

import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { Message } from "../store.ts";
import {
  createSecretCardResumer,
  directContinuationError,
  roomContinuationError,
  roomContinuationNotStartedError,
  roomRequestMessageIdForCards,
  type DirectContinuationOptions,
  type MovedOnCardContext,
  type RoomContinuationOptions,
} from "./secret-card-resume.ts";

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
  const startedDirect: Array<{ botId: string; threadId: string; text: string; options?: DirectContinuationOptions }> = [];
  const startedRoom: Array<{ groupId: string; botId: string; threadId: string; text: string; options?: RoomContinuationOptions }> = [];
  let directImpl: ((botId: string, threadId: string, text: string, opts?: DirectContinuationOptions) => Promise<unknown>) | undefined;
  let roomImpl: ((groupId: string, botId: string, threadId: string, text: string, opts?: RoomContinuationOptions) => Promise<unknown>) | undefined;
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
    startDirectContinuation: async (botId, threadId, text, directOptions) => {
      startedDirect.push({ botId, threadId, text, options: directOptions });
      if (directImpl) return directImpl(botId, threadId, text, directOptions);
    },
    startRoomContinuation: async (groupId, botId, threadId, text, roomOptions) => {
      startedRoom.push({ groupId, botId, threadId, text, options: roomOptions });
      if (roomImpl) return roomImpl(groupId, botId, threadId, text, roomOptions);
    },
  });

  const moveOn = (cardIds: string[], answeredIds: string[], overrides: Partial<MovedOnCardContext> = {}) => {
    resumer.noteTurnMovedOn(overrides.threadId ?? "t-1", cardIds, answeredIds, {
      nodeId: "node-1",
      botId: "bot-1",
      threadId: "t-1",
      ...(options.group ? { groupId: options.group.id } : {}),
      ...overrides,
    });
  };

  return {
    lines,
    resumer,
    waitingCards,
    startedDirect,
    startedRoom,
    moveOn,
    drainScheduled: () => drainScheduled,
    setDirectBlocked: (value: boolean) => { directBlocked = value; },
    setRoomBlocked: (value: boolean) => { roomBlocked = value; },
    setDirectImpl: (fn: typeof directImpl) => { directImpl = fn; },
    setRoomImpl: (fn: typeof roomImpl) => { roomImpl = fn; },
  };
}

describe("createSecretCardResumer", () => {
  it("resumes only sibling cards whose own parked turn moved on, never untracked cards", () => {
    const f = makeFixture();
    const untracked = makeCard("c-untracked", "Untracked", { provided: true });
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
      makeCard("c3", "Key Three", { provided: true }),
      untracked,
    );
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toEqual([]);
    expect(untracked.secret!.resumed).toBeUndefined();

    f.moveOn(["c1", "c2", "c3"], ["c1"], { requestMessageId: "req-1", delegated: true });
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    expect(f.startedDirect).toHaveLength(1);
    expect(f.startedDirect[0]).toMatchObject({
      botId: "bot-1",
      threadId: "t-1",
      text: "update(c2:Key Two:provided)\n\nupdate(c3:Key Three:provided)",
    });
    expect(f.startedDirect[0]!.options?.requestMessageId).toBe("req-1");
    expect(f.startedDirect[0]!.options?.delegated).toBe(true);
    expect(f.lines[1]!.secret!.resumed).toBe(true);
    expect(f.lines[2]!.secret!.resumed).toBe(true);
    expect(untracked.secret!.resumed).toBeUndefined();

    // A card saved after the turn ended (not on the parked node) starts no new turn.
    const late = makeCard("c4", "Key Four", { provided: true });
    f.lines.push(late);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toHaveLength(1);
    expect(late.secret!.resumed).toBeUndefined();
  });

  it("schedules drain immediately when a moved-on sibling card is already provided", () => {
    const f = makeFixture({ directBlocked: true });
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
    );
    f.moveOn(["c1", "c2"], ["c1"]);
    expect(f.drainScheduled()).toBe(1);
    f.resumer.drain();
    expect(f.startedDirect).toEqual([]);

    f.setDirectBlocked(false);
    f.resumer.drain();
    expect(f.startedDirect).toHaveLength(1);
    expect(f.startedDirect[0]!.text).toBe("update(c2:Key Two:provided)");
    expect(f.lines[1]!.secret!.resumed).toBe(true);
  });

  it("queues cards saved while a turn is running and coalesces them into one turn on drain", () => {
    const f = makeFixture({ directBlocked: true });
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
      makeCard("c3", "Key Three", { provided: true }),
      makeCard("c4", "Key Four"),
    );
    f.moveOn(["c1", "c2", "c3", "c4"], ["c1"]);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.lines[1]!.secret!.resumed).toBeUndefined();
    expect(f.startedDirect).toEqual([]);

    f.lines[3]!.secret!.provided = true;
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toEqual([]);

    f.setDirectBlocked(false);
    f.resumer.drain();
    expect(f.startedDirect).toHaveLength(1);
    expect(f.startedDirect[0]!.text).toBe(
      "update(c2:Key Two:provided)\n\nupdate(c3:Key Three:provided)\n\nupdate(c4:Key Four:provided)",
    );
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
    f.moveOn(["c-stopped", "c-superseded", "c-dismissed", "c-waiting"], []);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toEqual([]);
    f.resumer.drain();
    expect(f.startedDirect).toEqual([]);
  });

  it("drops tracked sibling cards on forgetThread and forgetNode", () => {
    const f = makeFixture();
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
      makeCard("c3", "Key Three", { provided: true }),
    );
    f.moveOn(["c1", "c2"], ["c1"], { nodeId: "node-a" });
    f.moveOn(["c3"], [], { nodeId: "node-b" });
    expect(f.resumer.trackedCardIds("t-1")).toEqual(["c2", "c3"]);

    f.resumer.forgetNode("node-a");
    expect(f.resumer.trackedCardIds("t-1")).toEqual(["c3"]);

    f.resumer.forgetThread("t-1");
    expect(f.resumer.trackedCardIds("t-1")).toEqual([]);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    expect(f.startedDirect).toEqual([]);
  });

  it("resumes room cards via room continuation and respects room busy state", () => {
    const f = makeFixture({ group: { id: "room-1" }, roomBlocked: true });
    f.lines.push(
      { ...makeCard("c-other", "Other Bot", { provided: true }), from: { botId: "bot-2", name: "Two", color: "blue" } } as Message,
      { ...makeCard("c-first", "First", { provided: true, resumed: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message,
      { ...makeCard("c-mine", "Mine", { provided: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message,
    );
    f.moveOn(["c-first", "c-mine"], ["c-first"], { threadId: "room-t1" });
    expect(f.resumer.resume("bot-1", "room-t1")).toBe(false);
    expect(f.startedRoom).toEqual([]);

    f.setRoomBlocked(false);
    f.resumer.drain();
    expect(f.startedRoom).toHaveLength(1);
    expect(f.startedRoom[0]).toMatchObject({
      groupId: "room-1",
      botId: "bot-1",
      threadId: "room-t1",
      text: "update(c-mine:Mine:provided)",
    });
    expect(f.lines[0]!.secret!.resumed).toBeUndefined();
    expect(f.lines[2]!.secret!.resumed).toBe(true);
  });

  it("re-queues retryable direct dispatch errors, handles late callbacks, and preserves post-dispatch outcomes", async () => {
    const f = makeFixture();
    f.lines.push(
      makeCard("c1", "Key One", { provided: true, resumed: true }),
      makeCard("c2", "Key Two", { provided: true }),
    );
    f.moveOn(["c1", "c2"], ["c1"]);
    f.setDirectImpl(async () => {
      throw Object.assign(new Error("thread busy"), { code: "thread_busy" });
    });
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    await vi.waitFor(() => {
      expect(f.lines[1]!.secret!.resumed).toBeUndefined();
    });
    expect(f.lines[1]!.secret!.error).toBeUndefined();

    // Retryable late callback restores card and schedules drain; permanent late callback records error.
    f.setDirectImpl(undefined);
    f.resumer.drain();
    expect(f.lines[1]!.secret!.resumed).toBe(true);
    f.startedDirect[1]!.options!.onLateError!(directContinuationError("this bot is being updated", false));
    expect(f.lines[1]!.secret!.resumed).toBeUndefined();
    expect(f.lines[1]!.secret!.error).toBeUndefined();

    // Post-dispatch failure keeps resumed: true and never replays.
    f.resumer.drain();
    f.startedDirect[2]!.options!.onLateError!(directContinuationError("computer lost mid-turn", true));
    expect(f.lines[1]!.secret!.resumed).toBe(true);
    expect(f.lines[1]!.secret!.error).toBe("computer lost mid-turn");
    f.resumer.drain();
    expect(f.startedDirect).toHaveLength(3);
  });

  it("keeps pending intact while cards sit on a waiting node so sibling cards still resume after settlement", () => {
    const f = makeFixture({ waitingCards: ["c1", "c2"] });
    f.lines.push(
      makeCard("c1", "Key One", { provided: true }),
      makeCard("c2", "Key Two", { provided: true }),
    );
    f.moveOn(["c1", "c2"], ["c1"]);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(false);
    f.resumer.drain();
    expect(f.startedDirect).toEqual([]);

    f.lines[0]!.secret!.resumed = true;
    f.waitingCards.clear();
    f.resumer.drain();
    expect(f.startedDirect).toHaveLength(1);
    expect(f.startedDirect[0]!.text).toBe("update(c2:Key Two:provided)");
    expect(f.lines[1]!.secret!.resumed).toBe(true);
  });

  it("rolls back, schedules drain, and retries when startRoomContinuation rejects with a skipped room error", async () => {
    const f = makeFixture({ group: { id: "room-1" } });
    f.lines.push(
      { ...makeCard("c-0", "Zero", { provided: true, resumed: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message,
      { ...makeCard("c-room", "Room Key"), from: { botId: "bot-1", name: "One", color: "green" } } as Message,
    );
    f.moveOn(["c-0", "c-room"], ["c-0"], { threadId: "room-t1" });
    f.lines[1]!.secret!.provided = true;
    f.setRoomImpl(async () => {
      throw roomContinuationNotStartedError(false, "One became busy in another conversation — skipped this round");
    });
    expect(f.resumer.resume("bot-1", "room-t1")).toBe(true);
    await vi.waitFor(() => {
      expect(f.lines[1]!.secret!.resumed).toBeUndefined();
    });
    expect(f.lines[1]!.secret!.error).toBeUndefined();
    expect(f.drainScheduled()).toBe(1);

    f.setRoomImpl(undefined);
    f.resumer.drain();
    expect(f.startedRoom).toHaveLength(2);
    expect(f.lines[1]!.secret!.resumed).toBe(true);

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
    f.moveOn(["c-wait", "c-ready"], []);
    expect(f.resumer.resume("bot-1", "t-1")).toBe(true);
    expect(f.startedDirect).toHaveLength(1);
    expect(f.startedDirect[0]!.text).toBe("update(c-ready:Ready Key:provided)");
    expect(f.lines[0]!.secret!.resumed).toBeUndefined();
    expect(f.lines[1]!.secret!.resumed).toBe(true);

    f.waitingCards.clear();
    f.resumer.drain();
    expect(f.startedDirect).toHaveLength(2);
    expect(f.startedDirect[1]!.text).toBe("update(c-wait:Waiting Key:provided)");
    expect(f.lines[0]!.secret!.resumed).toBe(true);
  });

  it("finds the preceding person request id for room cards and passes it with late-error callbacks", async () => {
    const req = { id: "u-ask", at: 90, role: "user", kind: "text", text: "Check mail" } as Message;
    const aside = { id: "u-aside", at: 95, role: "user", kind: "text", text: "fyi", aside: true } as Message;
    const card1 = { ...makeCard("c-1", "Key One", { provided: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message;
    const card2 = { ...makeCard("c-2", "Key Two", { provided: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message;
    expect(roomRequestMessageIdForCards([req, aside, card1, card2], [card2])).toBe("u-ask");
    expect(roomRequestMessageIdForCards([req, { id: "u-peer", at: 96, role: "user", kind: "text", text: "peer", peerAsk: { botId: "b0" } } as Message, card1], [card1])).toBeUndefined();
    expect(roomRequestMessageIdForCards([card1], [card1])).toBeUndefined();

    const f = makeFixture({ group: { id: "room-1" } });
    const reqRoom = { id: "u-room-ask", at: 90, role: "user", kind: "text", text: "Check inbox" } as Message;
    const c0 = { ...makeCard("c-0", "Zero", { provided: true, resumed: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message;
    const card = { ...makeCard("c-late", "Late Reject Key"), from: { botId: "bot-1", name: "One", color: "green" } } as Message;
    f.lines.push(reqRoom, c0, card);
    f.moveOn(["c-0", "c-late"], ["c-0"], { threadId: "room-t1" });
    card.secret!.provided = true;
    expect(f.resumer.resume("bot-1", "room-t1")).toBe(true);
    expect(f.startedRoom[0]!.options?.requestMessageId).toBe("u-room-ask");

    const onLateError = f.startedRoom[0]!.options!.onLateError!;
    onLateError(roomContinuationError(false, "provider busy", false));
    expect(card.secret!.resumed).toBeUndefined();
    expect(card.secret!.error).toBeUndefined();
    expect(f.drainScheduled()).toBe(1);

    onLateError(new Error("duplicate failure"));
    expect(card.secret!.error).toBeUndefined();

    const fPost = makeFixture({ group: { id: "room-1" } });
    const postCard0 = { ...makeCard("c-post-0", "Zero", { provided: true, resumed: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message;
    const postCard = { ...makeCard("c-post-late", "Post Late Key", { provided: true }), from: { botId: "bot-1", name: "One", color: "green" } } as Message;
    fPost.lines.push(reqRoom, postCard0, postCard);
    fPost.moveOn(["c-post-0", "c-post-late"], ["c-post-0"], { threadId: "room-t1" });
    expect(fPost.resumer.resume("bot-1", "room-t1")).toBe(true);
    fPost.startedRoom[0]!.options!.onLateError!(roomContinuationError(true, "aborted after reply", true));
    expect(postCard.secret!.resumed).toBe(true);
    expect(postCard.secret!.error).toBe("aborted after reply");
  });
});
