import { describe, expect, it } from "vitest";

import { sameNameRefusal } from "./same-name-mentions.ts";
import { mentionedBots, roomResponders } from "./store.ts";

const analyst = { id: "quill-analyst", name: "Quill", title: "Analyst" };
const chief = { id: "quill-chief", name: "Quill", title: "", chiefOfStaff: true };
const scout = { id: "scout", name: "Scout", title: "Support agent" };
const room = [analyst, chief, scout];

describe("a person's room line that tags a name two bots share", () => {
  it("is refused in plain words that name each bot by its role", () => {
    expect(sameNameRefusal("@Quill can you check this?", room, undefined, undefined)).toBe(
      'Two bots here are named "Quill": Quill, Analyst and Quill, Chief of Staff. Pick the one you mean from the @ list.',
    );
  });

  it("names three or more, and a bot with no role by its name alone", () => {
    const plain = { id: "quill-plain", name: "QUILL", title: "  " };
    expect(sameNameRefusal("hey @quill", [...room, plain], [], "en")).toBe(
      '3 bots here are named "Quill": Quill, Analyst; Quill, Chief of Staff; QUILL. Pick the one you mean from the @ list.',
    );
  });

  it("goes when the bot was picked from the @ list, or the name is only one bot's", () => {
    expect(sameNameRefusal("@Quill can you check this?", room, [chief.id], undefined)).toBeNull();
    expect(sameNameRefusal("@Scout can you check this?", room, undefined, undefined)).toBeNull();
    expect(sameNameRefusal("@everyone standup", room, undefined, undefined)).toBeNull();
    expect(sameNameRefusal("no tags at all", room, undefined, undefined)).toBeNull();
  });
});

describe("room routing with picks", () => {
  it("sends a picked line to the picked bot alone, not the older one", () => {
    expect(roomResponders("@Quill take this", room, { kind: "member", botId: scout.id }, [chief.id])).toEqual([chief]);
    expect(mentionedBots("@Quill take this", room, [analyst.id])).toEqual([analyst]);
  });

  it("sends a bot's own unpicked tag of a shared name to every bot of that name", () => {
    expect(roomResponders("@Quill take this", room, { kind: "mentions" })).toEqual([analyst, chief]);
  });

  it("keeps @everyone and a unique name as they were", () => {
    expect(roomResponders("@everyone standup", room, { kind: "mentions" }, [chief.id])).toEqual(room);
    expect(roomResponders("@Scout look", room, { kind: "member", botId: analyst.id })).toEqual([scout]);
    expect(roomResponders("hello", room, { kind: "member", botId: analyst.id }, [chief.id])).toEqual([analyst]);
  });
});
