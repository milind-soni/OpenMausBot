import { describe, expect, it } from "vitest";

import { roomPostRefusal, sameNameRefusal, sameNameRefusalForBots, sharedNamesNote, unreachedMentionLines } from "./same-name-mentions.ts";
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

  it("wakes none of the bots of a shared name a bot tagged with no pick, and still the others it named", () => {
    expect(roomResponders("@Quill take this", room, { kind: "mentions" })).toEqual([]);
    expect(roomResponders("@Quill and @Scout take this", room, { kind: "mentions" })).toEqual([scout]);
    expect(mentionedBots("@Quill take this", room)).toEqual([analyst, chief]);
  });

  it("keeps @everyone and a unique name as they were", () => {
    expect(roomResponders("@everyone standup", room, { kind: "mentions" }, [chief.id])).toEqual(room);
    expect(roomResponders("@Scout look", room, { kind: "member", botId: analyst.id })).toEqual([scout]);
    expect(roomResponders("hello", room, { kind: "member", botId: analyst.id }, [chief.id])).toEqual([analyst]);
  });
});

describe("a bot's or another app's room line that tags a name two bots share", () => {
  const ids = `Quill, Analyst (id ${analyst.id}); Quill, Chief of Staff (id ${chief.id})`;

  it("is refused with each bot's role and id, and how to send it again", () => {
    expect(sameNameRefusalForBots("@Quill check this", room, undefined, "Launch", "posted")).toBe(
      `2 bots in the room "Launch" are named "Quill", so nothing was posted: ${ids}. Post it again with the id of the one you mean in mention_ids.`,
    );
    expect(sameNameRefusalForBots("@quill check this", room, [], "Launch", "sent")).toBe(
      `2 bots in the room "Launch" are named "Quill", so nothing was sent: ${ids}. Send it again with the id of the one you mean in mentions.`,
    );
    expect(sameNameRefusalForBots("@Quill check this", room, [analyst.id], "Launch", "sent")).toBeNull();
  });

  it("checks a post's ids before its names", () => {
    const launch = { name: "Launch", memberIds: room.map((bot) => bot.id) };
    const lookup = (id: string) => room.find((bot) => bot.id === id);
    expect(roomPostRefusal(undefined, "@Quill check this", launch, lookup)).toEqual({ status: 409, error: expect.stringContaining(ids) });
    expect(roomPostRefusal([chief.id], "@Quill check this", launch, lookup)).toBeNull();
    expect(roomPostRefusal("quill-chief", "@Quill check this", launch, lookup)).toEqual({ status: 400, error: "mention_ids must be a list of up to 20 bot ids" });
    expect(roomPostRefusal(undefined, "@Scout check this", launch, lookup)).toBeNull();
  });

  it("tells the person under a bot's reply which tags reached nobody", () => {
    const outsider = { id: "bolt", name: "Bolt" };
    expect(unreachedMentionLines("@Quill and @Bolt, and @Scout", room, [outsider], undefined)).toEqual([
      "Bolt isn't in this room, so that mention didn't reach them — add them to the room to bring them in.",
      'More than one bot here is named "Quill", so that mention reached none of them.',
    ]);
    expect(unreachedMentionLines("@Scout look", room, [outsider], undefined)).toEqual([]);
  });

  it("tells a bot every turn which other members share a name, by id", () => {
    expect(sharedNamesNote(room, true)).toBe(
      `Some members here share a name, so an @mention of that name reaches none of them: "Quill" is ${ids}. To bring one in, use coordinate_bots with its id.`,
    );
    expect(sharedNamesNote(room, false)).not.toContain("coordinate_bots");
    expect(sharedNamesNote([analyst, scout], true)).toBe("");
  });
});
