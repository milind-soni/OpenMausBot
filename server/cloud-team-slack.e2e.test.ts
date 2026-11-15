// Slack for Team Clouds on a real Team Cloud (docs/team-slack.md). The Admin's part is played here: a session opened
// for each member through the signed pairing (label "Slack (MausBot Cloud)"), the three routes called with it, and a
// stand-in Admin that takes the Cloud's signed reports and checks them as the real one does. A channel message becomes
// a shared conversation its writer asked in; a direct message their private chat; the app's own rules decide who may
// ask, read and stop. Disposable homes and the synthetic Claude CLI; no Slack and no real Admin are reached.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { cloudRequestSignature } from "./cloud-home.ts";
import { teamRosterSignature } from "./cloud-team-roster.ts";
import { personKey } from "./person-key.ts";
import { TEAM_SLACK_FILE, TEAM_SLACK_REPORT_PATH, teamSlackSignature } from "./team-slack.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "owner" as const };
const ARI = { email: "ari@acme.test", role: "admin" as const };
const PRIYA = { email: "priya@acme.test", role: "member" as const };
const TOM = { email: "tom@acme.test", role: "member" as const };
const priyaKey = personKey({ id: "", email: PRIYA.email });
const SLACK_LABEL = "Slack (MausBot Cloud)";
const ENGINE = `const { existsSync } = process.getBuiltinModule("node:fs");
const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_DUMP = dir + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = dir + "/tool-calls.json";
process.env.FAKE_CLAUDE_RELEASE = dir + "/release";
process.env.FAKE_CLAUDE_MARKER_REPLIES = dir + "/markers.json";
if (existsSync(dir + "/hang-mode")) process.env.FAKE_CLAUDE_MODE = "hang";`;
const HOLD = { name: "Bash", input: { command: "gh run watch 42" }, hold: true };
/** A turn's prompt can carry earlier lines of its conversation, and the engine answers the first marker it finds: later asks first. */
const ANSWERS: Record<string, string> = {
  "And the week after?": "The week after is **quiet**.",
  "What ships on Friday?": "The **invoice run** ships on Friday.",
  "Tom here: who is on call?": "Sam is on call.",
  "What is my badge code?": "I can't share badge codes here.",
  "Remind me what I like": "You like short answers.",
  "Draft my week": "Your week is drafted.",
  "Private notes please": "Noted privately.",
  "Is the report out?": "The report is out.",
};
const ABOUT = "ABOUT-PRIYA-7731 prefers oolong", BADGE = "BADGE-PRIYA-4471";

type Report = { id: string; status: string; text?: string; waiting?: string; error?: string; conversationId?: string; bot?: { id: string; name: string; avatarUrl?: string }; openUrl?: string };
type Task = { threadId: string; title: string; private?: boolean; shared?: boolean; busy?: boolean };
type Bot = { id: string; name: string; threadId: string; busy?: boolean; defaultBot?: { person?: string }; tasks?: Task[] };
type Row = { id: string; role: string; kind: string; text?: string; sender?: { name: string }; card?: { requestId?: string; answered?: string }; tool?: { name: string }; stoppedBy?: { name: string } };

const admin = {
  /** Every request to the report path, as the real Admin would judge it. */
  taken: [] as { report: Report; headers: Record<string, string>; raw: string }[],
  refused: 0,
  /** Message ids this team's Admin handed over; any other id is not this team's. */
  known: new Set<string>(),
  /** How many final reports the stand-in answers 503 before it takes one. */
  failFinal: 0,
};
let adminServer: Server, fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", ari = "", priya = "", tom = "", adaSlack = "", priyaSlack = "", tomSlack = "";
let scout: Bot, reporter: Bot, vault: Bot, payroll: Bot, notes: Bot, priyaOwn: Bot;
const sockets: Socket[] = [];

