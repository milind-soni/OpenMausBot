import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { escalationDeliverable } from "./escalations.ts";
import { chiefForBot } from "./incidents.ts";
import { canManage, canReach, hasAuthority, reachablePeers } from "./peer-roster.ts";

const ADA = "ada@acme.test", BOB = "bob@acme.test";
// Acme: Fox and Owl work on Product A for Bob; Tech Lead works on Product A too but reports to Ada.
const team = [
  { id: "ada-chief", name: "Ada's Chief", chiefOfStaff: true, createdBy: ADA },
  { id: "bob-chief", name: "Bob's Chief", chiefOfStaff: true, createdBy: ADA, reportsTo: BOB },
  { id: "fox", name: "Fox", section: "Product A", createdBy: ADA, reportsTo: BOB },
  { id: "owl", name: "Owl", section: "Product A", createdBy: BOB },
  { id: "lead", name: "Tech Lead", section: "Product A", createdBy: BOB, reportsTo: ADA },
  { id: "seo", name: "SEO", section: "SEO/SEA", createdBy: ADA },
];
const bot = (id: string) => team.find((one) => one.id === id)!;
const ids = (bots: ReadonlyArray<{ id: string }>) => bots.map((one) => one.id).sort();
const everyoneBut = (id: string) => ids(team.filter((one) => one.id !== id));

describe("one Chief per person on a Team Cloud", () => {
  it("reaches every bot, but has authority over exactly the bots its person owns, in every department", () => {
    expect(ids(reachablePeers(team, bot("ada-chief")))).toEqual(everyoneBut("ada-chief"));
    expect(ids(team.filter((one) => one.id !== "ada-chief" && hasAuthority(bot("ada-chief"), one)))).toEqual(["lead", "seo"]);
    expect(ids(team.filter((one) => one.id !== "bob-chief" && hasAuthority(bot("bob-chief"), one)))).toEqual(["fox", "owl"]);
  });

  it("is reached by any bot, while only its own person's bots answer to it", () => {
    expect(canReach(bot("lead"), bot("ada-chief"))).toBe(true);
    expect(canReach(bot("lead"), bot("bob-chief"))).toBe(true);
    expect(canReach(bot("seo"), bot("fox"))).toBe(true);
    expect(ids(reachablePeers(team, bot("fox")))).toEqual(everyoneBut("fox"));
    expect(hasAuthority(bot("lead"), bot("bob-chief"))).toBe(false);
    expect(hasAuthority(bot("seo"), bot("fox"))).toBe(false);
    expect(canManage(bot("ada-chief"), bot("fox"))).toBe(false);
    expect(canManage(bot("bob-chief"), bot("fox"))).toBe(true);
  });

  it("gets its own person's incidents and escalations, never another person's", () => {
    expect(chiefForBot(team, bot("fox"))?.id).toBe("bob-chief");
    expect(chiefForBot(team, bot("lead"))?.id).toBe("ada-chief");
    expect(escalationDeliverable(bot("ada-chief"), bot("fox"))).toBe(false);
    expect(escalationDeliverable(bot("ada-chief"), bot("lead"))).toBe(true);
    // A person with no Chief: their bot's notices go to them, not to someone else's Chief.
    expect(chiefForBot(team, { id: "x", name: "X", section: "Product A", createdBy: "cleo@acme.test" })).toBeNull();
  });

  it("is told whose Chief it is, lists that person's bots as its team and everyone else as reachable", () => {
    const prompt = chiefOfStaffSystemPrompt("bob-chief", team, true);
    expect(prompt).toContain("You are Bob's assistant and Chief of Staff");
    const [, mine = "", others = ""] = prompt.split(/Bots that report to Bob \(your team\):|Other bots you can reach \(they report to someone else\):/);
    expect(mine).toContain("Fox");
    expect(mine).toContain("Owl");
    expect(mine).not.toContain("Tech Lead");
    expect(others).toContain("Tech Lead");
    expect(others).toContain("Ada's Chief");
    expect(others).not.toMatch(/\bFox\b/);
  });

  it("leaves a team nobody owns bots in, and every other server, on departments for authority only", () => {
    const plain = team.map(({ createdBy: _createdBy, reportsTo: _reportsTo, ...rest }) => rest);
    expect(canReach(plain[0]!, plain[2]!)).toBe(true);
    expect(hasAuthority(plain[0]!, plain[2]!)).toBe(false);
    expect(ids(reachablePeers(plain, plain.find((one) => one.id === "fox")!))).toEqual(ids(plain.filter((one) => one.id !== "fox")));
    expect(chiefOfStaffSystemPrompt("ada-chief", plain, true)).toContain("Chief of Staff for the General department");
  });
});
