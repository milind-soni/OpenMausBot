import { describe, expect, it } from "vitest";

import type { BotAccess } from "../shared/bot-access.ts";
import { forgetMember } from "./bot-owners.ts";
import type { BotRecord } from "./store.ts";

const BOB = "bob@acme.test";

function storeOf(bots: Array<Partial<BotRecord> & { id: string }>) {
  const list = bots as BotRecord[];
  return {
    get bots() { return list; },
    bot: (id: string) => list.find((bot) => bot.id === id) ?? null,
    patchBot: (id: string, patch: Partial<BotRecord>) => { const bot = list.find((one) => one.id === id)!; Object.assign(bot, patch); return bot; },
  };
}

describe("forgetMember", () => {
  it("takes a member who left off every bot's sharing and Looked after by, and their bots fall to the Admins", () => {
    const store = storeOf([
      { id: "ledger", reportsTo: BOB, createdBy: "olive@acme.test", access: { everyone: "none", people: { [BOB]: "chat", "ben@acme.test": "chat" } }, visibility: { people: [BOB, "ben@acme.test"] } },
      { id: "made", createdBy: BOB },
      { id: "listed", visibility: { people: [BOB, "@acme.test"] } },
      { id: "scout", createdBy: "olive@acme.test", reportsTo: "ada@acme.test" },
      { id: "mausbot", defaultBot: { person: BOB }, reportsTo: BOB },
    ]);
    const shared: Array<[string, BotAccess]> = [];
    const handedBack = forgetMember(store, "Bob@Acme.test", (bot, access) => { shared.push([bot.id, access]); store.patchBot(bot.id, { access }); });
    expect(handedBack.map((bot) => bot.id)).toEqual(["ledger", "made"]);
    expect(store.bot("ledger")).toMatchObject({ reportsTo: undefined, createdBy: undefined });
    expect(store.bot("made")?.createdBy).toBeUndefined();
    expect(store.bot("scout")).toMatchObject({ reportsTo: "ada@acme.test", createdBy: "olive@acme.test" });
    expect(store.bot("mausbot")?.reportsTo).toBe(BOB);
    expect(shared).toEqual([
      ["ledger", { everyone: "none", people: { "ben@acme.test": "chat" } }],
      ["listed", { everyone: "none", people: { "@acme.test": "chat" } }],
    ]);
  });

  it("uncrowns a Chief that would be a second one in its department once nobody owns it", () => {
    const store = storeOf([
      { id: "dept-chief", section: "Sales", chiefOfStaff: true },
      { id: "bobs-chief", section: "Sales", chiefOfStaff: true, reportsTo: BOB },
    ]);
    forgetMember(store, BOB, () => {});
    expect(store.bot("bobs-chief")).toMatchObject({ chiefOfStaff: false, reportsTo: undefined });
    expect(store.bot("dept-chief")?.chiefOfStaff).toBe(true);
  });
});