const file = (name: string) => join(team.home, name);
const dataFile = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Bot[];
const taskOf = async (token: string, botId: string, threadId: string) => (await bots(token)).find((bot) => bot.id === botId)?.tasks?.find((task) => task.threadId === threadId);
const rows = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Row[];
const idle = async () => (await bots(ada)).every((bot) => !bot.busy && !(bot.tasks ?? []).some((task) => task.busy));
const statuses = (id: string) => admin.taken.filter((entry) => entry.report.id === id).map((entry) => entry.report.status);
const lastReport = (id: string) => admin.taken.findLast((entry) => entry.report.id === id)!.report;
const until = (done: () => Promise<boolean> | boolean, timeout = 60_000) => expect.poll(done, { timeout: hostTimeout(timeout), interval: 100 }).toBe(true);
const finished = (id: string, status = "completed") => until(() => statuses(id).at(-1) === status);

type Ask = { audience: "team" | "member"; bot?: { id: string } | { name: string } | { default: true }; conversationId?: string | null; text: string; id?: string; channelName?: string };
/** One Slack message as the Admin delivers it, with the session it opened for its writer. */
async function slack(token: string, ask: Ask) {
  const id = ask.id ?? randomUUID();
  admin.known.add(id);
  const direct = ask.audience === "member";
  const answer = await team.as(token, "POST", "/api/slack/team/messages", { v: 1, id, audience: ask.audience, bot: ask.bot ?? { id: scout.id }, conversationId: ask.conversationId ?? null, text: ask.text,
    slack: { workspace: "T0ACME", channel: direct ? "D0PRIYA" : "C0SALES", threadTs: "1731662000.000100", messageTs: "1731662000.000100", user: "U0PRIYA", ...(ask.channelName ? { channelName: ask.channelName } : {}) } });
  return { id, ...answer };
}
const stop = (token: string, id: string) => team.as(token, "POST", `/api/slack/team/messages/${id}/stop`, { v: 1 });
const dump = () => JSON.parse(readFileSync(file("dump.json"), "utf8")) as { prompt?: unknown; systemPrompt?: string; mcpConfig?: { mcpServers?: { ogb?: { args?: string[] } } } };

