import { describe, expect, it } from "vitest";

import { schedulableBots } from "./team-people";

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
