import { describe, expect, it } from "vitest";

import type { BotRecord } from "../store.ts";
import { createMemberOwnBot, type MemberOwnBotDeps } from "./member-own-bot.ts";

function world(deleted: { status: number; body: { error?: string } }) {
  const bot = { id: "bens", defaultBot: { person: "ben@acme.test" }, chiefOfStaff: true, sidebarHidden: true } as unknown as BotRecord;
  let duringDelete: Partial<BotRecord> | null = null;
  const deps = {
    store: () => ({ bot: () => bot, patchBot: (_id: string, patch: Partial<BotRecord>) => Object.assign(bot, patch) }),
    deleteBot: async () => { duringDelete = { ...bot }; return deleted; },
  } as unknown as MemberOwnBotDeps;
  return { bot, own: createMemberOwnBot(deps), duringDelete: () => duringDelete };
}

describe("a member's own MausBot when they leave", () => {
  it("gives up its mark and its crown before it is deleted, so it is never left a department's Chief", async () => {
    const w = world({ status: 200, body: {} });
    expect(await w.own.remove("bens")).toBe(true);
    expect(w.duringDelete()).toMatchObject({ defaultBot: undefined, chiefOfStaff: undefined });
  });

  it("is theirs again, crown included, if it could not be deleted", async () => {
    const w = world({ status: 409, body: { error: "busy" } });
    expect(await w.own.remove("bens")).toBe(false);
    expect(w.bot).toMatchObject({ defaultBot: { person: "ben@acme.test" }, chiefOfStaff: true, sidebarHidden: true });
  });
});