beforeAll(async () => {
  adminServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8"), headers = req.headers as Record<string, string>;
      const answer = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url !== TEAM_SLACK_REPORT_PATH || req.method !== "POST") return answer(404, { error: "not found" });
      const machine = headers["x-omb-cloud-machine"] ?? "", timestamp = headers["x-omb-cloud-timestamp"] ?? "", nonce = headers["x-omb-cloud-nonce"] ?? "";
      const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(headers["x-omb-cloud-signature"] ?? "")?.[1];
      const expected = Buffer.from(teamSlackSignature(team.secret, machine, timestamp, nonce, raw), "base64url"), given = Buffer.from(presented ?? "", "base64url");
      if (machine !== team.machineId || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        admin.refused++;
        return answer(401, { error: "That request isn't signed by a Team Cloud." });
      }
      const report = JSON.parse(raw) as Report & { v: number };
      if (!admin.known.has(report.id)) return answer(404, { error: "There is no such message.", code: "unknown_message" });
      if (admin.failFinal > 0 && ["completed", "failed", "stopped"].includes(report.status)) { admin.failFinal--; return answer(503, { error: "busy" }); }
      const over = admin.taken.some((entry) => entry.report.id === report.id && ["completed", "failed", "stopped"].includes(entry.report.status));
      admin.taken.push({ report, headers, raw });
      answer(200, over ? { ok: true, done: true } : { ok: true });
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-slack-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-slack", name: "Acme", engine: ENGINE,
    env: { OMB_BOT_BOX: "0", FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}` } } });
  team = fx.team!;
  writeFileSync(file("markers.json"), JSON.stringify(ANSWERS));
  writeFileSync(file("tool-calls.json"), "[]");
  writeFileSync(file("release"), "");
  ada = (await team.pair(ADA)).token!;
  ari = (await team.pair(ARI)).token!;
  priya = (await team.pair(PRIYA)).token!;
  tom = (await team.pair(TOM)).token!;
  for (const [token, name] of [[ada, "Ada"], [priya, "Priya"], [tom, "Tom"]]) expect((await team.as(token, "PUT", "/api/me", { name })).status).toBe(200);
  adaSlack = (await team.pair(ADA, { label: SLACK_LABEL })).token!;
  priyaSlack = (await team.pair(PRIYA, { label: SLACK_LABEL })).token!;
  tomSlack = (await team.pair(TOM, { label: SLACK_LABEL })).token!;
  const create = async (token: string, body: Record<string, unknown>) => {
    const created = await team.as(token, "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  scout = await create(ada, { name: "Scout", visibility: "everyone" });
  reporter = await create(ada, { name: "Reporter", visibility: "everyone", reportsTo: PRIYA.email });
  expect((await team.as(ada, "PATCH", `/api/bots/${reporter.id}`, { approvalMode: "ask" })).status).toBe(200);
  vault = await create(ada, { name: "Vault" });
  payroll = await create(ada, { name: "Payroll", visibility: "everyone" });
  expect((await team.as(ada, "PUT", `/api/bots/${payroll.id}/access`, { everyone: "view", people: {} })).status).toBe(200);
  notes = await create(priya, { name: "Notes" });
  priyaOwn = (await bots(priya)).find((bot) => bot.defaultBot?.person === PRIYA.email)!;
  expect(priyaOwn, "every member has a MausBot of their own").toBeTruthy();
}, hostTimeout(180_000));

afterEach(async () => {
  writeFileSync(file("release"), "");
  writeFileSync(file("tool-calls.json"), "[]");
  rmSync(file("hang-mode"), { force: true });
  await until(idle, 90_000);
}, hostTimeout(120_000));

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await fx?.close();
  await new Promise((resolve) => adminServer?.close(resolve));
});

let channelThread = "", directThread = "";

it("a channel message is its writer's own request in a shared conversation, reported running then completed with the reply", async () => {
  rmSync(file("dump.json"), { force: true });
  const sent = await slack(priyaSlack, { audience: "team", text: "What ships on Friday?", channelName: "sales" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body).toEqual({ accepted: true, conversationId: expect.any(String), bot: { id: scout.id, name: "Scout" }, openUrl: expect.stringMatching(/^https:\/\/[^/]+\/\?thread=[\w-]+&bot=[\w-]+$/) });
  channelThread = sent.body.conversationId;
  expect(channelThread).not.toBe(scout.threadId);
  await finished(sent.id);
  expect(statuses(sent.id)).toEqual(["running", "completed"]);
  expect(lastReport(sent.id)).toEqual({ v: 1, id: sent.id, status: "completed", text: ANSWERS["What ships on Friday?"], conversationId: channelThread, bot: { id: scout.id, name: "Scout" }, openUrl: sent.body.openUrl });

  // Everyone the bot is shared with reads it, on the Team side, named for where it came from.
  for (const token of [priya, tom, ada]) {
    const task = await taskOf(token, scout.id, channelThread);
    expect(task).toMatchObject({ title: "Slack #sales: What ships on Friday?", shared: true });
    expect(task!.private).toBeUndefined();
  }
  // The bot's own shared chat stays the chat it opens to: a Slack thread never takes its place.
  expect(((await bots(tom)).find((bot) => bot.id === scout.id) as Bot & { mainThreadId?: string }).mainThreadId).toBe(scout.threadId);
  const line = (await rows(tom, channelThread)).find((row) => row.role === "user")!;
  expect(line).toMatchObject({ text: "What ships on Friday?", sender: { name: "Priya" } });
  // Her own line with her own authority: never the relayed, information-only kind.
  const prompt = JSON.stringify(dump().prompt);
  expect(prompt).toContain("[From Priya (person) · message · their own request]");
  expect(prompt).not.toContain("relayed");
  expect(prompt).not.toContain("information only");
}, hostTimeout(120_000));

it("the same id again starts nothing new and answers as the first did", async () => {
  const first = await slack(priyaSlack, { audience: "team", text: "Is the report out?" });
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  const again = await slack(priyaSlack, { audience: "team", text: "Is the report out?", id: first.id });
  expect(again.status).toBe(202);
  expect(again.body).toEqual(first.body);
  await finished(first.id);
  const afterwards = await slack(priyaSlack, { audience: "team", text: "Is the report out?", id: first.id });
  expect(afterwards.body).toEqual(first.body);
  await until(idle);
  const thread = await rows(priya, first.body.conversationId);
  expect(thread.filter((row) => row.role === "user")).toHaveLength(1);
  expect(thread.filter((row) => row.role === "bot" && row.kind === "text")).toHaveLength(1);
  expect((await bots(priya)).find((bot) => bot.id === scout.id)!.tasks!.map((task) => task.title).filter((title) => title.startsWith("Slack channel: Is the report out"))).toEqual(["Slack channel: Is the report out?"]);
  expect(statuses(first.id).filter((status) => status === "completed")).toHaveLength(1);
  // Someone else presenting her message's id gets nothing of it.
  expect((await slack(tomSlack, { audience: "team", text: "Is the report out?", id: first.id })).status).toBe(403);
}, hostTimeout(120_000));

it("a thread continues its conversation by id, for whoever writes next, and only with the conversation's own audience", async () => {
  const more = await slack(priyaSlack, { audience: "team", conversationId: channelThread, bot: { id: scout.id }, text: "And the week after?" });
  expect(more.status, JSON.stringify(more.body)).toBe(202);
  expect(more.body.conversationId).toBe(channelThread);
  await finished(more.id);
  expect(lastReport(more.id).text).toBe(ANSWERS["And the week after?"]);
  const toms = await slack(tomSlack, { audience: "team", conversationId: channelThread, text: "Tom here: who is on call?" });
  expect(toms.status, JSON.stringify(toms.body)).toBe(202);
  await finished(toms.id);
  expect((await rows(ada, channelThread)).filter((row) => row.role === "user").map((row) => row.sender?.name)).toEqual(["Priya", "Priya", "Tom"]);

  const gone = { error: "No such conversation.", code: "no_such_conversation" };
  for (const refused of [
    await slack(priyaSlack, { audience: "member", conversationId: channelThread, text: "into my private chat" }),
    await slack(priyaSlack, { audience: "team", conversationId: "t_does_not_exist", text: "nowhere" }),
  ]) {
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(gone);
  }
}, hostTimeout(120_000));

it("a direct message is the member's private chat: only they read it, an admin and another member get 404", async () => {
  const sent = await slack(priyaSlack, { audience: "member", bot: { name: "scout" }, text: "Private notes please" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body.bot).toEqual({ id: scout.id, name: "Scout" });
  directThread = sent.body.conversationId;
  await finished(sent.id);
  expect(lastReport(sent.id).text).toBe(ANSWERS["Private notes please"]);
  expect(await taskOf(priya, scout.id, directThread)).toMatchObject({ title: "Slack DM: Private notes please", private: true });
  expect((await team.as(priya, "GET", `/api/threads/${directThread}/messages?limit=50`)).status).toBe(200);
  for (const token of [tom, ada, ari]) {
    const read = await team.as(token, "GET", `/api/threads/${directThread}/messages?limit=50`);
    expect(read.status, JSON.stringify(read.body)).toBe(404);
    expect(await taskOf(token, scout.id, directThread)).toBeUndefined();
    expect((await team.as(token, "POST", `/api/bots/${scout.id}/messages`, { text: "let me in", threadId: directThread })).status).toBe(404);
  }
  // Neither a channel's message nor anyone else's direct message can be put into it.
  const gone = { error: "No such conversation.", code: "no_such_conversation" };
  for (const refused of [
    await slack(priyaSlack, { audience: "team", conversationId: directThread, text: "from a channel" }),
    await slack(tomSlack, { audience: "member", conversationId: directThread, text: "from Tom" }),
    await slack(adaSlack, { audience: "member", conversationId: directThread, text: "from the owner" }),
  ]) {
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(gone);
  }
  expect((await rows(priya, directThread)).filter((row) => row.role === "user")).toHaveLength(1);
}, hostTimeout(120_000));

it("a final report the Admin did not take is sent again until it does", async () => {
  admin.failFinal = 1;
  const sent = await slack(priyaSlack, { audience: "member", conversationId: directThread, text: "Draft my week" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await finished(sent.id, "completed");
  expect(admin.failFinal).toBe(0);
  expect(statuses(sent.id)).toEqual(["running", "completed"]);
}, hostTimeout(120_000));

it("the bot is the one named, +Name ignoring case, or the member's default; the list is the bots they can chat with", async () => {
  const mine = await team.as(priyaSlack, "GET", "/api/slack/team/bots");
  expect(mine.status).toBe(200);
  const listed = mine.body.bots as { id: string; name: string; shared: boolean; avatarUrl?: string }[];
  const sharedOf = Object.fromEntries(listed.map((bot) => [bot.id, bot.shared]));
  expect([sharedOf[scout.id], sharedOf[reporter.id], sharedOf[notes.id], sharedOf[priyaOwn.id]]).toEqual([true, true, false, false]);
  expect(listed.find((bot) => bot.id === scout.id)).toEqual({ id: scout.id, name: "Scout", shared: true });
  expect(listed.map((bot) => bot.id)).not.toContain(vault.id);
  expect(listed.map((bot) => bot.id)).not.toContain(payroll.id);
  expect(listed.every((bot) => !("avatarUrl" in bot))).toBe(true);
  const owners = (await team.as(adaSlack, "GET", "/api/slack/team/bots")).body.bots as { id: string; name: string; shared: boolean }[];
  expect(owners.find((bot) => bot.id === vault.id)).toEqual({ id: vault.id, name: "Vault", shared: false });
  expect(owners.map((bot) => bot.id)).not.toContain(priyaOwn.id);

  const byDefault = await slack(priyaSlack, { audience: "member", bot: { default: true }, text: "Remind me what I like" });
  expect(byDefault.status, JSON.stringify(byDefault.body)).toBe(202);
  expect(byDefault.body.bot.id).toBe(priyaOwn.id);
  await finished(byDefault.id);
  const named = await slack(priyaSlack, { audience: "member", bot: { name: "NOTES" }, text: "Draft my week" });
  expect(named.status, JSON.stringify(named.body)).toBe(202);
  expect(named.body.bot).toEqual({ id: notes.id, name: "Notes" });
  await finished(named.id);
}, hostTimeout(120_000));

it("a bot private to its owner is refused in a channel; a bot the member can't chat with answers exactly as one that doesn't exist", async () => {
  for (const [token, bot] of [[adaSlack, { id: vault.id }], [priyaSlack, { id: notes.id }], [priyaSlack, { name: "Notes" }], [priyaSlack, { id: priyaOwn.id }]] as const) {
    const refused = await slack(token, { audience: "team", bot, text: "in a channel" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toEqual({ error: "That bot is private to its owner.", code: "bot_private" });
  }
  const missing = await slack(priyaSlack, { audience: "team", bot: { id: "bot_that_never_was" }, text: "hello" });
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: "No such bot.", code: "no_such_bot" });
  for (const audience of ["team", "member"] as const) {
    for (const bot of [{ id: vault.id }, { name: "Vault" }, { id: payroll.id }, { name: "Payroll" }, { name: "Nobody" }]) {
      const refused = await slack(priyaSlack, { audience, bot, text: "hello" });
      expect(refused.status, JSON.stringify(refused.body)).toBe(missing.status);
      expect(refused.body).toEqual(missing.body);
    }
  }
  for (const bot of [vault, payroll]) expect((await bots(ada)).find((one) => one.id === bot.id)!.tasks ?? []).toHaveLength(1);
}, hostTimeout(120_000));

it("a channel's conversation never reads the member's private notes or About you; their direct message does", async () => {
  expect((await team.as(priya, "PUT", "/api/me", { aboutMe: ABOUT })).status).toBe(200);
  const layer = dataFile("workspaces", `${scout.id}--member-${priyaKey}`);
  mkdirSync(join(layer, "memory"), { recursive: true });
  writeFileSync(join(layer, "MEMORY.md"), `# Memory\n\n- Priya's badge code is ${BADGE}\n`);
  const seen = async (ask: Ask) => {
    await until(idle);
    rmSync(file("dump.json"), { force: true });
    const sent = await slack(priyaSlack, ask);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await finished(sent.id);
    await until(() => existsSync(file("dump.json")));
    return JSON.stringify(dump());
  };
  const direct = await seen({ audience: "member", conversationId: directThread, text: "Remind me what I like" });
  expect(direct).toContain(ABOUT);
  expect(direct).toContain(BADGE);
  for (const ask of [{ audience: "team", conversationId: channelThread, text: "What is my badge code?" }, { audience: "team", text: "What is my badge code?" }] as const) {
    const shared = await seen(ask);
    expect(shared).not.toContain(ABOUT);
    expect(shared).not.toContain(BADGE);
    expect(shared).not.toContain(`--member-${priyaKey}`);
  }
}, hostTimeout(180_000));

