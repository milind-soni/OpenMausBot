import { describe, expect, it } from "vitest";

import type { StoreChange } from "../store.ts";
import { createBotNameClash } from "./bot-name-clash.ts";

type Bot = { id: string; name: string; threadId: string; hidden?: boolean };

/** Bots in memory, the team's people, and the owner's own name. */
function world(bots: Bot[], profileName?: string) {
  const listeners = new Set<(change: StoreChange) => void>();
  const notices: Array<{ threadId: string; name: string }> = [];
  const store = {
    bots,
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    appendMessage: (threadId: string, message: { tool?: { name: string } }) => { notices.push({ threadId, name: message.tool!.name }); return {}; },
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const clash = createBotNameClash({
    store: store as never, profileName: () => profileName,
    people: () => [{ name: "Bob Stone", tags: ["Bob Stone", "Bob"] }, { name: "Ada", tags: ["Ada"] }],
  });
  const changed = (botId: string) => { for (const listener of listeners) listener({ type: "bot", botId }); };
  return { clash, notices, changed, bots };
}

describe("a bot named like a person here", () => {
  it("says so once in its own chat when it is made or renamed with a teammate's name", () => {
    const w = world([{ id: "scout", name: "Scout", threadId: "scout-main" }]);
    w.bots.push({ id: "bob", name: "Bob", threadId: "bob-main" });
    w.changed("bob");
    w.changed("bob");
    expect(w.notices).toEqual([{ threadId: "bob-main", name: 'notice: Bob Stone is also a person here, so "@Bob" reaches Bob Stone, not this bot. Rename the bot to keep them apart.' }]);
    w.bots[0]!.name = "ada";
    w.changed("scout");
    expect(w.notices.at(-1)).toEqual({ threadId: "scout-main", name: 'notice: Ada is also a person here, so "@ada" reaches Ada, not this bot. Rename the bot to keep them apart.' });
    w.bots[0]!.name = "Scout";
    w.changed("scout");
    expect(w.notices).toHaveLength(2);
  });

  it("counts the owner's own name, and says nothing for a name nobody here goes by, or about bots already there at start", () => {
    const w = world([{ id: "old", name: "Ada", threadId: "old-main" }], "Sam Lee");
    w.changed("old");
    expect(w.notices).toEqual([]);
    expect(w.clash.warning("Sam Lee")).toContain('"@Sam Lee" reaches Sam Lee');
    expect(w.clash.warning("Scout")).toBeNull();
    expect(w.clash.warning("Bob's helper")).toBeNull();
  });

  it("stays quiet for an archived bot", () => {
    const w = world([]);
    w.bots.push({ id: "bob", name: "Bob", threadId: "bob-main", hidden: true });
    w.changed("bob");
    expect(w.notices).toEqual([]);
  });
});
