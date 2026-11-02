// A real Team Cloud (OMB_CLOUD_ROLE=team) with the fake connected-apps service and fake MCP servers: connections the team
// makes once, and connections each person makes for themselves. Ada's own Gmail and mail key reach only work her own
// message started: her private chat, her own line in a group chat, and the work those hand on to other bots. Never
// anyone else's request or the work it hands on, Cleo's chat or an admin; and no admin read ever holds them. The engine
// is the synthetic Claude CLI, calling the connected-apps bridges it was launched with.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CLOUD_HOST, launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth } from "./testing/fake-oauth-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const ADA_KEY = "ada-own-mail-key-5521";
const TEAM_KEY = "team-mail-key-9034";
// Each turn reads its scripted calls again: a conversation's engine stays warm across turns, as in production.
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_MARKER_REPLIES = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/marker-replies.json";`;
const LINK = "https://cloud.example.test/cloud/team/team-acme-1";

let fx: CloudSendFixture, team: CloudTeamFixture, broker: BrokerFake, mail: FakeHttpMcp, notes: FakeHttpMcp, oauth: FakeOAuth;
let owner = "", admin = "", ada = "", cleo = "";
let bot: { id: string; mainThreadId: string };
let teamUser = "", adaUser = "", adaThread = "", cleoThread = "", roomId = "", roomThread = "";

beforeAll(async () => {
  broker = await startBrokerFake();
  mail = await startFakeHttpMcp({ tools: [{ name: "read_inbox" }] });
  oauth = await startFakeOAuth();
  notes = await startFakeHttpMcp({ tools: [{ name: "read_notes" }], acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE, env: { OMB_BOT_BOX: "0" } } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  cleo = (await team.pair(CLEO)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  // The Team Cloud registered its own installation as it started: the team's Gmail is connected there.
  teamUser = broker.userFor(broker.installationIds().filter((id) => id !== fx.desktopInstallation?.id && broker.actingUser(id) === broker.userFor(id)).at(-1)!);
  broker.account(teamUser, "gmail", "team@acme.test");
  const added = await team.as(owner, "POST", "/api/mcp/servers", { name: "mail", type: "http", url: mail.url, headers: { Authorization: `Bearer ${TEAM_KEY}` } });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  expect((await team.as(owner, "PATCH", "/api/mcp/servers/mail", { enabled: true })).status).toBe(200);
  const room = await team.as(owner, "POST", "/api/groups", { name: "Launch", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  roomId = room.body.group.id; roomThread = room.body.group.threadId;
  adaThread = await newThread(ada, "Ada and Scout");
  cleoThread = await newThread(cleo, "Cleo and Scout");
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await broker?.close();
  await mail?.close();
  await notes?.close();
  await oauth?.close();
});

type Dump = { systemPrompt: string; mcpConfig: { mcpServers: Record<string, unknown> } };
const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as Dump;
const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const gmailCall = (server: "composio" | "own_apps") => ({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", server, input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }] } });
const messages = async (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function newThread(token: string, title: string) {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
}
/** One turn, from `token`, and what the engine was launched with; `room` sends it in the group chat. */
async function turn(token: string, threadId: string, text: string, options: { room?: string; calls?: unknown[] } = {}) {
  scriptToolCalls(options.calls ?? null);
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = ((await messages(token, threadId)).body.messages as unknown[]).length;
  const sent = options.room
    ? await team.as(token, "POST", `/api/groups/${options.room}/messages`, { text, threadId })
    : await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && ((await messages(token, threadId)).body.messages as unknown[]).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  const seen = dump();
  return { ...seen, servers: Object.keys(seen.mcpConfig?.mcpServers ?? {}), config: JSON.stringify(seen.mcpConfig ?? {}), thread: JSON.stringify((await messages(token, threadId)).body) };
}
const gmailCallsBy = (user: string) => broker.mcpCalls.filter((call) => call.method === "tools/call" && call.user === user).length;

it("keeps every connection the team's until an admin says otherwise", async () => {
  const before = gmailCallsBy(teamUser);
  const seen = await turn(ada, adaThread, "Check the inbox.", { calls: [gmailCall("composio")] });
  expect(seen.servers).toContain("composio");
  expect(seen.servers).not.toContain("own_apps");
  // The team's mail server with the team's key, in a member's chat as everywhere.
  expect(seen.config).toContain(TEAM_KEY);
  expect(gmailCallsBy(teamUser)).toBe(before + 1);
  const read = await team.signed("GET", "/api/cloud/team/admin");
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ scopes: { apps: [], mcp: [] }, people: { apps: {}, mcp: {} } });
}, hostTimeout(90_000));

it("lets only an admin make an app or a server each person's", async () => {
  expect((await team.as(ada, "PUT", "/api/team/connection-scopes", { kind: "app", id: "gmail", scope: "person" })).status).toBe(403);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "nope", scope: "person" })).status).toBe(404);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "app", id: "Gmail!", scope: "person" })).status).toBe(400);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "app", id: "gmail", scope: "person" })).body).toEqual({ scopes: { apps: ["gmail"], mcp: [] } });
  expect((await team.as(admin, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "mail", scope: "person" })).body).toEqual({ scopes: { apps: ["gmail"], mcp: ["mail"] } });
  // My Cloud has no such thing.
  expect((await fx.onCloud("PUT", "/api/team/connection-scopes", { kind: "app", id: "gmail", scope: "person" })).status).toBe(404);
  expect((await fx.onCloud("GET", "/api/team/my-connections")).status).toBe(404);
}, hostTimeout(30_000));

