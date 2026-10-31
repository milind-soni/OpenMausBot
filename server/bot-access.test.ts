import { describe, expect, it } from "vitest";

import { accessFromVisibility, atLeast, sharedLevel, visibilityFromAccess } from "../shared/bot-access.ts";
import { accessOf, memberBot, memberLevel, parseBotAccess, VisibleSet } from "./bot-visibility.ts";
import { levelNeeded, relayedSendRefusal, setupCardRefusal } from "./host/bot-access-gate.ts";
import { memberBotPatchViolation } from "./request-auth.ts";
import { settledAccess } from "./routes/bot-access.ts";
import type { BotRecord } from "./store.ts";
import type { BotVisibility } from "../shared/wire.ts";

const BOB = "bob@acme.test", CARA = "cara@acme.test", DAN = "dan@acme.test";

describe("moving visibility to levels", () => {
  it("gives what each older setting gave: everyone chats, listed people chat, admins only stays admins only", () => {
    expect(accessFromVisibility(undefined)).toEqual({ everyone: "chat", people: {} });
    expect(accessFromVisibility("everyone")).toEqual({ everyone: "chat", people: {} });
    expect(accessFromVisibility("admins")).toEqual({ everyone: "none", people: {} });
    expect(accessFromVisibility({ people: [BOB, "@acme.test"] })).toEqual({ everyone: "none", people: { [BOB]: "chat", "@acme.test": "chat" } });
  });

  it("keeps everyone a member could see able to see it, and nobody else", () => {
    for (const visibility of ["everyone", "admins", { people: [BOB] }] satisfies BotVisibility[]) {
      expect(visibilityFromAccess(accessFromVisibility(visibility), null)).toEqual(visibility);
    }
    expect(visibilityFromAccess({ everyone: "view", people: {} }, null)).toBe("everyone");
    expect(visibilityFromAccess({ everyone: "none", people: {} }, DAN)).toEqual({ people: [DAN] });
  });
});

describe("a member's level", () => {
  const bot = { visibility: { people: [BOB, CARA, DAN] }, access: { everyone: "none", people: { [BOB]: "view", [CARA]: "chat", [DAN]: "edit" } } };

  it("is the higher of everyone's and theirs, never below viewing a bot they see, and none for one they don't", () => {
    expect(memberLevel(bot, BOB)).toBe("view");
    expect(memberLevel(bot, CARA)).toBe("chat");
    expect(memberLevel(bot, DAN)).toBe("edit");
    expect(memberLevel(bot, "eve@acme.test")).toBe("none");
    expect(memberLevel({ ...bot, visibility: "everyone", access: { everyone: "chat", people: { [BOB]: "view" } } }, BOB)).toBe("chat");
    expect(sharedLevel({ everyone: "none", people: { "@acme.test": "view" } }, "zed@acme.test")).toBe("view");
  });

  it("is edit for the bot's owner, and chat for anyone a bot without sharing shows itself to", () => {
    expect(memberLevel({ visibility: { people: [BOB] }, access: { everyone: "none", people: {} }, reportsTo: BOB }, BOB)).toBe("edit");
    expect(memberLevel({ visibility: { people: [BOB] }, defaultBot: { person: BOB } }, BOB)).toBe("edit");
    expect(memberLevel({ visibility: "everyone" }, CARA)).toBe("chat");
    expect(memberLevel({ visibility: { people: [BOB] } }, BOB)).toBe("chat");
  });

  it("fails closed to viewing when the stored sharing is damaged", () => {
    expect(accessOf({ access: { everyone: "root" } })).toEqual({ everyone: "none", people: {} });
    expect(memberLevel({ visibility: "everyone", access: "edit" }, BOB)).toBe("view");
  });

  it("reaches each copy of the bot: an editor gets its sharing, nobody else does", () => {
    const bots = [{ id: "pay", threadId: "t-pay", ...bot }];
    const audiences = { of: () => undefined, person: null };
    const as = (email: string) => memberBot({ id: "pay", threadId: "t-pay", ...bot }, new VisibleSet(bots, [], { kind: "member", email }, undefined, audiences));
    expect(as(BOB)).toMatchObject({ yourAccess: "view" });
    expect((as(BOB) as { access?: unknown }).access).toBeUndefined();
    expect((as(DAN) as { access?: unknown }).access).toEqual(bot.access);
    const admin = memberBot({ id: "pay", threadId: "t-pay", ...bot }, new VisibleSet(bots, [], { kind: "all", email: "ada@acme.test" }, undefined, audiences));
    expect(admin).toMatchObject({ yourAccess: "edit", access: bot.access });
    // Off a team a member keeps chatting with every bot they see, and no copy carries a level.
    const offTeam = new VisibleSet([{ id: "pay", threadId: "t-pay", visibility: "everyone" }], [], { kind: "member", email: BOB });
    expect(offTeam.level("pay")).toBe("chat");
    expect((memberBot({ id: "pay", threadId: "t-pay" }, offTeam) as { yourAccess?: unknown }).yourAccess).toBeUndefined();
  });
});

