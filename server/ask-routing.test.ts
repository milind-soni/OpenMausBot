import { describe, expect, it } from "vitest";

import { createAskRouting } from "./ask-routing.ts";
import { memberAudience, roomAudience, type Audience } from "./audience.ts";

const key = (email: string) => `p_${email.replace(/\W/g, "").padEnd(22, "x").slice(0, 22)}`;
const ADA = key("ada"), BOB = key("bob"), OLIVE = key("olive");
const bots: Record<string, { createdBy?: string; reportsTo?: string; defaultBot?: { person?: string } }> = {
  fox: { createdBy: "ada", reportsTo: "bob" },
  "bobs-mausbot": { reportsTo: "ada", defaultBot: { person: "bob" } },
  lead: { createdBy: "olive", reportsTo: "ada" },
  stray: {},
};
const audiences: Record<string, Audience> = {
  "fox-main": "team", "fox-olive": memberAudience(OLIVE), "lead-main": "team", "stray-main": "team", "room-1": roomAudience("r1"),
};

function routing(team = true, gone: string[] = []) {
  return createAskRouting({ team, audienceOf: (threadId) => audiences[threadId] ?? "team", bot: (id) => bots[id], personKeyOf: key, gone: (email) => gone.includes(email) });
}
const ada = { person: ADA, admin: true }, bob = { person: BOB, admin: false }, olive = { person: OLIVE, admin: true };

describe("whose a bot's ask is on a Team Cloud", () => {
  it("in a shared chat: the person it reports to, its creator when it names nobody, the Admins when nobody owns it", () => {
    const route = routing();
    expect(route.askedPerson("fox", "fox-main")).toBe(BOB);
    expect(route.askedPerson("lead", "lead-main")).toBe(ADA);
    expect([ada, bob, olive].map((viewer) => route.asks(viewer, "fox", "fox-main"))).toEqual([false, true, false]);
    expect(route.askedPerson("stray", "stray-main")).toBeNull();
    expect([ada, bob, olive].map((viewer) => route.asks(viewer, "stray", "stray-main"))).toEqual([true, false, true]);
    expect(route.askedPerson("fox", "room-1")).toBe(BOB);
    // A member's own MausBot is theirs, whatever else it says.
    expect(route.askedPerson("bobs-mausbot", "bobs-mausbot-main")).toBe(BOB);
  });

  it("goes to the Admins when the person a bot reports to has left the team", () => {
    const route = routing(true, ["bob"]);
    expect(route.askedPerson("fox", "fox-main")).toBeNull();
    expect([ada, bob, olive].map((viewer) => route.asks(viewer, "fox", "fox-main"))).toEqual([true, false, true]);
    expect(route.askedPerson("lead", "lead-main")).toBe(ADA);
  });

  it("in a private chat: that member's alone, never the owner's or an Admin's", () => {
    const route = routing();
    expect(route.askedPerson("fox", "fox-olive")).toBe(OLIVE);
    expect([ada, bob, olive].map((viewer) => route.asks(viewer, "fox", "fox-olive"))).toEqual([false, false, true]);
  });

  it("notifies only the asked person of an ask, and everyone who sees it of anything else", () => {
    const route = routing();
    const question = { kind: "question", botId: "fox", threadId: "fox-main" };
    expect([ada, bob, olive].map((viewer) => route.notificationReaches(viewer, question))).toEqual([false, true, false]);
    for (const kind of ["approval", "sign-in", "routine-failed", "turn-failed", "incident"]) {
      expect(route.notificationReaches(ada, { ...question, kind }), kind).toBe(false);
    }
    expect(route.notificationReaches(ada, { ...question, kind: "done" })).toBe(true);
    expect(route.notificationReaches(ada, { ...question, kind: "mention" })).toBe(true);
  });

  it("notifies only its person of a teammate tag or a passed message, an Admin no more than anyone", () => {
    const route = routing();
    const tagged = { kind: "mention", botId: "fox", threadId: "fox-main", forPerson: BOB };
    expect([ada, bob, olive].map((viewer) => route.notificationReaches(viewer, tagged))).toEqual([false, true, false]);
    expect(route.notificationReaches({ person: null, admin: true }, tagged)).toBe(false);
  });

  it("routes nothing off a team: every ask is everyone's who sees it", () => {
    const route = routing(false);
    expect([ada, bob, olive].map((viewer) => route.asks(viewer, "fox", "fox-main"))).toEqual([true, true, true]);
    expect(route.notificationReaches(ada, { kind: "question", botId: "fox", threadId: "fox-olive" })).toBe(true);
  });
});
