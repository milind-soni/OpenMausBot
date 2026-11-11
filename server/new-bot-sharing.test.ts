import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import type { TeamSetupRequest } from "../shared/team-setup.ts";
import { accessOf, memberLevel } from "./bot-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { createDefaultBot } from "./default-bot.ts";
import { privateUntilShared, sharedAsMaker, sharedUnlessRestricted, teamCreator } from "./new-bot-sharing.ts";
import type { RequestAuth } from "./request-auth.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const ADA = "ada@acme.test", RUI = "rui@acme.test", MARTA = "marta@acme.test";
const PRIVATE = { everyone: "none", people: {} };

const teamStore = () => Object.assign(new Store(selection), { newBotSharing: privateUntilShared });
const setup = (chief: BotRecord, botId: string): TeamSetupRequest => ({ version: 1, requestId: `setup-${botId}`, botId: chief.id, threadId: chief.threadId,
  reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
    { action: "create", botId, threadId: `${botId}-thread`, fields: { name: botId, section: chief.section, modelSelection: selection() } },
  ] });

describe("how a new bot is shared", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("the two rules: everyone unless restricted anywhere, the owner's until shared on a team", () => {
    expect(sharedUnlessRestricted(undefined, ADA)).toEqual({});
    expect(sharedUnlessRestricted("everyone", ADA)).toEqual({});
    expect(sharedUnlessRestricted("admins", null)).toEqual({ visibility: "admins" });
    expect(privateUntilShared(undefined, ADA)).toEqual({ access: PRIVATE, visibility: { people: [ADA] } });
    expect(privateUntilShared(undefined, null)).toEqual({ access: PRIVATE, visibility: "admins" });
    expect(privateUntilShared("everyone", ADA), "as a shared bot always was: no sharing of its own, read as everyone").toEqual({});
    expect(privateUntilShared({ people: [MARTA] }, ADA)).toEqual({ visibility: { people: [MARTA] } });
    expect(privateUntilShared("admins", ADA)).toEqual({ visibility: "admins" });
  });

  it("only a Team Cloud member's request records who made a bot", () => {
    const session = (membershipAuthority?: "team") => ({ kind: "session", scopes: ["admin"], session: { email: ADA, membershipAuthority } }) as unknown as RequestAuth;
    expect(teamCreator(session("team"))).toEqual({ createdBy: ADA });
    expect(teamCreator(session())).toEqual({});
    expect(teamCreator({ kind: "loopback" } as unknown as RequestAuth)).toEqual({});
  });

  it("off a team a new bot carries no sharing and everyone sees it", () => {
    const bot = new Store(selection).createBot({ name: "Plain" });
    expect(bot.access).toBeUndefined();
    expect(bot.visibility).toBeUndefined();
    expect(memberLevel(bot, MARTA)).toBe("chat");
  });

  it("on a team a new bot is Only people added with nobody added, from the record that is first saved", () => {
    const store = teamStore();
    const seen: Array<BotRecord["access"]> = [];
    const bot = store.createBot({ name: "Quotes", createdBy: ADA }, { beforeShown: (made) => seen.push(made.access) });
    expect(seen).toEqual([PRIVATE]);
    expect(new Store(selection).bot(bot.id)).toMatchObject({ access: PRIVATE, visibility: { people: [ADA] } });
    expect(memberLevel(bot, MARTA)).toBe("none");
    expect(memberLevel(bot, RUI)).toBe("none");

    const handed = store.createBot({ name: "Rui's", createdBy: ADA, reportsTo: RUI });
    expect(handed.visibility).toEqual({ people: [RUI] });
    expect(memberLevel(handed, MARTA)).toBe("none");

    const nobodys = store.createBot({ name: "Imported by the machine" });
    expect(nobodys).toMatchObject({ access: PRIVATE, visibility: "admins" });
  });

  it("on a team what the request chose wins, and a member's own MausBot stays theirs alone", () => {
    const store = teamStore();
    expect(accessOf(store.createBot({ name: "Open", createdBy: ADA, visibility: "everyone" }))).toEqual({ everyone: "chat", people: {} });
    expect(memberLevel(store.createBot({ name: "Listed", createdBy: ADA, visibility: { people: [MARTA] } }), MARTA)).toBe("chat");
    const own = createDefaultBot(store, { person: MARTA, team: "Acme" });
    expect(own.visibility).toEqual({ people: [MARTA] });
    expect(own.access).toBeUndefined();
  });

  it("a team's first bot, which nobody made, is everyone's", () => {
    const store = teamStore();
    store.seedIfEmpty({ defaultBot: false });
    expect(accessOf(store.bots[0]!)).toEqual({ everyone: "chat", people: {} });
    expect(memberLevel(store.bots[0]!, MARTA)).toBe("chat");
  });

  it("a bot a Chief makes is shared exactly as the Chief is, so the two can reach each other", () => {
    const store = teamStore();
    const mine = store.createBot({ name: "Ada's Chief", section: "Sales", createdBy: ADA });
    store.patchBot(mine.id, { chiefOfStaff: true });
    store.applyTeamSetup(setup(store.bot(mine.id)!, "private-helper"));
    expect(store.bot("private-helper")).toMatchObject({ access: PRIVATE, visibility: { people: [ADA] }, createdBy: ADA });
    expect(memberLevel(store.bot("private-helper")!, MARTA)).toBe("none");

    const shared = store.createBot({ name: "Team Chief", section: "Ops", createdBy: RUI, visibility: "everyone" });
    store.patchBot(shared.id, { chiefOfStaff: true, access: { everyone: "none", people: { [MARTA]: "chat" } }, visibility: { people: [RUI, MARTA] } });
    store.applyTeamSetup(setup(store.bot(shared.id)!, "shared-helper"));
    expect(store.bot("shared-helper")).toMatchObject({ access: { everyone: "none", people: { [MARTA]: "chat" } }, visibility: { people: [RUI, MARTA] } });
    expect(sharedAsMaker({})).toEqual({});
  });

  it("bots saved before this keep reading from their visibility: nothing shared becomes private", () => {
    const before = new Store(selection);
    const open = before.createBot({ name: "Old open" });
    const listed = before.createBot({ name: "Old listed", visibility: { people: [MARTA] } });
    const admins = before.createBot({ name: "Old admins", visibility: "admins" });
    const now = Object.assign(new Store(selection), { newBotSharing: privateUntilShared });
    expect(now.bot(open.id)?.access).toBeUndefined();
    expect(accessOf(now.bot(open.id)!)).toEqual({ everyone: "chat", people: {} });
    expect(memberLevel(now.bot(open.id)!, RUI)).toBe("chat");
    expect(memberLevel(now.bot(listed.id)!, MARTA)).toBe("chat");
    expect(memberLevel(now.bot(listed.id)!, RUI)).toBe("none");
    expect(memberLevel(now.bot(admins.id)!, MARTA)).toBe("none");
  });
});