it("lets Ada connect her own Gmail and mail key, and nobody reads them back", async () => {
  const empty = await team.as(ada, "GET", "/api/team/my-connections");
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ team: { name: "Acme" }, link: LINK, email: ADA.email,
    apps: [{ slug: "gmail", name: "Gmail", connected: false }], mcp: [{ name: "mail", connected: false, offers: "key" }] });
  const before = broker.installationIds().length;
  const started = await team.as(ada, "POST", "/api/team/my-connections/apps/gmail/connect", {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body.url).toMatch(/^https:\/\/backend\.composio\.dev\/link\//);
  // Her own installation on the connected-apps service: her own Composio user, never the team's.
  expect(broker.installationIds().length).toBe(before + 1);
  adaUser = broker.userFor(broker.installationIds().at(-1)!);
  expect(adaUser).not.toBe(teamUser);
  broker.account(adaUser, "gmail", "ada.private@gmail.example");
  expect((await team.as(ada, "PUT", "/api/team/my-connections/mcp/mail/key", { value: ADA_KEY })).body).toEqual({ ok: true });
  // A team app is not hers to connect, and Slack is the team's.
  expect((await team.as(ada, "POST", "/api/team/my-connections/apps/slack/connect", {})).status).toBe(409);

  const mine = await team.as(ada, "GET", "/api/team/my-connections");
  expect(mine.body.apps).toEqual([{ slug: "gmail", name: "Gmail", connected: true, accounts: [expect.objectContaining({ alias: "ada.private@gmail.example", status: "ACTIVE" })] }]);
  expect(mine.body.mcp).toEqual([expect.objectContaining({ name: "mail", connected: true, how: "key" })]);
  expect(JSON.stringify(mine.body)).not.toContain(ADA_KEY);
  const cleos = await team.as(cleo, "GET", "/api/team/my-connections");
  expect(cleos.body.apps[0].connected).toBe(false);
  expect(cleos.body.mcp[0].connected).toBe(false);

  // Admins see that she connected, never what with.
  const read = await team.signed("GET", "/api/cloud/team/admin");
  expect(read.body.scopes).toEqual({ apps: ["gmail"], mcp: ["mail"] });
  expect(read.body.people).toEqual({ apps: { gmail: [ADA.email] }, mcp: { mail: [ADA.email] } });
  const held = JSON.parse(readFileSync(join(team.home, ".openmausbot", "people-connections", "apps.json"), "utf8")).people[personKey({ id: "", email: ADA.email })].token as string;
  for (const answer of [read.body, (await team.as(owner, "GET", "/api/mcp/servers")).body, (await team.as(admin, "GET", "/api/config")).body,
    (await team.as(owner, "GET", "/api/connectors/connected")).body, (await team.as(admin, "GET", "/api/team/my-connections")).body]) {
    expect(JSON.stringify(answer)).not.toContain(ADA_KEY);
    expect(JSON.stringify(answer)).not.toContain(held);
    expect(JSON.stringify(answer)).not.toContain("ada.private@gmail.example");
  }
  // On the volume: a folder of its own, 0700, that no backup carries.
  if (process.platform !== "win32") expect(statSync(join(team.home, ".openmausbot", "people-connections")).mode & 0o777).toBe(0o700);
}, hostTimeout(60_000));

