import { describe, expect, it } from "vitest";

import { mayRename, schedulableBots } from "./team-people";

const OLIVE = { email: "olive@acme.test", name: "Olive", role: "owner", you: true as const };
const bots = [
  { id: "scout", yourAccess: "edit" },
  { id: "payroll", yourAccess: "view" },
  { id: "olives-mausbot", defaultBot: { person: "Olive@acme.test" }, yourAccess: "edit" },
  { id: "bobs-mausbot", defaultBot: { person: "bob@acme.test" }, yourAccess: "edit" },
  { id: "archived", hidden: true, yourAccess: "edit" },
];

describe("schedulableBots", () => {
  it("on a team lists only the bots the person can chat with, their own MausBot and no teammate's", () => {
    expect(schedulableBots(bots, { me: OLIVE }).map((bot) => bot.id)).toEqual(["scout", "olives-mausbot"]);
  });

  it("keeps the bot a routine being changed already has", () => {
    expect(schedulableBots(bots, { me: OLIVE }, "payroll").map((bot) => bot.id)).toEqual(["scout", "payroll", "olives-mausbot"]);
  });

  it("off a team lists every bot shown", () => {
    expect(schedulableBots(bots, null).map((bot) => bot.id)).toEqual(["scout", "payroll", "olives-mausbot", "bobs-mausbot"]);
  });
});

describe("mayRename", () => {
  const member = { admin: false, me: OLIVE };
  it("off a team, anyone renames any bot", () => {
    expect(mayRename({ yourAccess: undefined }, null)).toBe(true);
  });

  it("on a team: an admin any bot, a member only one they can edit or their own MausBot", () => {
    expect(mayRename({ yourAccess: "chat" }, { admin: true, me: OLIVE })).toBe(true);
    expect(mayRename({ yourAccess: "chat" }, member)).toBe(false);
    expect(mayRename({ yourAccess: "view" }, member)).toBe(false);
    expect(mayRename({ yourAccess: "edit" }, member)).toBe(true);
    expect(mayRename({ yourAccess: "chat", defaultBot: { person: "Olive@acme.test" } }, member)).toBe(true);
    expect(mayRename({ yourAccess: "chat", defaultBot: { person: "bob@acme.test" } }, member)).toBe(false);
  });
});
