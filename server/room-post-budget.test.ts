// Unit rules for the room posting budget. Every window is exercised from
// both sides — one millisecond inside it and one outside — because a
// budget that only ever refuses, or only ever allows, passes a happy-path
// test either way.
//
// Nothing here writes a record into a budget by hand. Every state a rule is
// tested against is built by feeding posts through decideRoomPost and
// keeping what it hands back, so a rule that the server could never drive
// the budget into fails here instead of passing on invented history.
import { describe, expect, it } from "vitest";

import {
  decideRoomPost,
  emptyRoomPostBudget,
  type RoomPostBudget,
  type RoomPostRefusal,
} from "./room-post-budget.ts";

const T0 = 1_760_000_000_000;

/** One attempt. `lastHumanAt` is when the person last wrote in the room —
 * the ceiling counts only what nobody has answered since. */
const post = (
  budget: RoomPostBudget,
  botId: string,
  text: string,
  now: number,
  lastHumanAt?: number,
) => {
  const attempt = { botId, botName: botId, text, now };
  return decideRoomPost(budget, lastHumanAt === undefined ? attempt : { ...attempt, lastHumanAt });
};

/** Seed a budget with allowed posts, failing loudly if one is refused. */
const seed = (
  entries: Array<{ botId: string; text: string; now: number; lastHumanAt?: number }>,
): RoomPostBudget => {
  let budget = emptyRoomPostBudget();
  for (const entry of entries) {
    const decision = post(budget, entry.botId, entry.text, entry.now, entry.lastHumanAt);
    if (!decision.allowed) throw new Error(`seed post was refused: ${decision.refusal}`);
    budget = decision.budget;
  }
  return budget;
};

/** The room a ring needs: three bots, one post each, with the person
 * speaking once in the middle so the ceiling lets the third through. */
const RING_SPOKE_AT = T0 + 1_500;
const ringSetUp = (): RoomPostBudget =>
  seed([
    { botId: "a", text: "one", now: T0 },
    { botId: "b", text: "two", now: T0 + 1_000 },
    { botId: "c", text: "three", now: T0 + 2_000, lastHumanAt: RING_SPOKE_AT },
  ]);

/** One bot posting as fast as the person answers: ten posts inside a
 * minute, none of them left unanswered, so only the sender window is left
 * to stop the eleventh. */
const floodedByOneBot = (): RoomPostBudget =>
  seed(
    Array.from({ length: 10 }, (_, i) => ({
      botId: "a",
      text: `flood ${i}`,
      now: T0 + i * 100,
      lastHumanAt: T0 + i * 100 - 50,
    })),
  );