it("gives Ada's own Gmail and mail to her private chat, for her own request, and runs as her", async () => {
  const before = gmailCallsBy(adaUser), teamBefore = gmailCallsBy(teamUser);
  const seen = await turn(ada, adaThread, "Summarize my inbox.", { calls: [gmailCall("own_apps")] });
  expect(seen.servers).toEqual(expect.arrayContaining(["composio", "own_apps", "mail"]));
  expect(seen.config).toContain(ADA_KEY);
  expect(seen.config, "a person's server never carries the team's key").not.toContain(TEAM_KEY);
  expect(seen.systemPrompt).toContain("Gmail is ada@acme.test's own: use it through the own_apps tools");
  expect(gmailCallsBy(adaUser)).toBe(before + 1);
  expect(gmailCallsBy(teamUser)).toBe(teamBefore);
  // The step says whose Gmail it used.
  expect(seen.thread).toContain(`"whose":{"person":"${ADA.email}","app":"Gmail"}`);
  // The team's bridge refuses her Gmail and points at her own.
  const team_ = await turn(ada, adaThread, "Use the team's Gmail.", { calls: [gmailCall("composio")] });
  expect(team_.thread).toContain(`Gmail here is ${ADA.email}'s own: use it through the own_apps tools`);
  expect(gmailCallsBy(teamUser)).toBe(teamBefore);
  // Each bridge keeps its own bearer from turn to turn, so her conversation's engine stays warm.
  const bearer = (dumped: Dump, server: string) => (dumped.mcpConfig.mcpServers[server] as { env: Record<string, string> }).env.OMB_CONNECTOR_TOKEN;
  expect(bearer(team_, "own_apps")).toBe(bearer(seen, "own_apps"));
  expect(bearer(team_, "composio")).toBe(bearer(seen, "composio"));
  expect(bearer(seen, "own_apps")).not.toBe(bearer(seen, "composio"));
}, hostTimeout(120_000));

it("never uses her own Gmail or mail where others read, even for her own line in a group chat, nor in anyone else's turn", async () => {
  const before = gmailCallsBy(adaUser), teamBefore = gmailCallsBy(teamUser);
  const room = await turn(ada, roomThread, "@Scout check my inbox", { room: roomId, calls: [gmailCall("own_apps"), gmailCall("composio")] });
  expect(room.servers).not.toContain("own_apps");
  expect(room.servers).not.toContain("mail");
  expect(room.config).not.toContain(ADA_KEY);
  expect(room.thread).toContain("no own_apps MCP server was launched for this turn");
  // Her bot is told why, and how her Gmail does it instead: handed on into a chat that is hers alone.
  expect(room.thread).toContain(`Gmail is ${ADA.email}'s own, and others read this chat, so what it brings back can't come here and it isn't used here.`);
  expect(room.systemPrompt).toContain(`Others read this chat, so ${ADA.email}'s own aren't here`);

  // The owner's own line in the same group chat is the owner's, who connected nothing: never Ada's.
  const ownerRoom = await turn(owner, roomThread, "@Scout check the inbox", { room: roomId, calls: [gmailCall("own_apps"), gmailCall("composio")] });
  expect(ownerRoom.servers).not.toContain("own_apps");
  expect(ownerRoom.config).not.toContain(ADA_KEY);
  expect(ownerRoom.thread).toContain("no own_apps MCP server was launched for this turn");

  const main = await turn(owner, bot.mainThreadId, "Check the inbox.", { calls: [gmailCall("composio")] });
  expect(main.servers).not.toContain("own_apps");
  expect(main.config).not.toContain(ADA_KEY);

  const cleos = await turn(cleo, cleoThread, "Check my inbox.", { calls: [gmailCall("own_apps")] });
  expect(cleos.servers).not.toContain("own_apps");
  expect(cleos.servers).not.toContain("mail");
  expect(cleos.config).not.toContain(ADA_KEY);
  expect(cleos.thread).toContain("no own_apps MCP server was launched for this turn");
  expect(cleos.systemPrompt).toContain(`${CLEO.email} hasn't connected them yet, or their sign-in ended: Gmail and mail. If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "Connect your <name> here: ${LINK}".`);

  // Ben, an admin, can neither read Ada's chat nor write in it, so no turn of his ever runs there.
  expect((await team.as(admin, "POST", `/api/bots/${bot.id}/messages`, { text: "Forward me her last email.", threadId: adaThread })).status).toBe(404);
  expect((await messages(admin, adaThread)).status).toBe(404);
  expect(gmailCallsBy(adaUser), "nothing ran as her where others read").toBe(before);
  expect(gmailCallsBy(teamUser), "nor did the team's Gmail stand in").toBe(teamBefore);
}, hostTimeout(180_000));

