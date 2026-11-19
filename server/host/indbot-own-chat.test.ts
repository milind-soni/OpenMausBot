import { describe, expect, it } from "vitest";

import { createIndBotOwnChat } from "./indbot-own-chat.ts";

const key = (email: string) => `key:${email}`;
function world(starters: Record<string, string> = {}) {
  const moved: string[] = [];
  const bots = [
    { id: "ind-mira", threadId: "t-mira", defaultBot: { person: "Mira@Acme.test" } },
    { id: "ind-place", threadId: "t-place", defaultBot: {} },
    { id: "sales", threadId: "t-sales" },
  ];
  const own = createIndBotOwnChat({
    bots: () => bots,
    starters: { get: (threadId) => starters[threadId], set: (threadId, person) => { starters[threadId] = person; } },
    personKey: key,
    moveNotes: async (from, to, person) => { moved.push(`${from} -> ${to} (${person})`); },
  });
  return { own, starters, moved, bots };
}

describe("a member's own IndBot's main chat", () => {
  it("becomes its person's, and its notes move to their layer", async () => {
    const w = world();
    expect(await w.own.claimAll()).toBe(1);
    expect(w.starters).toEqual({ "t-mira": "key:mira@acme.test" });
    expect(w.moved).toEqual(["ind-mira -> ind-mira--member-key:mira@acme.test (key:mira@acme.test)"]);
  });

  it("is marked theirs before anything waits on the notes", () => {
    const w = world();
    void w.own.claim(w.bots[0]!);
    expect(w.starters["t-mira"]).toBe("key:mira@acme.test");
  });

  it("leaves a chat that already has its person, a place's own IndBot and every other bot alone", async () => {
    const w = world({ "t-mira": "key:someone" });
    expect(await w.own.claimAll()).toBe(0);
    expect(w.own.claim(w.bots[1]!)).toBeNull();
    expect(w.own.claim(w.bots[2]!)).toBeNull();
    expect(w.starters).toEqual({ "t-mira": "key:someone" });
    expect(w.moved).toEqual([]);
  });
});
