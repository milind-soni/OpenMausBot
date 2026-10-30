// Clicking a team bot opens the person's own conversation with it (src/state/team-chats.ts), checked against a real
// Team Cloud (T2: OMB_CLOUD_ROLE=team, members paired with the Admin's signed claims, per-conversation audiences). Runs
// once the cloud fixture can start a Team Cloud (T2); until then it is skipped.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { ownChatOf, rememberOwnChat, teamOfConfig, type TeamChats } from "../../src/state/team-chats.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { REPO_ROOT } from "./preview-fixture.ts";

type Member = { email: string; role: "owner" | "admin" | "member" };
type TeamFixture = { pair(member: Member): Promise<{ token: string | null }>; as(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> };
const teamFixture = readFileSync(join(REPO_ROOT, "scripts", "testing", "cloud-send-fixture.ts"), "utf8").includes('OMB_CLOUD_ROLE: "team"');
if (!teamFixture) console.info("skipping the team own-chat e2e: the cloud fixture has no Team Cloud yet (T2)");

(teamFixture ? describe : describe.skip)("a team bot opens the person's own conversation", () => {
  let fx: CloudSendFixture & { team?: TeamFixture | null };
  let team: TeamFixture;
  const tokens: Record<string, string> = {};
  let scout = "", main = "";
  const scoutAs = async (who: string) => ((await team.as(tokens[who]!, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string; private?: true }> }>).find((bot) => bot.id === scout)!;
  const chatsOf = async (who: string): Promise<TeamChats> => {
    const config = (await team.as(tokens[who]!, "GET", "/api/config")).body;
    const session = (await team.as(tokens[who]!, "GET", "/api/auth/session")).body as { scopes: string[]; openedThreads?: string[] };
    return { teamId: teamOfConfig(config)!.id, member: !session.scopes.includes("admin"), opened: session.openedThreads ?? [] };
  };
  // What a click does when none is listed yet: the server's own new-conversation route, as the page calls it.
  const make = async (who: string, chats: TeamChats) => {
    const created = await team.as(tokens[who]!, "POST", `/api/bots/${scout}/tasks`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rememberOwnChat(chats.teamId, created.body.task.threadId);
    return created.body.task as { threadId: string; private?: true };
  };

  beforeAll(async () => {
    const launch = launchCloudSendFixture as unknown as (options: Record<string, unknown>) => Promise<typeof fx>;
    fx = await launch({ onePasswordToken: `ops_fake-own-chat-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
    team = fx.team!;
    for (const [who, member] of Object.entries({ olive: { email: "olive@acme.test", role: "owner" }, ben: { email: "ben@acme.test", role: "admin" },
      ada: { email: "ada@acme.test", role: "member" }, cleo: { email: "cleo@acme.test", role: "member" } } as Record<string, Member>)) {
      tokens[who] = (await team.pair(member)).token!;
    }
    const created = await team.as(tokens.olive!, "POST", "/api/bots", { name: "Scout" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    scout = created.body.bot.id; main = created.body.bot.mainThreadId;
  }, hostTimeout(180_000));
  afterAll(async () => { await fx?.close(); }, hostTimeout(60_000));

  it("a Member gets a private conversation of their own, opened again next time; never the team's main chat", async () => {
    const chats = await chatsOf("ada");
    expect(chats).toEqual({ teamId: "team-acme-1", member: true, opened: [] });
    expect(ownChatOf(await scoutAs("ada"), chats), "none yet: the click makes one").toBeNull();
    const made = await make("ada", chats);
    expect(made.private, "the server records it as hers").toBe(true);
    expect(ownChatOf(await scoutAs("ada"), chats), "on another device too: a Member sees only her own").toBe(made.threadId);
    expect(made.threadId).not.toBe(main);
    expect((await scoutAs("ada")).tasks.find((task) => task.threadId === main)?.private, "the main chat is the team's").toBeUndefined();
  }, hostTimeout(60_000));

  it("an Admin never sees a member's private chat: a new conversation of their own instead, seen by no one else", async () => {
    const chats = await chatsOf("ben");
    expect(chats.member).toBe(false);
    const listed = await scoutAs("ben");
    expect(listed.tasks.some((task) => task.private === true), "Ada's chat is not listed for an Admin").toBe(false);
    expect(ownChatOf(listed, chats)).toBeNull();
    const made = await make("ben", chats);
    expect(made.private).toBe(true);
    expect(ownChatOf(await scoutAs("ben"), await chatsOf("ben"))).toBe(made.threadId);
    expect((await scoutAs("ben")).tasks.filter((task) => task.private === true).map((task) => task.threadId), "only his own").toEqual([made.threadId]);
    expect((await scoutAs("ada")).tasks.some((task) => task.threadId === made.threadId), "Ada never sees Ben's").toBe(false);
    const cleo = await chatsOf("cleo");
    expect(ownChatOf(await scoutAs("cleo"), cleo), "another Member sees neither Ada's nor Ben's").toBeNull();
  }, hostTimeout(60_000));

  it("an Admin on a second device reopens their own chat: the server names the conversations they opened", async () => {
    const mine = (await team.as(tokens.ben!, "GET", "/api/auth/session")).body.openedThreads as string[];
    expect(mine.length, "Ben opened one on his first device").toBe(1);
    const second = (await team.pair({ email: "ben@acme.test", role: "admin" })).token!;
    // Another device: a page of its own that never made a conversation, signed in as Ben.
    const session = (await team.as(second, "GET", "/api/auth/session")).body as { scopes: string[]; openedThreads: string[] };
    expect(session.openedThreads).toEqual(mine);
    const listed = ((await team.as(second, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string; private?: true }> }>).find((bot) => bot.id === scout)!;
    expect(ownChatOf(listed, { teamId: "team-acme-1", member: false, opened: session.openedThreads }), "his own, not a new one").toBe(mine[0]);
    expect(ownChatOf(listed, { teamId: "team-acme-1", member: false }), "without the server's word it would have made a new one").toBeNull();
    const adas = (await team.as(tokens.ada!, "GET", "/api/auth/session")).body.openedThreads as string[];
    expect(adas, "never Ben's").not.toContain(mine[0]);
  }, hostTimeout(60_000));
});