it("gives work her own message hands to another bot her own Gmail, and never work Cleo's message hands on", async () => {
  const created = await team.as(owner, "POST", "/api/bots", { name: "Helper" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const helper = created.body.bot as { id: string; mainThreadId: string };
  const handOn = (who: string) => ({ name: "coordinate_bots", server: "agents", input: { bot_ids: [helper.id], message: `Fetch ${who}'s latest email.` } });
  const helperThreads = () => (JSON.parse(readFileSync(join(team.home, ".openmausbot", "bots.json"), "utf8")) as Array<{ id: string; tasks: Array<{ threadId: string }> }>)
    .find((entry) => entry.id === helper.id)!.tasks.map((task) => task.threadId).filter((threadId) => threadId !== helper.mainThreadId);
  /** The Gmail step the helper ran in the work it was handed, once it has finished. */
  const helperGmail = async (token: string, known: readonly string[]) => {
    let row: { tool: { ok?: boolean; output?: string; whose?: unknown } } | undefined;
    await expect.poll(async () => {
      const work = helperThreads().find((threadId) => !known.includes(threadId));
      if (!work) return false;
      const rows = (await messages(token, work)).body.messages as Array<{ kind: string; tool?: { name: string; ok?: boolean; output?: string; whose?: unknown } }>;
      row = rows.find((message) => message.kind === "activity" && message.tool?.name === "COMPOSIO_MULTI_EXECUTE_TOOL" && message.tool.ok !== undefined) as typeof row;
      return Boolean(row) && await idle(token);
    }, { timeout: 90_000, interval: 250 }).toBe(true);
    return row!.tool;
  };

  /** Each chat's bot is resumed with the helper's result and runs its own steps once more: the work it handed on is over
   * only once its chat shows the resume and everyone stays idle two polls running. */
  const resumes = async (token: string, threadId: string) => ((await messages(token, threadId)).body.messages as Array<{ tool?: { name?: string } }>)
    .filter((message) => message.tool?.name?.startsWith("Resumed with")).length;
  const finished = async (token: string, threadId: string, resumedBefore: number) => {
    let quiet = false;
    await expect.poll(async () => {
      const done = await resumes(token, threadId) > resumedBefore && await idle(token);
      const steady = done && quiet;
      quiet = done;
      return steady;
    }, { timeout: 90_000, interval: 1_000 }).toBe(true);
  };

  const before = gmailCallsBy(adaUser), teamBefore = gmailCallsBy(teamUser);
  const known = helperThreads(), adaResumes = await resumes(ada, adaThread);
  await turn(ada, adaThread, "Have Helper fetch my latest email.", { calls: [handOn("Ada"), gmailCall("own_apps")] });
  const adas = await helperGmail(ada, known);
  expect(adas.ok, adas.output).toBe(true);
  expect(adas.whose, "the step says whose").toEqual({ person: ADA.email, app: "Gmail" });
  expect(gmailCallsBy(adaUser), "her bot and the helper both ran as her").toBeGreaterThanOrEqual(before + 2);
  // Her bot, resumed with the helper's result, runs its step as her once more: count only once all of her work is over.
  await finished(ada, adaThread, adaResumes);
  expect(gmailCallsBy(adaUser), "her bot, the helper, and her bot again").toBe(before + 3);

  const adaCalls = gmailCallsBy(adaUser), seen = helperThreads(), cleoResumes = await resumes(cleo, cleoThread);
  await turn(cleo, cleoThread, "Have Helper fetch my latest email.", { calls: [handOn("Cleo"), gmailCall("own_apps")] });
  const cleos = await helperGmail(cleo, seen);
  await finished(cleo, cleoThread, cleoResumes);
  expect(cleos.ok).toBe(false);
  expect(cleos.output, "Cleo connected nothing, and Ada's is never hers").toContain("no own_apps MCP server was launched for this turn");
  expect(cleos.whose).toBeUndefined();
  expect(gmailCallsBy(adaUser)).toBe(adaCalls);
  expect(gmailCallsBy(teamUser), "nor did the team's Gmail stand in").toBe(teamBefore);
}, hostTimeout(240_000));

it("runs work her group-chat line hands on in the receiving bot's chat with her, and the room gets only where the result is", async () => {
  // What her Gmail brought back: the handed-on work's reply holds it (the envelope it is sent in opens "Brief from @Scout:").
  const SECRET = "Q3 salary review 7731";
  writeFileSync(join(team.home, "marker-replies.json"), JSON.stringify({ "Brief from @Scout:": `Ada's latest email: ${SECRET}.` }));
  try {
    const created = await team.as(owner, "POST", "/api/bots", { name: "Clerk" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const clerk = created.body.bot as { id: string; mainThreadId: string };
    const clerkWork = () => (JSON.parse(readFileSync(join(team.home, ".openmausbot", "bots.json"), "utf8")) as Array<{ id: string; tasks: Array<{ threadId: string }> }>)
      .find((entry) => entry.id === clerk.id)!.tasks.map((task) => task.threadId).filter((threadId) => threadId !== clerk.mainThreadId);
    /** The room's row for Clerk's result: Scout is resumed with it in the room right after. */
    const clerkReplied = async () => ((await messages(ada, roomThread)).body.messages as Array<{ roomRequest?: { phase?: string }; tool?: { name?: string } }>)
      .filter((message) => message.roomRequest?.phase === "result" && message.tool?.name === "Clerk replied").length;
    const before = gmailCallsBy(adaUser), teamBefore = gmailCallsBy(teamUser);
    const handOn = { name: "coordinate_bots", server: "agents", input: { bot_ids: [clerk.id], message: "Fetch Ada's latest email." } };
    await turn(ada, roomThread, "@Scout have Clerk fetch my latest email", { room: roomId, calls: [handOn, gmailCall("own_apps")] });
    // Clerk's work is done once Scout, resumed with it in the room, has finished too: everyone idle two polls running.
    let quiet = false;
    await expect.poll(async () => {
      const done = await clerkReplied() > 0 && await idle(ada);
      const steady = done && quiet;
      quiet = done;
      return steady;
    }, { timeout: 90_000, interval: 1_000 }).toBe(true);
    const [work] = clerkWork();
    expect(work, "Clerk was handed the work").toBeDefined();

    // Ada sees it all, in Clerk's chat with her: her own Gmail ran there, and the result.
    const hers = await messages(ada, work!);
    expect(hers.status).toBe(200);
    expect(JSON.stringify(hers.body)).toContain(SECRET);
    expect(JSON.stringify(hers.body)).toContain(`"whose":{"person":"${ADA.email}","app":"Gmail"}`);
    expect(gmailCallsBy(adaUser), "Clerk ran as her, and nothing in the room did").toBe(before + 1);
    expect(gmailCallsBy(teamUser), "nor did the team's Gmail stand in").toBe(teamBefore);

    // The group chat gets only where the result is.
    const room = await messages(cleo, roomThread);
    expect(room.status, "Cleo reads the group chat").toBe(200);
    expect(JSON.stringify(room.body)).toContain(`Done. The result is in Clerk's chat with ${ADA.email}.`);
    expect(JSON.stringify(room.body)).not.toContain(SECRET);

    // Cleo sees it in no thread and no list; the admins see what they always did, which is none of Ada's chats.
    for (const token of [cleo, admin, owner]) expect((await messages(token, work!)).status).toBe(404);
    const chatsOf = (body: { bots: Array<{ id: string; tasks?: Array<{ threadId: string }> }> }) => body.bots.find((entry) => entry.id === clerk.id)?.tasks?.map((task) => task.threadId) ?? [];
    const listed = await team.as(cleo, "GET", "/api/bots");
    expect(chatsOf(listed.body), "not among Clerk's chats Cleo is shown").not.toContain(work);
    expect(chatsOf((await team.as(ada, "GET", "/api/bots")).body), "among Ada's").toContain(work);
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);
    const threads = (listed.body.bots as Array<{ tasks?: Array<{ threadId: string }> }>).flatMap((entry) => (entry.tasks ?? []).map((task) => task.threadId));
    for (const threadId of new Set([...threads, roomThread])) expect(JSON.stringify((await messages(cleo, threadId)).body), threadId).not.toContain(SECRET);
    expect(JSON.stringify((await team.as(cleo, "GET", "/api/inbox")).body)).not.toContain(SECRET);
    expect(JSON.stringify((await team.as(cleo, "GET", "/api/groups")).body)).not.toContain(SECRET);
  } finally {
    rmSync(join(team.home, "marker-replies.json"), { force: true });
  }
}, hostTimeout(240_000));

it("tells the bot one plain line with the link when a person's app isn't connected, never a card", async () => {
  const seen = await turn(cleo, cleoThread, "Connect my Gmail.", { calls: [{ name: "COMPOSIO_MANAGE_CONNECTIONS", server: "composio", input: { toolkits: ["gmail"] } }] });
  expect(seen.thread).toContain(`Connect your Gmail here: ${LINK}`);
  expect(((await messages(cleo, cleoThread)).body.messages as Array<{ kind: string }>).some((message) => message.kind === "connector")).toBe(false);
}, hostTimeout(60_000));

it("signs Cleo in to a notes server of her own, and only her chat gets her token", async () => {
  const added = await team.as(owner, "POST", "/api/mcp/servers", { name: "notes", type: "http", url: notes.url, headers: {} });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  expect((await team.as(owner, "PATCH", "/api/mcp/servers/notes", { enabled: true })).status).toBe(200);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "notes", scope: "person" })).status).toBe(200);
  const started = await team.as(cleo, "POST", "/api/team/my-connections/mcp/notes/sign-in", {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(new URL(started.body.auth.authorizationUrl).searchParams.get("redirect_uri")).toBe(`https://${CLOUD_HOST}/mcp-oauth/callback`);
  const back = new URL((await fetch(started.body.auth.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
  // The provider sends the browser back to the Team Cloud's own address (fetch can't set Host, so http.get does).
  const page = await new Promise<string>((resolve, reject) => {
    const base = new URL(team.base);
    get({ hostname: base.hostname, port: base.port, path: `/mcp-oauth/callback${back.search}`, headers: { host: CLOUD_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; }).on("end", () => resolve(`${res.statusCode} ${text}`));
    }).on("error", reject);
  });
  expect(page).toBe("200 Signed in. You can close this tab and return to OpenMausBot.");
  expect((await team.as(cleo, "GET", "/api/team/my-connections")).body.mcp).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes", connected: true, how: "sign-in" })]));
  const cleos = await turn(cleo, cleoThread, "Read my notes.");
  const token = /Bearer ([\w.-]+)/.exec(JSON.stringify((cleos.mcpConfig.mcpServers as Record<string, unknown>).notes))?.[1];
  expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
  const adas = await turn(ada, adaThread, "Read the notes.");
  expect(adas.servers).not.toContain("notes");
  expect(adas.config).not.toContain(token!);
  expect((await team.signed("GET", "/api/cloud/team/admin")).body.people.mcp.notes).toEqual([CLEO.email]);
}, hostTimeout(120_000));

it("disconnects her own, and switching back to the team gives every turn the team's again", async () => {
  expect((await team.as(ada, "DELETE", "/api/team/my-connections/mcp/mail")).body).toEqual({ ok: true });
  const without = await turn(ada, adaThread, "Check mail.");
  expect(without.servers).not.toContain("mail");
  expect(without.config).not.toContain(ADA_KEY);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "app", id: "gmail", scope: "team" })).status).toBe(200);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "mail", scope: "team" })).status).toBe(200);
  const teamBefore = gmailCallsBy(teamUser);
  const back = await turn(cleo, cleoThread, "Check the inbox.", { calls: [gmailCall("composio")] });
  expect(back.servers).not.toContain("own_apps");
  expect(back.config).toContain(TEAM_KEY);
  expect(gmailCallsBy(teamUser)).toBe(teamBefore + 1);
}, hostTimeout(120_000));

