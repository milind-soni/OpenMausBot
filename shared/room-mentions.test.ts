import { describe, expect, it } from "vitest";

import { MENTION_PICKS_MAX, parseMentionPicks, resolveMentions } from "./room-mentions.ts";

const analyst = { id: "quill-analyst", name: "Quill", title: "Analyst" };
const chief = { id: "quill-chief", name: "quill", chiefOfStaff: true };
const scout = { id: "scout", name: "Scout" };
const room = [analyst, chief, scout];
const ids = (bots: Array<{ id: string }>) => bots.map((bot) => bot.id);

describe("resolveMentions", () => {
  it("reaches the picked bot among two that share a name, and only it", () => {
    expect(resolveMentions("@Quill can you check this?", room, [chief.id])).toEqual({ bots: [chief], ambiguous: [] });
    expect(resolveMentions("@Quill can you check this?", room, [analyst.id])).toEqual({ bots: [analyst], ambiguous: [] });
  });

  it("reaches both when both were picked, in the order the line names them", () => {
    expect(ids(resolveMentions("@Scout and @Quill", room, [chief.id, analyst.id]).bots)).toEqual([scout.id, analyst.id, chief.id]);
  });

  it("reports a typed name two bots share with both bots, instead of the first one", () => {
    const typed = resolveMentions("@quill can you check this?", room);
    expect(typed.ambiguous).toEqual([[analyst, chief]]);
    expect(typed.bots).toEqual([analyst, chief]);
  });

  it("reports a shared name once however often the line tags it", () => {
    expect(resolveMentions("@Quill, @QUILL and (@quill)", room).ambiguous).toEqual([[analyst, chief]]);
  });

  it("still resolves a name only one bot has, with or without a pick", () => {
    expect(resolveMentions("@Scout look", room)).toEqual({ bots: [scout], ambiguous: [] });
    expect(resolveMentions("@Scout look", room, [scout.id])).toEqual({ bots: [scout], ambiguous: [] });
  });

  it("never adds a picked bot the line does not tag, nor one archived", () => {
    expect(resolveMentions("@Scout look", room, [analyst.id])).toEqual({ bots: [scout], ambiguous: [] });
    expect(resolveMentions("no tags here", room, [analyst.id])).toEqual({ bots: [], ambiguous: [] });
    expect(resolveMentions("@Quill look", [analyst, { ...chief, hidden: true }])).toEqual({ bots: [analyst], ambiguous: [] });
  });

  it("lets a longer name win over a shared shorter one", () => {
    const junior = { id: "quill-jr", name: "Quill Jr" };
    expect(resolveMentions("@Quill Jr please", [...room, junior])).toEqual({ bots: [junior], ambiguous: [] });
  });

  it("keeps the shared mention boundaries", () => {
    expect(resolveMentions("mail quill@Quill.dev or /@Quill", room)).toEqual({ bots: [], ambiguous: [] });
    expect(resolveMentions("@Quillo is someone else", room)).toEqual({ bots: [], ambiguous: [] });
    expect(resolveMentions("İ **@Scout**", room).bots).toEqual([scout]);
  });

  it("reads @everyone as no bot's name", () => {
    expect(resolveMentions("@everyone hello", room)).toEqual({ bots: [], ambiguous: [] });
  });
});

describe("parseMentionPicks", () => {
  it("takes a short list of ids and drops repeats", () => {
    expect(parseMentionPicks(undefined)).toBeUndefined();
    expect(parseMentionPicks(null)).toBeUndefined();
    expect(parseMentionPicks([])).toEqual([]);
    expect(parseMentionPicks(["a-1", "b_2", "a-1"])).toEqual(["a-1", "b_2"]);
  });

  it("refuses anything else", () => {
    expect(parseMentionPicks("a-1")).toBeNull();
    expect(parseMentionPicks([1])).toBeNull();
    expect(parseMentionPicks(["has space"])).toBeNull();
    expect(parseMentionPicks(["x".repeat(129)])).toBeNull();
    expect(parseMentionPicks(Array.from({ length: MENTION_PICKS_MAX + 1 }, (_, i) => `bot-${i}`))).toBeNull();
    expect(parseMentionPicks(Array.from({ length: MENTION_PICKS_MAX }, (_, i) => `bot-${i}`))).toHaveLength(MENTION_PICKS_MAX);
  });
});
