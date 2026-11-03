import { describe, expect, it } from "vitest";

import type { BotAccessLevel } from "../../shared/bot-access.ts";
import { createPersonalReach } from "./personal-reach.ts";

const MIRA = "mira@acme.test", BEN = "ben@acme.test";
const key = (email: string) => `key:${email}`;
const mausbot = { id: "maus", name: "MausBot", defaultBot: { person: MIRA }, visibility: { people: [MIRA] } };
const sales = { id: "sales", name: "Sales", visibility: "everyone" };
const levels: Record<string, BotAccessLevel> = { sales: "chat", archive: "view", payroll: "none", editable: "edit" };

function world(over: { behind?: boolean; audiences?: Record<string, string | null> } = {}) {
  const audiences: Record<string, string | null> = { mine: key(MIRA), hers: key(MIRA), benChat: key(BEN), teamChat: null, ...over.audiences };
  return createPersonalReach({
    privateTo: (threadId) => audiences[threadId] ?? null,
    personKey: key,
    personBehind: () => over.behind ?? true,
    level: (bot, email) => (email === MIRA ? levels[bot.id] ?? "none" : "none"),
  });
}

describe("a person's MausBot reaching shared bots", () => {
  it("reaches a bot its person may chat with, from a chat private to that person", () => {
    expect(world().mayHandOn(mausbot, sales, "mine")).toBe(true);
    expect(world().mayHandOn(mausbot, { id: "editable", name: "Editable" }, "mine")).toBe(true);
  });

  it("says where to go instead in a chat it can't hand work on from, and nothing to anyone else", () => {
    expect(world().notHere(mausbot, "teamChat")).toContain("start a new conversation with you");
    expect(world().notHere(mausbot, "benChat")).toContain("start a new conversation with you");
    expect(world().notHere(mausbot, "mine")).toBe("");
    expect(world().notHere(sales, "teamChat")).toBe("");
  });

  it("audience: never from a chat others read, or a chat private to someone else", () => {
    expect(world().mayHandOn(mausbot, sales, "teamChat")).toBe(false);
    expect(world().mayHandOn(mausbot, sales, "benChat")).toBe(false);
    expect(world().mayHandOn(mausbot, sales, "unknown")).toBe(false);
  });

  it("only a person's own MausBot: not a shared bot, and not a MausBot with no person", () => {
    expect(world().mayHandOn(sales, { id: "payroll", name: "Payroll" }, "mine")).toBe(false);
    expect(world().mayHandOn({ ...mausbot, defaultBot: {} }, sales, "mine")).toBe(false);
    expect(world().mayHandOn({ ...mausbot, defaultBot: { person: BEN } }, sales, "mine")).toBe(false);
  });

  it("sharing level: below chat is no reach", () => {
    expect(world().mayHandOn(mausbot, { id: "archive", name: "Archive" }, "mine")).toBe(false);
    expect(world().mayHandOn(mausbot, { id: "payroll", name: "Payroll" }, "mine")).toBe(false);
  });

  it("never another person's MausBot, itself or an archived bot, whatever the level says", () => {
    expect(world().mayHandOn(mausbot, { id: "editable", name: "MausBot", defaultBot: { person: BEN } }, "mine")).toBe(false);
    expect(world().mayHandOn(mausbot, { ...mausbot, id: "maus" }, "mine")).toBe(false);
    expect(world().mayHandOn(mausbot, { ...sales, hidden: true }, "mine")).toBe(false);
  });

  it("outside-driven: a turn with no person behind it cannot hand on", () => {
    expect(world({ behind: false }).mayHandOn(mausbot, sales, "mine")).toBe(false);
    expect(world({ behind: false }).peers([mausbot, sales], mausbot, "mine")).toEqual([]);
    expect(world({ behind: false }).handOff(mausbot, sales, "mine", { botId: "sales", threadId: "teamChat" })).toBe(false);
  });

  it("private hand-off: running work must be in a thread private to the same person, and traced to their request", () => {
    const reach = world();
    const started = { id: "as_1", botId: "sales", threadId: "hers", origin: { kind: "user" as const, request: "Pull the numbers" } };
    expect(reach.handOff(mausbot, sales, "mine", started)).toBe(true);
    expect(reach.handOff(mausbot, sales, "mine", { ...started, threadId: "teamChat" }), "the team's chat").toBe(false);
    expect(reach.handOff(mausbot, sales, "mine", { ...started, threadId: "benChat" }), "another member's chat").toBe(false);
    expect(reach.handOff(mausbot, sales, "mine", { ...started, origin: { kind: "outside" } }), "outside work").toBe(false);
    expect(reach.handOff(mausbot, sales, "mine", { ...started, origin: undefined }), "work nothing traces").toBe(false);
  });

  it("the check before a thread exists still needs a person behind the turn, not a private thread yet", () => {
    expect(world().handOff(mausbot, sales, "mine", { botId: "sales", threadId: "teamChat" })).toBe(true);
    expect(world().handOff(mausbot, { id: "archive", name: "Archive" }, "mine", { botId: "archive", threadId: "teamChat" })).toBe(false);
  });

  it("running work stops counting once its person's level on the bot drops, and survives a later outside line in their chat", () => {
    const started = { id: "as_1", botId: "sales", threadId: "hers", origin: { kind: "user" as const, request: "Pull the numbers" } };
    expect(world({ behind: false }).handOff(mausbot, sales, "mine", started), "a relayed line later must not withhold the result").toBe(true);
    expect(world().handOff(mausbot, { id: "archive", name: "Archive" }, "mine", { ...started, botId: "archive" })).toBe(false);
  });

  it("answering: only a question waiting in a thread private to the same person", () => {
    expect(world().mayAnswerIn(mausbot, "mine", "hers")).toBe(true);
    expect(world().mayAnswerIn(mausbot, "mine", "benChat")).toBe(false);
    expect(world().mayAnswerIn(mausbot, "mine", "teamChat")).toBe(false);
    expect(world().mayAnswerIn(mausbot, "mine", undefined)).toBe(false);
  });

  it("lists what it may reach, for the roster and list_bots", () => {
    const bots = [mausbot, sales, { id: "archive", name: "Archive" }, { id: "payroll", name: "Payroll" }, { id: "other", name: "MausBot", defaultBot: { person: BEN } }];
    expect(world().peers(bots, mausbot, "mine").map((bot) => bot.id)).toEqual(["sales"]);
    expect(world().peers(bots, mausbot, "teamChat")).toEqual([]);
  });
});
