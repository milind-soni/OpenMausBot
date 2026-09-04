// Unit rules for the room posting budget. Every window is exercised from
// both sides — one millisecond inside it and one outside — because a
// budget that only ever refuses, or only ever allows, passes a happy-path
// test either way.
import { describe, expect, it } from "vitest";

import {
  decideRoomPost,
  emptyRoomPostBudget,
  type RoomPostBudget,
} from "./room-post-budget.ts";

const T0 = 1_760_000_000_000;

const post = (
  budget: RoomPostBudget,
  botId: string,
  text: string,
  now: number,
) => decideRoomPost(budget, { botId, botName: botId, text, now });

/** Seed a budget with allowed posts, failing loudly if one is refused. */
const seed = (entries: Array<{ botId: string; text: string; now: number }>): RoomPostBudget => {
  let budget = emptyRoomPostBudget();
  for (const entry of entries) {
    const decision = post(budget, entry.botId, entry.text, entry.now);
    if (!decision.allowed) throw new Error(`seed post was refused: ${decision.refusal}`);
    budget = decision.budget;
  }
  return budget;
};

/** A history written straight into the budget. The room ceiling is stricter
 * than both the ring and the per-sender window, so those two can only be
 * reached by handing the function a history it did not accumulate itself —
 * which is precisely what a raised ceiling would produce. */
const history = (entries: Array<[string, string, number]>): RoomPostBudget => ({
  posts: entries.map(([botId, text, at]) => ({ botId, text, at })),
});

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
    const budget = history([
      ["a", "one", T0],
      ["b", "two", T0 + 1_000],
      ["c", "three", T0 + 2_000],
    ]);
    const closing = post(budget, "a", "four", T0 + 3_000);
    expect(closing.allowed).toBe(false);
    expect(closing.allowed === false && closing.refusal).toBe("ring");
    expect(closing.budget.trippedAt).toBe(T0 + 3_000);

    // and the room stays shut for everyone, not just the bot that closed it
    const afterwards = post(closing.budget, "d", "unrelated", T0 + 4_000);
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
  });

  it("sends the room to the human on its third bot post inside five minutes", () => {
    const budget = seed([
      { botId: "a", text: "one", now: T0 },
      { botId: "b", text: "two", now: T0 + 1_000 },
    ]);
    const third = post(budget, "c", "three", T0 + 2_000);
    expect(third.allowed).toBe(false);
    expect(third.allowed === false && third.refusal).toBe("escalate");
    expect(third.allowed === false && third.message).toMatch(/ask the user/i);

    // the window slides: once the first two age out, the room reopens
    const later = post(budget, "c", "three", T0 + 5 * 60_000 + 1_001);
    expect(later.allowed).toBe(true);
  });

  it("caps one bot at ten posts a minute, and lets the cap lapse with the minute", () => {
    // The room ceiling refuses long before the sender cap does, so the cap
    // is observed through WHICH rule answers, not through an allowed post.
    const nine = history(Array.from({ length: 9 }, (_, i): [string, string, number] => ["a", `x${i}`, T0 + i]));
    const tenth = post(nine, "a", "ten", T0 + 10);
    expect(tenth.allowed === false && tenth.refusal, "nine posts must still be under the sender cap").toBe("escalate");

    const full = history(Array.from({ length: 10 }, (_, i): [string, string, number] => ["a", `x${i}`, T0 + i]));
    const eleventh = post(full, "a", "one too many", T0 + 20);
    expect(eleventh.allowed === false && eleventh.refusal).toBe("sender-rate");

    // one minute on, those ten no longer count against the sender
    const afterTheMinute = post(full, "a", "one too many", T0 + 60_001);
    expect(afterTheMinute.allowed === false && afterTheMinute.refusal).toBe("escalate");
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
    const ring = post(
      history([
        ["a", "one", T0],
        ["b", "two", T0 + 1_000],
        ["c", "three", T0 + 2_000],
      ]),
      "a",
      "four",
      T0 + 3_000,
    );
    const rate = post(
      history(Array.from({ length: 10 }, (_, i): [string, string, number] => ["a", `x${i}`, T0 + i])),
      "a",
      "one too many",
      T0 + 20,
    );
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