describe("what a request needs", () => {
  it("reads at view, writes at chat, sharing at edit, and leaves a bot's own PATCH and routines to their routes", () => {
    expect(levelNeeded("GET", "/api/threads/t1/messages")).toBe("view");
    expect(levelNeeded("POST", "/api/bots/b1/read")).toBe("view");
    expect(levelNeeded("POST", "/api/groups/g1/read")).toBe("view");
    expect(levelNeeded("POST", "/api/bots/b1/tasks/t1")).toBe("view");
    expect(levelNeeded("POST", "/api/bots/b1/tasks/delete")).toBe("chat");
    expect(levelNeeded("POST", "/api/bots/b1/tasks")).toBe("chat");
    expect(levelNeeded("PATCH", "/api/bots/b1/tasks/t1")).toBe("chat");
    expect(levelNeeded("POST", "/api/bots/b1/messages")).toBe("chat");
    expect(levelNeeded("POST", "/api/threads/t1/respond")).toBe("chat");
    expect(levelNeeded("PATCH", "/api/bots/b1/profile")).toBe("chat");
    expect(levelNeeded("PUT", "/api/bots/b1/access")).toBe("edit");
    expect(levelNeeded("PATCH", "/api/bots/b1")).toBeNull();
    expect(levelNeeded("DELETE", "/api/routines/r1")).toBeNull();
  });

  it("lets each level change only its own fields of a bot", () => {
    expect(memberBotPatchViolation({ unread: false }, "view")).toBeNull();
    expect(memberBotPatchViolation({ color: "teal" }, "view")).toBe("color");
    expect(memberBotPatchViolation({ color: "teal" }, "chat")).toBeNull();
    // A Team Cloud member who may only chat changes no other bot's look; one who may edit it can.
    expect(memberBotPatchViolation({ color: "teal" }, "chat", false, true)).toBe("color");
    expect(memberBotPatchViolation({ color: "teal", name: "Mine" }, "chat", true, true)).toBeNull();
    expect(memberBotPatchViolation({ color: "teal" }, "edit", false, true)).toBeNull();
    expect(memberBotPatchViolation({ soul: "x" }, "chat")).toBe("soul");
    expect(memberBotPatchViolation({ soul: "x", modelSelection: {}, threadId: "t", composio: true, connectorTools: {}, mcpServers: [] }, "edit")).toBeNull();
    for (const field of ["approvalMode", "autoApprove", "alwaysAllow", "cwd", "computer", "section", "chiefOfStaff", "peers", "visibility", "access", "reportsTo", "browserProfile"]) {
      expect(memberBotPatchViolation({ [field]: null }, "edit"), field).toBe(field);
    }
  });

  it("asks someone who can edit the bot to approve a change to it, and anyone who may answer for anything else", () => {
    const bot = { id: "pay", name: "Payroll" };
    const level = (who: string) => () => who as "view" | "chat" | "edit";
    expect(setupCardRefusal({ profileRequest: {} }, bot, level("chat"))).toMatch(/edit Payroll/);
    expect(setupCardRefusal({ modelRequest: {} }, bot, level("chat"))).toMatch(/edit/);
    expect(setupCardRefusal({ profileRequest: {} }, bot, level("edit"))).toBeNull();
    expect(setupCardRefusal({}, bot, level("chat"))).toBeNull();
  });

  it("relays another app's message only for someone who can chat with the bot", () => {
    const bot = { name: "Payroll", visibility: { people: [BOB, CARA] }, access: { everyone: "none", people: { [BOB]: "view", [CARA]: "chat" } } };
    expect(relayedSendRefusal(bot, BOB, false)).toMatch(/can't chat/);
    expect(relayedSendRefusal(bot, undefined, false)).toMatch(/can't chat/);
    expect(relayedSendRefusal(bot, CARA, false)).toBeNull();
    expect(relayedSendRefusal(bot, "ada@acme.test", true)).toBeNull();
    expect(relayedSendRefusal({ name: "Open", visibility: "everyone" }, undefined, false)).toBeNull();
  });
});

describe("setting a bot's sharing", () => {
  const bot = { id: "pay", name: "Payroll", reportsTo: DAN, access: { everyone: "none", people: { "@old.test": "chat" } } } as unknown as BotRecord;
  const member = (email: string) => [BOB, CARA].includes(email);

  it("adds only the team's people, keeps an entry the bot already had, and never lists the owner", () => {
    expect(settledAccess(bot, { everyone: "view", people: { [BOB]: "edit", "@old.test": "view", [DAN]: "view" } }, member))
      .toEqual({ ok: true, access: { everyone: "view", people: { [BOB]: "edit", "@old.test": "view" } } });
    expect(settledAccess(bot, { everyone: "none", people: { "stranger@else.test": "chat" } }, member)).toMatchObject({ ok: false });
  });

  it("takes only well-formed levels and addresses", () => {
    expect(parseBotAccess({ everyone: "chat", people: { " Bob@Acme.test ": "edit" } })).toEqual({ ok: true, access: { everyone: "chat", people: { [BOB]: "edit" } } });
    expect(parseBotAccess({ everyone: "admin", people: {} }).ok).toBe(false);
    expect(parseBotAccess({ everyone: "chat", people: { [BOB]: "none" } }).ok).toBe(false);
    expect(parseBotAccess({ everyone: "chat", people: { "not an address": "view" } }).ok).toBe(false);
    expect(parseBotAccess({ everyone: "chat", people: {}, extra: 1 }).ok).toBe(false);
    expect(atLeast("edit", "chat")).toBe(true);
    expect(atLeast("view", "chat")).toBe(false);
  });
});