it.each([false, true])("tests a person-scoped OAuth server after panel sign-in (registered client: %s)", async (registered) => {
  const provider = await startFakeOAuth({ preRegistered: { "panel-client": null } });
  const server = await startFakeHttpMcp({ acceptBearer: provider.isValid, wwwAuthenticate: provider.challenge });
  const path = "/api/mcp/servers/panel_oauth";
  try {
    expect((await team.as(owner, "POST", "/api/mcp/servers", {
      name: "panel_oauth", type: "http", url: server.url,
      ...(registered ? { oauth: { clientId: "panel-client" }, headers: { "X-Workspace": "acme" } } : {}),
    })).status).toBe(201);
    expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "panel_oauth", scope: "person" })).status).toBe(200);
    expect((await team.as(owner, "POST", `${path}/test`, {})).body.auth).toBe("required");
    const started = await team.as(owner, "POST", `${path}/sign-in`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const redirect = await fetch(started.body.auth.authorizationUrl, { redirect: "manual" });
    const flowPath = `${path}/sign-in/${started.body.auth.flowId}`;
    const completed = await team.as(owner, "POST", flowPath, { callbackUrl: redirect.headers.get("location") });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.auth.phase).toBe("succeeded");
    expect((await team.as(owner, "GET", flowPath)).body.auth.phase).toBe("succeeded");
    const tested = await team.as(owner, "POST", `${path}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true, tools: [{ name: "read_notes" }] });
    expect((await team.as(owner, "POST", `${path}/sign-out`, {})).status).toBe(200);
    expect((await team.as(owner, "POST", `${path}/test`, {})).body.auth).toBe("required");
  } finally {
    await team.as(owner, "DELETE", path);
    await server.close();
    await provider.close();
  }
}, hostTimeout(60_000));

it("skips automatic personal MCP probes after setup and restart while still probing team servers", async () => {
  const ownAuthorization = "Bearer own-probe-key";
  const teamAuthorization = "Bearer team-probe-key";
  const personal = await startFakeHttpMcp({ requireHeaders: { Authorization: ownAuthorization } });
  const shared = await startFakeHttpMcp({ requireHeaders: { Authorization: teamAuthorization },
    tools: [{ name: "show_view", _meta: { ui: { resourceUri: "ui://probe/view.html" } } }] });
  try {
    const own = { type: "http", url: personal.url, headers: { Authorization: "" } };
    expect((await team.as(owner, "POST", "/api/mcp/servers", { name: "personal_probe", ...own })).status).toBe(201);
    expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "personal_probe", scope: "person" })).status).toBe(200);
    expect((await team.as(owner, "PUT", "/api/team/my-connections/mcp/personal_probe/key", { value: ownAuthorization, url: personal.url })).status).toBe(200);
    expect((await team.as(owner, "PUT", "/api/mcp/servers/personal_probe", { ...own, enabled: false })).status).toBe(200);
    const tested = await team.as(owner, "POST", "/api/mcp/servers/personal_probe/test", {});
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true });
    expect(personal.toolsLists).toBe(1);
    expect((await team.as(owner, "PATCH", "/api/mcp/servers/personal_probe", { enabled: true })).status).toBe(200);

    expect((await team.as(owner, "POST", "/api/mcp/servers", {
      name: "team_probe", type: "http", url: shared.url, headers: { Authorization: teamAuthorization },
    })).status).toBe(201);
    expect((await team.as(owner, "PATCH", "/api/mcp/servers/team_probe", { enabled: true })).status).toBe(200);
    const teamHasApps = async () => {
      const listed = await team.as(owner, "GET", "/api/mcp/servers");
      expect(listed.status).toBe(200);
      return listed.body.servers.find((server: { name: string }) => server.name === "team_probe")?.hasApps;
    };
    await expect.poll(teamHasApps, { timeout: 20_000 }).toBe(true);
    expect(shared.toolsLists).toBe(1);
    expect.soft(personal.seenHeaders.filter((headers) => headers.authorization !== ownAuthorization), "after personal setup").toEqual([]);

    personal.seenHeaders.length = 0;
    rmSync(join(team.home, ".openmausbot", "mcp-app-catalog.json"));
    await team.relaunch();
    await expect.poll(teamHasApps, { timeout: 40_000 }).toBe(true);
    expect(shared.toolsLists).toBe(2);
    expect.soft(personal.seenHeaders, "after restart with a cold app catalog").toEqual([]);
    expect(shared.seenHeaders.every((headers) => headers.authorization === teamAuthorization)).toBe(true);
  } finally {
    await team.as(owner, "DELETE", "/api/mcp/servers/personal_probe");
    await team.as(owner, "DELETE", "/api/mcp/servers/team_probe");
    await personal.close();
    await shared.close();
  }
}, hostTimeout(120_000));
