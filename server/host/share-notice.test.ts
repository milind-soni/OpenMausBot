import { describe, expect, it } from "vitest";

import type { BotAccess } from "../../shared/bot-access.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import type { Delivery } from "./person-inbox.ts";
import { createShareNotice, newlyShared } from "./share-notice.ts";

const ADA = "ada@acme.test", RUI = "rui@acme.test", MARTA = "marta@acme.test", OLIVE = "olive@acme.test";
const PEOPLE = [{ email: OLIVE, role: "owner" as const }, { email: ADA, role: "admin" as const }, { email: RUI, role: "member" as const }, { email: MARTA, role: "member" as const }];
const only = (people: BotAccess["people"] = {}): BotAccess => ({ everyone: "none", people });
const all = (people: BotAccess["people"] = {}): BotAccess => ({ everyone: "chat", people });

describe("who is told a bot was shared with them", () => {
  it("the Users named one by one who could not use it before", () => {
    expect(newlyShared(only(), only({ [MARTA]: "chat" }), PEOPLE)).toEqual([MARTA]);
    expect(newlyShared(only({ [MARTA]: "chat" }), only({ [MARTA]: "chat", [RUI]: "view" }), PEOPLE)).toEqual([RUI]);
    expect(newlyShared(only({ [MARTA]: "view" }), only({ [MARTA]: "edit" }), PEOPLE), "a level raised is no news").toEqual([]);
  });

  it("nobody when it is shared with everyone, already was, or the person is an admin or not on the team", () => {
    expect(newlyShared(only(), all(), PEOPLE)).toEqual([]);
    expect(newlyShared(all(), all({ [MARTA]: "edit" }), PEOPLE)).toEqual([]);
    expect(newlyShared(only(), only({ [ADA]: "chat", [OLIVE]: "edit" }), PEOPLE)).toEqual([]);
    expect(newlyShared(only(), only({ "gone@acme.test": "chat", "@acme.test": "chat" }), PEOPLE)).toEqual([]);
    expect(newlyShared(only({ "@acme.test": "chat" }), only({ "@acme.test": "chat", [MARTA]: "chat" }), PEOPLE), "an older list's domain already covered them").toEqual([]);
  });

  it("puts one line in each new person's inbox, from the sharer, linked to the bot's main chat", () => {
    const delivered: Array<[string, Delivery]> = [];
    const notice = createShareNotice({
      people: () => PEOPLE, profileName: (email) => (email === ADA ? "Ada" : undefined),
      store: () => ({ tasks: () => [{ threadId: "run", routineRunId: "r1", createdAt: 1 }, { threadId: "later", createdAt: 9 }, { threadId: "main", createdAt: 2 }] }) as never,
      inbox: () => ({ deliver: (person, delivery) => { delivered.push([person, delivery]); return null; } }),
    });
    const bot = { id: "quotes", name: "Quotes" } as BotRecord;
    notice({ kind: "session", session: { email: "Ada@Acme.test" } } as unknown as RequestAuth, bot, only(), only({ [MARTA]: "chat", [RUI]: "chat" }));
    expect(delivered.map(([person]) => person).sort()).toEqual([personKey({ id: "", email: MARTA }), personKey({ id: "", email: RUI })].sort());
    expect(delivered[0]![1]).toEqual({ kind: "notice", from: { name: "Ada", email: ADA }, origin: { botId: "quotes", threadId: "main" },
      text: "Ada shared Quotes with you.", title: "Quotes is shared with you", notify: "done" });

    delivered.length = 0;
    notice({ kind: "loopback" } as unknown as RequestAuth, bot, only(), only({ [MARTA]: "chat" }));
    expect(delivered[0]![1]).toMatchObject({ from: { name: "An admin" }, text: "An admin shared Quotes with you." });
  });
});