describe("decideRoomPost", () => {
  it("allows the first post into a quiet room and records it", () => {
    const decision = post(emptyRoomPostBudget(), "a", "hello", T0);
    expect(decision.allowed).toBe(true);
    expect(decision.budget.posts).toEqual([{ botId: "a", text: "hello", at: T0 }]);
  });

  it("refuses an identical repost inside the duplicate window and allows it after", () => {
    const budget = seed([{ botId: "a", text: "same", now: T0 }]);
    const soon = post(budget, "a", "same", T0 + 59_999);
    expect(soon.allowed).toBe(false);
    expect(soon.allowed === false && soon.refusal).toBe("duplicate");
    // a refused post is not remembered — the budget is unchanged
    expect(soon.budget.posts).toHaveLength(1);

    const later = post(budget, "a", "same", T0 + 60_001);
    expect(later.allowed).toBe(true);
  });

  it("lets a different bot say the same words", () => {
    const budget = seed([{ botId: "a", text: "same", now: T0 }]);
    expect(post(budget, "b", "same", T0 + 10).allowed).toBe(true);
  });

  it("trips the breaker when a third bot closes the ring back onto the first", () => {
    // A → B → C → A: nobody spoke twice, so every per-sender limit is happy
    const closing = post(ringSetUp(), "a", "four", T0 + 3_000, RING_SPOKE_AT);
    expect(closing.allowed).toBe(false);
    expect(closing.allowed === false && closing.refusal).toBe("ring");
    expect(closing.budget.trippedAt).toBe(T0 + 3_000);

    // and the room stays shut for everyone, not just the bot that closed it —
    // and for a person present in the room too, which the ceiling would not be
    const afterwards = post(closing.budget, "d", "unrelated", T0 + 4_000, T0 + 3_900);
    expect(afterwards.allowed === false && afterwards.refusal).toBe("breaker");
    // …until the cooldown ends
    const cooled = post(closing.budget, "d", "unrelated", T0 + 3_000 + 5 * 60_000 + 1);
    expect(cooled.allowed).toBe(true);
  });

  it("does not call a two-bot back-and-forth a ring", () => {
    const budget = seed([
      { botId: "a", text: "one", now: T0 },
      { botId: "b", text: "two", now: T0 + 1_000 },
    ]);
    const third = post(budget, "a", "three", T0 + 2_000);
    // it is refused, but by the room ceiling — never mislabelled as a ring
    expect(third.allowed).toBe(false);
    expect(third.allowed === false && third.refusal).toBe("escalate");

    // and once the person has spoken, the same third post is simply allowed:
    // two bots passing a message back and forth is not the shape being caught
    const answered = post(budget, "a", "three", T0 + 2_000, T0 + 1_500);
    expect(answered.allowed).toBe(true);
  });

  it("sends the room to the human on its third unanswered bot post", () => {
    const budget = seed([
      { botId: "a", text: "one", now: T0 },
      { botId: "b", text: "two", now: T0 + 1_000 },
    ]);
    const third = post(budget, "c", "three", T0 + 2_000);
    expect(third.allowed).toBe(false);
    expect(third.allowed === false && third.refusal).toBe("escalate");
    expect(third.allowed === false && third.message).toMatch(/ask the user/i);
    // and says how the room re-opens — the user just asked, so "ask the
    // user" alone hands the model nothing it can relay
    expect(third.allowed === false && third.message).toMatch(/write in the room themselves re-opens it/i);

    // the window slides: once the first two age out, the room reopens
    const later = post(budget, "c", "three", T0 + 5 * 60_000 + 1_001);
    expect(later.allowed).toBe(true);
  });

  it("re-arms the ceiling when the person writes in the room", () => {
    const budget = seed([
      { botId: "a", text: "one", now: T0 },
      { botId: "b", text: "two", now: T0 + 1_000 },
    ]);
    // the human the ceiling would have gone to fetch is already here
    const answered = post(budget, "c", "three", T0 + 2_000, T0 + 1_500);
    expect(answered.allowed).toBe(true);

    // but only for what came before them: two posts on, the room is shut again
    const fourth = post(answered.budget, "d", "four", T0 + 2_500, T0 + 1_500);
    expect(fourth.allowed).toBe(true);
    const fifth = post(fourth.budget, "e", "five", T0 + 3_000, T0 + 1_500);
    expect(fifth.allowed === false && fifth.refusal).toBe("escalate");
  });

  it("caps one bot at ten posts a minute, and lets the cap lapse with the minute", () => {
    const flooded = floodedByOneBot();
    expect(flooded.posts).toHaveLength(10);
    const eleventh = post(flooded, "a", "one too many", T0 + 1_100, T0 + 1_050);
    expect(eleventh.allowed === false && eleventh.refusal).toBe("sender-rate");

    // one minute on, those ten no longer count against the sender
    const afterTheMinute = post(flooded, "a", "one too many", T0 + 60_100, T0 + 60_050);
    expect(afterTheMinute.allowed).toBe(true);
  });

  it("reaches every one of its rules from an empty budget", () => {
    // The guard the ring and the sender window needed: a rule the server can
    // never drive the budget into is not a limiter, however green its test.
    // Every state below is accumulated by decideRoomPost itself.
    const refusals = new Set<RoomPostRefusal>();
    const record = (decision: ReturnType<typeof post>) => {
      if (!decision.allowed) refusals.add(decision.refusal);
      return decision;
    };

    record(post(seed([{ botId: "a", text: "same", now: T0 }]), "a", "same", T0 + 1));
    record(post(seed([
      { botId: "a", text: "one", now: T0 },
      { botId: "b", text: "two", now: T0 + 1 },
    ]), "c", "three", T0 + 2));
    record(post(floodedByOneBot(), "a", "one too many", T0 + 1_100, T0 + 1_050));
    const ring = record(post(ringSetUp(), "a", "four", T0 + 3_000, RING_SPOKE_AT));
    record(post(ring.budget, "d", "unrelated", T0 + 4_000, RING_SPOKE_AT));

    expect([...refusals].sort()).toEqual(["breaker", "duplicate", "escalate", "ring", "sender-rate"]);
  });

  it("tells the model to stop rather than to retry, whichever rule refuses", () => {
    const messages: string[] = [];
    const duplicate = post(seed([{ botId: "a", text: "same", now: T0 }]), "a", "same", T0 + 1);
    const ceiling = post(
      seed([
        { botId: "a", text: "one", now: T0 },
        { botId: "b", text: "two", now: T0 + 1 },
      ]),
      "c",
      "three",
      T0 + 2,
    );
    const ring = post(ringSetUp(), "a", "four", T0 + 3_000, RING_SPOKE_AT);
    const rate = post(floodedByOneBot(), "a", "one too many", T0 + 1_100, T0 + 1_050);
    for (const decision of [duplicate, ceiling, ring, rate]) {
      expect(decision.allowed).toBe(false);
      if (decision.allowed) continue;
      messages.push(decision.message);
      expect(decision.message, decision.refusal).toMatch(/do not (retry|post|call)/i);
    }
    expect(messages).toHaveLength(4);
    // the rate limiter specifically: at the limit, end the attempt
    expect(rate.allowed === false && rate.message).toMatch(/do not retry this call/i);
  });

  it("forgets posts older than every window it consults", () => {
    const budget = seed([{ botId: "a", text: "ancient", now: T0 }]);
    const decision = post(budget, "a", "fresh", T0 + 5 * 60_000 + 1);
    expect(decision.allowed).toBe(true);
    expect(decision.budget.posts.map((entry) => entry.text)).toEqual(["fresh"]);
  });
});
