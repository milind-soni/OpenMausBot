// Slack on a personal Cloud (docs/team-slack.md): a My Cloud, with no team. The Admin's part is played here: a session
// opened for the owner through the signed pairing (label "Slack (MausBot Cloud)"), the three routes called with it,
// and a stand-in Admin that takes the Cloud's signed reports and checks them as the real one does. A channel message
// and a direct message each become an ordinary conversation of the owner's. Disposable homes and the synthetic Claude
// CLI; no Slack and no real Admin are reached.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { cloudRequestSignature } from "./cloud-home.ts";
import { teamRosterSignature } from "./cloud-team-roster.ts";
import { TEAM_SLACK_FILE, TEAM_SLACK_REPORT_PATH, teamSlackSignature } from "./team-slack.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const SLACK_LABEL = "Slack (MausBot Cloud)";
const ENGINE = `const { existsSync } = process.getBuiltinModule("node:fs");
const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_DUMP = dir + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = dir + "/tool-calls.json";
process.env.FAKE_CLAUDE_RELEASE = dir + "/release";
process.env.FAKE_CLAUDE_MARKER_REPLIES = dir + "/markers.json";`;
const HOLD = { name: "Bash", input: { command: "gh run watch 42" }, hold: true };
/** A turn's prompt can carry earlier lines of its conversation, and the engine answers the first marker it finds: later asks first. */
const ANSWERS: Record<string, string> = {
  "And the week after?": "The week after is **quiet**.",
  "Then the invoices?": "The invoices follow.",
  "What ships on Friday?": "The **invoice run** ships on Friday.",
  "Private notes please": "Noted privately.",
  "Is the report out?": "The report is out.",
  "Watch the build": "The build is green.",
};

type Report = { id: string; status: string; text?: string; conversationId?: string; bot?: { id: string; name: string }; openUrl?: string };
type Task = { threadId: string; title: string; private?: boolean; shared?: boolean; busy?: boolean };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; busy?: boolean; defaultBot?: { person?: string }; tasks?: Task[] };
type Row = { id: string; role: string; kind: string; text?: string; relayed?: boolean; tool?: { name: string }; stoppedBy?: { name: string } };

const admin = {
  /** Every request to the report path, as the real Admin would judge it. */
  taken: [] as { report: Report; headers: Record<string, string>; raw: string }[],
  refused: 0,
  /** Message ids this Cloud's Admin handed over; any other id is not this Cloud's. */
  known: new Set<string>(),
};
let adminServer: Server, fx: CloudSendFixture;
let owner = "", ownerSlack = "";
let scout: Bot, mausbot: Bot;