it("an approval is reported as waiting, sits in the member's inbox and conversation, and is answered only in MausBot", async () => {
  await until(idle);
  writeFileSync(file("hang-mode"), "");
  rmSync(file("release"), { force: true });
  rmSync(file("dump.json"), { force: true });
  const text = `Clean the build ${randomUUID()}`;
  const sent = await slack(priyaSlack, { audience: "team", bot: { id: reporter.id }, text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const thread = sent.body.conversationId as string;
  let socketPath: string | undefined;
  await until(() => {
    try {
      const turn = dump();
      if (JSON.stringify(turn.prompt).includes(text)) socketPath = turn.mcpConfig?.mcpServers?.ogb?.args?.[1];
    } catch { /* not written yet */ }
    return socketPath !== undefined;
  }, 30_000);
  rmSync(file("hang-mode"), { force: true });
  const socket = connect(socketPath!);
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const requestId = randomUUID();
  socket.write(`${JSON.stringify({ t: "ask", id: requestId, tool: "Bash", input: { command: "rm -rf ./build" } })}\n`);

  await until(() => statuses(sent.id).at(-1) === "waiting");
  expect(lastReport(sent.id)).toMatchObject({ status: "waiting", waiting: "approval", conversationId: thread });
  expect((await rows(priya, thread)).some((row) => row.card?.requestId === requestId)).toBe(true);
  const inbox = async () => ((await team.as(priya, "GET", "/api/inbox")).body.rows ?? []) as { card?: { requestId?: string; answered?: string }; tab?: string }[];
  await until(async () => (await inbox()).some((row) => row.card?.requestId === requestId && row.tab === "needs-you"));
  // Slack's only other route, Stop, is not an answer; the card stays open until she answers it in MausBot.
  expect(statuses(sent.id).filter((status) => status === "waiting")).toHaveLength(1);
  const allowed = await team.as(priya, "POST", `/api/threads/${thread}/respond`, { requestId, behavior: "allow" });
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  await until(() => statuses(sent.id).at(-1) === "running");
  writeFileSync(file("release"), "");
  await finished(sent.id);
  expect(statuses(sent.id)).toEqual(["running", "waiting", "running", "completed"]);
}, hostTimeout(180_000));

it("Stop from Slack is the asker's: another member is refused and the run goes on; the asker's stops it and is reported", async () => {
  await until(idle);
  rmSync(file("release"), { force: true });
  writeFileSync(file("tool-calls.json"), JSON.stringify([HOLD]));
  const sent = await slack(priyaSlack, { audience: "team", text: "What ships on Friday?" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const thread = sent.body.conversationId as string;
  await until(async () => (await rows(priya, thread)).some((row) => row.kind === "activity" && JSON.stringify(row.tool ?? {}).includes("gh run watch 42")));
  writeFileSync(file("tool-calls.json"), "[]");

  const toms = await stop(tomSlack, sent.id);
  expect(toms.status, JSON.stringify(toms.body)).toBe(403);
  expect(toms.body).toMatchObject({ code: "stop_not_yours", error: "Only Priya or an admin can stop this." });
  expect((await taskOf(ada, scout.id, thread))?.busy).toBe(true);
  expect(statuses(sent.id)).toEqual(["running"]);
  expect((await stop(priyaSlack, randomUUID())).status).toBe(404);

  const hers = await stop(priyaSlack, sent.id);
  expect(hers.status, JSON.stringify(hers.body)).toBe(200);
  expect(typeof hers.body.stopped).toBe("boolean");
  await finished(sent.id, "stopped");
  await until(async () => !(await taskOf(ada, scout.id, thread))?.busy);
  expect((await rows(tom, thread)).findLast((row) => row.kind === "activity" && row.stoppedBy)?.stoppedBy?.name).toBe("Priya");
  expect((await stop(priyaSlack, sent.id)).body).toEqual({ stopped: true });
}, hostTimeout(180_000));

it("every report is signed in Slack's own context with the bootstrap secret, and nothing else passes for one", async () => {
  expect(admin.refused).toBe(0);
  expect(admin.taken.length).toBeGreaterThan(10);
  for (const { headers, raw } of admin.taken) {
    const [timestamp, nonce, signature] = [headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, headers["x-omb-cloud-signature"]!];
    expect(headers["x-omb-cloud-machine"]).toBe(team.machineId);
    expect(signature).toBe(`v1=${teamSlackSignature(team.secret, team.machineId, timestamp, nonce, raw)}`);
    expect(signature).not.toBe(`v1=${teamRosterSignature(team.secret, team.machineId, timestamp, nonce, raw)}`);
    expect(signature).not.toBe(`v1=${cloudRequestSignature(team.secret, timestamp, nonce, "POST", TEAM_SLACK_REPORT_PATH, raw)}`);
  }
  // The stand-in refuses what the real Admin refuses: another context's signature, and another secret's.
  const base = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}${TEAM_SLACK_REPORT_PATH}`;
  const { raw } = admin.taken[0]!;
  const send = (sign: (timestamp: string, nonce: string) => string) => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(18).toString("base64url");
    return fetch(base, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-omb-cloud-machine": team.machineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${sign(timestamp, nonce)}` } });
  };
  expect((await send((timestamp, nonce) => teamRosterSignature(team.secret, team.machineId, timestamp, nonce, raw))).status).toBe(401);
  expect((await send((timestamp, nonce) => teamSlackSignature(randomBytes(32).toString("base64url"), team.machineId, timestamp, nonce, raw))).status).toBe(401);
  expect((await send((timestamp, nonce) => teamSlackSignature(team.secret, team.machineId, timestamp, nonce, raw))).status).toBe(200);
  // What this Cloud keeps of Slack's messages is ids and state, never their words.
  const kept = readFileSync(dataFile(TEAM_SLACK_FILE), "utf8");
  for (const words of [...Object.keys(ANSWERS), ...Object.values(ANSWERS), "C0SALES", "U0PRIYA", PRIYA.email]) expect(kept).not.toContain(words);
}, hostTimeout(60_000));

