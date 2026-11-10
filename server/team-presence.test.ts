import { describe, expect, it } from "vitest";
import { createTeamPresence, GRACE_MS, PERSON_GAP_MS, THREAD_GAP_MS, WINDOW_TTL_MS, type PresenceClock, type PresenceEvent } from "./team-presence.ts";

function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; run: () => void; done: boolean }> = [];
  const clock: PresenceClock = {
    now: () => now,
    later(run, ms) {
      const timer = { at: now + ms, run, done: false };
      timers.push(timer);
      return { cancel: () => { timer.done = true; } };
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((timer) => !timer.done && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.done = true;
      next.run();
    }
    now = end;
  };
  return { clock, advance };
}

const ADA = "ada@acme.test", BEN = "ben@acme.test", CY = "cy@acme.test";
const SHARED = "t-shared", PRIVATE = "t-private", ROOM = "t-room";

function setup(readers: Record<string, string[]> = { [SHARED]: [ADA, BEN, CY], [ROOM]: [ADA, BEN] }) {
  const { clock, advance } = fakeClock();
  const events: PresenceEvent[] = [];
  const presence = createTeamPresence({ clock, emit: (event) => events.push(event),
    reads: (email, threadId) => readers[threadId]?.includes(email) ?? false });
  return { presence, events, advance };
}

describe("who is here", () => {
  it("counts a person here while a stream is open, and away only after the grace", () => {
    const { presence, events, advance } = setup();
    presence.streamOpened(ADA);
    expect(events).toEqual([{ type: "person", email: ADA, here: true }]);
    expect(presence.here(ADA)).toBe(true);
    presence.streamClosed(ADA);
    advance(GRACE_MS - 1);
    expect(presence.here(ADA)).toBe(true);
    advance(1);
    expect(presence.here(ADA)).toBe(false);
    expect(events.at(-1)).toEqual({ type: "person", email: ADA, here: false });
  });

  it("a reconnect within the grace sends nothing, and two devices keep a person here", () => {
    const { presence, events, advance } = setup();
    presence.streamOpened(ADA);
    presence.streamOpened(ADA);
    presence.streamClosed(ADA);
    advance(GRACE_MS * 2);
    expect(presence.here(ADA)).toBe(true);
    presence.streamClosed(ADA);
    advance(GRACE_MS / 2);
    presence.streamOpened(ADA);
    advance(GRACE_MS * 2);
    expect(events).toEqual([{ type: "person", email: ADA, here: true }]);
  });

  it("a flapping connection sends at most one frame per gap, with the state it ends in", () => {
    const { presence, events, advance } = setup();
    presence.streamOpened(BEN);
    presence.streamClosed(BEN);
    advance(GRACE_MS);
    expect(events.map((event) => event.type === "person" && event.here)).toEqual([true, false]);
    // Back and gone again inside the gap: the arrival waits, and by then he is gone, so nothing more goes out.
    for (let round = 0; round < 20; round += 1) { presence.streamOpened(BEN); presence.streamClosed(BEN); }
    expect(events).toHaveLength(2);
    advance(PERSON_GAP_MS);
    expect(events).toHaveLength(3);
    advance(GRACE_MS * 3);
    expect(events.filter((event) => event.type === "person")).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ here: false });
  });

  it("a window's ping alone counts, and lapses after the grace", () => {
    const { presence, advance } = setup();
    presence.window(CY, "s1:tab", null);
    expect(presence.here(CY)).toBe(true);
    advance(GRACE_MS);
    expect(presence.here(CY)).toBe(false);
  });
});

describe("who is in this conversation", () => {
  it("lists the people who have a shared conversation open, to them, coalesced", () => {
    const { presence, events, advance } = setup();
    for (const email of [ADA, BEN, CY]) presence.streamOpened(email);
    events.length = 0;
    presence.window(ADA, "a:1", SHARED);
    presence.window(BEN, "b:1", SHARED);
    expect(events).toEqual([]);
    advance(THREAD_GAP_MS);
    expect(events).toEqual([{ type: "thread", threadId: SHARED, people: [ADA, BEN] }]);
    presence.window(BEN, "b:1", ROOM);
    advance(THREAD_GAP_MS);
    expect(events.slice(1)).toEqual(expect.arrayContaining([
      { type: "thread", threadId: SHARED, people: [ADA] },
      { type: "thread", threadId: ROOM, people: [BEN] },
    ]));
  });

  it("never keeps or sends a conversation the person may not be shown in: a private chat is no conversation", () => {
    const { presence, events, advance } = setup();
    presence.streamOpened(ADA);
    presence.streamOpened(BEN);
    events.length = 0;
    presence.window(ADA, "a:1", PRIVATE);
    presence.window(CY, "c:1", ROOM);
    advance(THREAD_GAP_MS * 4);
    expect(events.filter((event) => event.type !== "person")).toEqual([]);
    expect(presence.viewers(PRIVATE)).toEqual([]);
    expect(presence.viewers(ROOM)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    // Moving from a shared chat to a private one reads as leaving the shared one, nothing more.
    presence.window(ADA, "a:1", SHARED);
    presence.window(BEN, "b:1", SHARED);
    advance(THREAD_GAP_MS);
    presence.window(ADA, "a:1", PRIVATE);
    advance(THREAD_GAP_MS);
    expect(events.at(-1)).toEqual({ type: "thread", threadId: SHARED, people: [BEN] });
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
  });

  it("checks who may read it again when it sends, and drops a person who went away", () => {
    const readers = { [SHARED]: [ADA, BEN] };
    const { presence, events, advance } = setup(readers);
    presence.streamOpened(ADA);
    presence.streamOpened(BEN);
    presence.window(ADA, "a:1", SHARED);
    presence.window(BEN, "b:1", SHARED);
    advance(THREAD_GAP_MS);
    readers[SHARED] = [BEN];
    expect(presence.viewers(SHARED)).toEqual([BEN]);
    events.length = 0;
    presence.streamClosed(BEN);
    advance(GRACE_MS + THREAD_GAP_MS);
    expect(presence.viewers(SHARED)).toEqual([]);
    expect(events.filter((event) => event.type === "thread")).toEqual([]);
  });

  it("forgets a window not heard from", () => {
    const { presence, advance } = setup();
    presence.streamOpened(ADA);
    presence.window(ADA, "a:1", SHARED);
    advance(WINDOW_TTL_MS + WINDOW_TTL_MS / 3 + 1);
    expect(presence.viewers(SHARED)).toEqual([]);
    expect(presence.here(ADA)).toBe(true);
  });

  it("forgets everything of a person who left", () => {
    const { presence, advance } = setup();
    presence.streamOpened(ADA);
    presence.window(ADA, "a:1", SHARED);
    presence.forget(ADA);
    advance(THREAD_GAP_MS);
    expect(presence.viewers(SHARED)).toEqual([]);
    expect(presence.here(ADA)).toBe(false);
  });
});