const file = (name: string) => join(fx.root, "cloud", name);
const dataFile = (name: string) => join(fx.root, "cloud", ".openmausbot", name);
async function as(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fx.cloudBase}${path}`, { method, headers: { ...fx.edge, ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: null }; }
}
const bots = async () => (await as(owner, "GET", "/api/bots?messages=0")).body.bots as Bot[];
const botOf = async (botId: string) => (await bots()).find((bot) => bot.id === botId)!;
const taskOf = async (botId: string, threadId: string) => (await botOf(botId)).tasks?.find((task) => task.threadId === threadId);
const rows = async (threadId: string) => ((await as(owner, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Row[];
const idle = async () => (await bots()).every((bot) => !bot.busy && !(bot.tasks ?? []).some((task) => task.busy));
const statuses = (id: string) => admin.taken.filter((entry) => entry.report.id === id).map((entry) => entry.report.status);
const lastReport = (id: string) => admin.taken.findLast((entry) => entry.report.id === id)!.report;
const until = (done: () => Promise<boolean> | boolean, timeout = 60_000) => expect.poll(done, { timeout: hostTimeout(timeout), interval: 100 }).toBe(true);
const finished = (id: string, status = "completed") => until(() => statuses(id).at(-1) === status);

type Ask = { audience: "team" | "member"; bot?: { id: string } | { name: string } | { default: true }; conversationId?: string | null; text: string; id?: string; channelName?: string };
/** One Slack message as the Admin delivers it, with the session it opened for the owner. */
async function slack(token: string | null, ask: Ask) {
  const id = ask.id ?? randomUUID();
  admin.known.add(id);
  const direct = ask.audience === "member";
  const answer = await as(token, "POST", "/api/slack/team/messages", { v: 1, id, audience: ask.audience, bot: ask.bot ?? { id: scout.id }, conversationId: ask.conversationId ?? null, text: ask.text,
    slack: { workspace: "T0HOME", channel: direct ? "D0OWNER" : "C0SALES", threadTs: "1731662000.000100", messageTs: "1731662000.000100", user: "U0OWNER", ...(ask.channelName ? { channelName: ask.channelName } : {}) } });
  return { id, ...answer };
}
const stop = (token: string | null, id: string) => as(token, "POST", `/api/slack/team/messages/${id}/stop`, { v: 1 });
const dump = () => JSON.parse(readFileSync(file("dump.json"), "utf8")) as { prompt?: unknown };

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
      const expected = Buffer.from(teamSlackSignature(fx.secret, machine, timestamp, nonce, raw), "base64url"), given = Buffer.from(presented ?? "", "base64url");
      if (machine !== fx.cloudMachineId || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        admin.refused++;
        return answer(401, { error: "That request isn't signed by a Cloud." });
      }
      const report = JSON.parse(raw) as Report & { v: number };
      if (!admin.known.has(report.id)) return answer(404, { error: "There is no such message.", code: "unknown_message" });
      const over = admin.taken.some((entry) => entry.report.id === report.id && ["completed", "failed", "stopped"].includes(entry.report.status));
      admin.taken.push({ report, headers, raw });
      answer(200, over ? { ok: true, done: true } : { ok: true });
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-slack-${randomBytes(8).toString("hex")}`, cloudEngine: ENGINE,
    cloudEnv: { OMB_BOT_BOX: "0", FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}` } });
  writeFileSync(file("markers.json"), JSON.stringify(ANSWERS));
  writeFileSync(file("tool-calls.json"), "[]");
  writeFileSync(file("release"), "");
  owner = fx.owner;
  // The Admin's session for Slack: the same signed pairing as the owner's app, with no member's claim.
  const paired = await as(null, "POST", "/api/auth/pair", { code: (await fx.grant(SLACK_LABEL)).code });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  ownerSlack = paired.body.token;
  const created = await as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot as Bot;
  mausbot = (await bots()).find((bot) => bot.defaultBot)!;
  expect(mausbot, "a My Cloud has its MausBot").toBeTruthy();
}, hostTimeout(180_000));

afterEach(async () => {
  writeFileSync(file("release"), "");
  writeFileSync(file("tool-calls.json"), "[]");
  await until(idle, 90_000);
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await new Promise((resolve) => adminServer?.close(resolve));
});

let channelThread = "", directThread = "";

it("the owner's session lists every bot, each usable in a channel; no session is refused", async () => {
  const mine = await as(ownerSlack, "GET", "/api/slack/team/bots");
  expect(mine.status, JSON.stringify(mine.body)).toBe(200);
  const listed = mine.body.bots as { id: string; name: string; shared: boolean }[];
  expect(listed.find((bot) => bot.id === scout.id)).toEqual({ id: scout.id, name: "Scout", shared: true });
  expect(listed.find((bot) => bot.id === mausbot.id)).toEqual({ id: mausbot.id, name: mausbot.name, shared: true });
  for (const refused of [await as(null, "GET", "/api/slack/team/bots"), await slack(null, { audience: "team", text: "hello" })]) {
    expect(refused.status).toBe(403);
    expect(refused.body.bots ?? refused.body.accepted).toBeUndefined();
  }
});

it("a channel message is the owner's own request in an ordinary conversation, reported running then completed with the reply", async () => {
  rmSync(file("dump.json"), { force: true });
  const sent = await slack(ownerSlack, { audience: "team", text: "What ships on Friday?", channelName: "sales" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body).toEqual({ accepted: true, conversationId: expect.any(String), bot: { id: scout.id, name: "Scout" }, openUrl: expect.stringMatching(/^https:\/\/[^/]+\/\?thread=[\w-]+&bot=[\w-]+$/) });
  channelThread = sent.body.conversationId;
  expect(channelThread).not.toBe(scout.threadId);
  await finished(sent.id);
  expect(statuses(sent.id)).toEqual(["running", "completed"]);
  expect(lastReport(sent.id)).toEqual({ v: 1, id: sent.id, status: "completed", text: ANSWERS["What ships on Friday?"], conversationId: channelThread, bot: { id: scout.id, name: "Scout" }, openUrl: sent.body.openUrl });

  // The owner's app is sent it as any conversation of theirs, named for where it came from; nothing is shared.
  const task = await taskOf(scout.id, channelThread);
  expect(task).toMatchObject({ title: "Slack #sales: What ships on Friday?" });
  expect(task!.shared).toBeUndefined();
  // The chat the bot opens to stays that chat: a Slack channel's conversation never takes its place.
  expect((await botOf(scout.id)).mainThreadId).toBe(scout.threadId);
  const thread = await rows(channelThread);
  const line = thread.find((row) => row.role === "user")!;
  expect(line).toMatchObject({ text: "What ships on Friday?" });
  expect(line.relayed).toBeUndefined();
  expect(thread.filter((row) => row.role === "bot" && row.kind === "text").map((row) => row.text)).toEqual([ANSWERS["What ships on Friday?"]]);
  // The owner's own line with their own authority: never the relayed, information-only kind.
  const prompt = JSON.stringify(dump().prompt);
  expect(prompt).toContain("What ships on Friday?");
  expect(prompt).not.toContain("relayed");
  expect(prompt).not.toContain("information only");
}, hostTimeout(120_000));

it("the same id again starts nothing new and answers as the first did", async () => {
  const first = await slack(ownerSlack, { audience: "team", text: "Is the report out?" });
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  const again = await slack(ownerSlack, { audience: "team", text: "Is the report out?", id: first.id });
  expect(again.status).toBe(202);
  expect(again.body).toEqual(first.body);
  await finished(first.id);
  // The owner's app session is the same person: the Admin may open a new session for each message.
  const afterwards = await slack(owner, { audience: "team", text: "Is the report out?", id: first.id });
  expect(afterwards.body).toEqual(first.body);
  await until(idle);
  const thread = await rows(first.body.conversationId);
  expect(thread.filter((row) => row.role === "user")).toHaveLength(1);
  expect(thread.filter((row) => row.role === "bot" && row.kind === "text")).toHaveLength(1);
  expect((await botOf(scout.id)).tasks!.map((task) => task.title).filter((title) => title.startsWith("Slack channel: Is the report out"))).toEqual(["Slack channel: Is the report out?"]);
  expect(statuses(first.id).filter((status) => status === "completed")).toHaveLength(1);
}, hostTimeout(120_000));

it("a direct message is an ordinary conversation too, with the owner's MausBot by default; either audience continues a conversation", async () => {
  const sent = await slack(ownerSlack, { audience: "member", bot: { default: true }, text: "Private notes please" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body.bot).toEqual({ id: mausbot.id, name: mausbot.name });
  directThread = sent.body.conversationId;
  await finished(sent.id);
  expect(lastReport(sent.id).text).toBe(ANSWERS["Private notes please"]);
  expect(await taskOf(mausbot.id, directThread)).toMatchObject({ title: "Slack DM: Private notes please" });
  expect((await rows(directThread)).find((row) => row.role === "user")).toMatchObject({ text: "Private notes please" });

  const named = await slack(ownerSlack, { audience: "member", bot: { name: "SCOUT" }, conversationId: null, text: "Is the report out?" });
  expect(named.status, JSON.stringify(named.body)).toBe(202);
  expect(named.body.bot).toEqual({ id: scout.id, name: "Scout" });
  await finished(named.id);
  // A direct message's conversation is as any the owner opens: the one they last wrote in is the chat the bot opens to.
  expect((await botOf(scout.id)).mainThreadId).toBe(named.body.conversationId);

  // There is one person and no audience to tell apart: a thread continues by its id whichever audience is named.
  const more = await slack(ownerSlack, { audience: "team", conversationId: channelThread, text: "And the week after?" });
  expect(more.status, JSON.stringify(more.body)).toBe(202);
  expect(more.body.conversationId).toBe(channelThread);
  await finished(more.id);
  expect(lastReport(more.id).text).toBe(ANSWERS["And the week after?"]);
  const crossed = await slack(ownerSlack, { audience: "member", conversationId: channelThread, text: "Then the invoices?" });
  expect(crossed.status, JSON.stringify(crossed.body)).toBe(202);
  expect(crossed.body.conversationId).toBe(channelThread);
  await finished(crossed.id);
  expect((await rows(channelThread)).filter((row) => row.role === "user").map((row) => row.text)).toEqual(["What ships on Friday?", "And the week after?", "Then the invoices?"]);

  const gone = await slack(ownerSlack, { audience: "team", conversationId: "t_does_not_exist", text: "nowhere" });
  expect(gone.status).toBe(409);
  expect(gone.body).toEqual({ error: "No such conversation.", code: "no_such_conversation" });
  const missing = await slack(ownerSlack, { audience: "team", bot: { id: "bot_that_never_was" }, text: "hello" });
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: "No such bot.", code: "no_such_bot" });
  // The channel's conversation, though written in last, is still not that chat.
  expect((await botOf(scout.id)).mainThreadId).toBe(named.body.conversationId);
}, hostTimeout(180_000));

it("a line written while the bot works waits in the queue and runs after, as its own turn", async () => {
  await until(idle);
  rmSync(file("release"), { force: true });
  writeFileSync(file("tool-calls.json"), JSON.stringify([HOLD]));
  const first = await slack(ownerSlack, { audience: "team", text: "Watch the build" });
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  const thread = first.body.conversationId as string;
  await until(async () => (await rows(thread)).some((row) => row.kind === "activity" && JSON.stringify(row.tool ?? {}).includes("gh run watch 42")));
  writeFileSync(file("tool-calls.json"), "[]");
  const second = await slack(ownerSlack, { audience: "team", conversationId: thread, text: "Is the report out?" });
  expect(second.status, JSON.stringify(second.body)).toBe(202);
  expect(second.body.conversationId).toBe(thread);
  expect((await rows(thread)).filter((row) => row.role === "user")).toHaveLength(1);
  expect(statuses(first.id)).toEqual(["running"]);
  writeFileSync(file("release"), "");
  await finished(first.id);
  await finished(second.id);
  expect(lastReport(first.id).text).toBe(ANSWERS["Watch the build"]);
  expect(lastReport(second.id).text).toBe(ANSWERS["Is the report out?"]);
  expect((await rows(thread)).filter((row) => row.role === "user").map((row) => row.text)).toEqual(["Watch the build", "Is the report out?"]);
}, hostTimeout(180_000));

it("Stop from Slack ends the owner's run and is reported; an id never taken is 404", async () => {
  await until(idle);
  rmSync(file("release"), { force: true });
  writeFileSync(file("tool-calls.json"), JSON.stringify([HOLD]));
  const sent = await slack(ownerSlack, { audience: "member", text: "What ships on Friday?" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const thread = sent.body.conversationId as string;
  await until(async () => (await rows(thread)).some((row) => row.kind === "activity" && JSON.stringify(row.tool ?? {}).includes("gh run watch 42")));
  writeFileSync(file("tool-calls.json"), "[]");
  expect((await taskOf(scout.id, thread))?.busy).toBe(true);
  expect((await stop(ownerSlack, randomUUID())).status).toBe(404);
  expect((await stop(null, sent.id)).status).toBe(403);
  expect(statuses(sent.id)).toEqual(["running"]);

  const stopped = await stop(ownerSlack, sent.id);
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(typeof stopped.body.stopped).toBe("boolean");
  await finished(sent.id, "stopped");
  await until(async () => !(await taskOf(scout.id, thread))?.busy);
  expect((await rows(thread)).filter((row) => row.role === "bot" && row.kind === "text")).toEqual([]);
  expect((await stop(ownerSlack, sent.id)).body).toEqual({ stopped: true });
}, hostTimeout(180_000));

it("every report is signed in Slack's own context with the bootstrap secret, and what is kept holds no words", async () => {
  expect(admin.refused).toBe(0);
  expect(admin.taken.length).toBeGreaterThan(10);
  for (const { headers, raw } of admin.taken) {
    const [timestamp, nonce, signature] = [headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, headers["x-omb-cloud-signature"]!];
    expect(headers["x-omb-cloud-machine"]).toBe(fx.cloudMachineId);
    expect(signature).toBe(`v1=${teamSlackSignature(fx.secret, fx.cloudMachineId, timestamp, nonce, raw)}`);
    expect(signature).not.toBe(`v1=${teamRosterSignature(fx.secret, fx.cloudMachineId, timestamp, nonce, raw)}`);
    expect(signature).not.toBe(`v1=${cloudRequestSignature(fx.secret, timestamp, nonce, "POST", TEAM_SLACK_REPORT_PATH, raw)}`);
  }
  const base = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}${TEAM_SLACK_REPORT_PATH}`;
  const { raw } = admin.taken[0]!;
  const send = (sign: (timestamp: string, nonce: string) => string) => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(18).toString("base64url");
    return fetch(base, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-omb-cloud-machine": fx.cloudMachineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${sign(timestamp, nonce)}` } });
  };
  expect((await send((timestamp, nonce) => teamSlackSignature(randomBytes(32).toString("base64url"), fx.cloudMachineId, timestamp, nonce, raw))).status).toBe(401);
  expect((await send((timestamp, nonce) => teamSlackSignature(fx.secret, fx.cloudMachineId, timestamp, nonce, raw))).status).toBe(200);
  const kept = readFileSync(dataFile(TEAM_SLACK_FILE), "utf8");
  for (const words of [...Object.keys(ANSWERS), ...Object.values(ANSWERS), "C0SALES", "U0OWNER", "sales"]) expect(kept).not.toContain(words);
  // Which conversations a channel opened is kept there, by id: the conversation a direct message opened is not among them.
  const channels = (JSON.parse(kept) as { channels?: string[] }).channels ?? [];
  expect(channels).toContain(channelThread);
  expect(channels).not.toContain(directThread);
  // Nothing was shared: sharing is a Team Cloud's.
  expect(() => readFileSync(dataFile("conversation-shares.json"), "utf8")).toThrow();
}, hostTimeout(60_000));

it("an install that is no Cloud answers 404 on every route", async () => {
  for (const [method, path, body] of [["GET", "/api/slack/team/bots", undefined], ["POST", "/api/slack/team/messages", { v: 1, id: randomUUID(), audience: "team", bot: { default: true }, conversationId: null, text: "hello" }],
    ["POST", `/api/slack/team/messages/${randomUUID()}/stop`, { v: 1 }]] as const) {
    const answer = await fx.local(method, path, body);
    expect(answer.status, `${method} ${path}`).toBe(404);
    expect(answer.body.code).toBeUndefined();
  }
}, hostTimeout(60_000));