it("when a member leaves, their direct-message conversations go with their private chats; the channel's stay", async () => {
  await until(idle);
  const before = JSON.parse(readFileSync(dataFile(TEAM_SLACK_FILE), "utf8")) as { messages: { person: string; threadId: string }[] };
  expect(before.messages.some((message) => message.person === priyaKey && message.threadId === directThread)).toBe(true);
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: PRIYA.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(left.body.chats).toBeGreaterThanOrEqual(2);
  expect((await team.as(priyaSlack, "GET", "/api/slack/team/bots")).status).toBe(401);
  const after = JSON.parse(readFileSync(dataFile(TEAM_SLACK_FILE), "utf8")) as { messages: { person: string }[] };
  expect(after.messages.filter((message) => message.person === priyaKey)).toEqual([]);
  // Joining again restores nothing: the direct message's conversation is gone for her too.
  const back = (await team.pair(PRIYA, { label: SLACK_LABEL })).token!;
  expect((await team.as(back, "GET", `/api/threads/${directThread}/messages?limit=50`)).status).toBe(404);
  expect((await slack(back, { audience: "member", conversationId: directThread, text: "still there?" })).body.code).toBe("no_such_conversation");
  expect(existsSync(dataFile("workspaces", `${scout.id}--member-${priyaKey}`))).toBe(false);
  expect((await rows(tom, channelThread)).filter((row) => row.role === "user").length).toBeGreaterThanOrEqual(3);
}, hostTimeout(120_000));

it("off a Team Cloud every route answers 404", async () => {
  for (const ask of [fx.onCloud, fx.local]) {
    for (const [method, path, body] of [["GET", "/api/slack/team/bots", undefined], ["POST", "/api/slack/team/messages", { v: 1, id: randomUUID(), audience: "team", bot: { default: true }, conversationId: null, text: "hello" }],
      ["POST", `/api/slack/team/messages/${randomUUID()}/stop`, { v: 1 }]] as const) {
      const answer = await ask(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.body.code).toBeUndefined();
    }
  }
}, hostTimeout(60_000));
