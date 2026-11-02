// Who a Team Cloud bot reports to, end to end: Acme's Owner (Olive), an Admin (Ada) and a User (Bob), the synthetic
// Claude CLI asking real question and approval cards through the permission socket, and each person's Needs you,
// notifications, Chief of Staff and inbox. It proves the routing and the audience rule, not a model's judgement.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
// Every turn waits for the release file: present, it answers at once; removed, the turn holds while a card is asked.
// The files live in the fixture folder, not the engine's HOME: on a team each audience's engine gets a home of its own.
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TEXT_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/text-dump.json";
process.env.FAKE_CLAUDE_MODE = "hang";
process.env.FAKE_CLAUDE_RELEASE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/release";`;

type Bot = { id: string; name: string; threadId: string; createdBy?: string; reportsTo?: string; chiefOfStaff?: boolean; busy?: boolean };
type Frame = { kind: string; notification?: { kind: string; botId: string; threadId: string; title: string; body: string; forPerson?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture, broker: BrokerFake;
let olive = "", ada = "", bob = "";
let fox: Bot, owl: Bot, lead: Bot;
const sockets: Socket[] = [];
const streams: AbortController[] = [];

const release = () => join(team.home, "release");
const hold = () => rmSync(release(), { force: true });
const letGo = () => writeFileSync(release(), "");

beforeAll(async () => {
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  letGo();
  olive = (await team.pair(OLIVE)).token!;
  ada = (await team.pair(ADA)).token!;
  bob = (await team.pair(BOB)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const stream of streams) stream.abort();
  await fx?.close();
  await broker?.close();
});

const create = async (token: string, body: Record<string, unknown>) => {
  const created = await team.as(token, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const botNamed = async (name: string) => (await bots(olive)).find((one) => one.name === name)!;
const needsYou = async (token: string) => ((await team.as(token, "GET", "/api/needs-you")).body.items as Array<{ kind: string; botId: string; threadId: string; text: string }>);
const asked = async (token: string) => (await needsYou(token)).map((item) => item.text).sort();
const messages = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ id: string; kind: string; card?: Record<string, unknown>; widget?: unknown }>;
const busy = async (botId: string) => Boolean((await bots(olive)).find((one) => one.id === botId)?.busy);

/** One person's live stream, collecting every frame it is sent. */
function listen(token: string): Frame[] {
  const frames: Frame[] = [];
  const abort = new AbortController();
  streams.push(abort);
  void (async () => {
    const response = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}` }, signal: abort.signal });
    const reader = response.body!.getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += new TextDecoder().decode(value);
      const parts = buffered.split("\n\n");
      buffered = parts.pop()!;
      for (const part of parts) {
        const data = part.split("\n").find((line) => line.startsWith("data: "));
        if (data) try { frames.push(JSON.parse(data.slice(6)) as Frame); } catch { /* a heartbeat */ }
      }
    }
  })().catch(() => {});
  return frames;
}
/** The notifications about `bot`'s asks: each reaches its person from their inbox, titled with the bot that asked. */
const notified = (frames: Frame[], kind: string, bot: Bot) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === kind && frame.notification.title.startsWith(bot.name));

/** As `token`, a message holds `bot`'s turn in `threadId` while the bot asks a card through its permission socket. */
async function askedBy(token: string, bot: Bot, threadId: string, card: { question: string } | { tool: string; command: string }) {
  hold();
  rmSync(join(team.home, "dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text: "Please look into it", threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => busy(bot.id), { timeout: 20_000 }).toBe(true);
  const socketPath = await expect.poll(() => {
    try { return JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")).mcpConfig?.mcpServers?.ogb?.args?.[1] as string | undefined; } catch { return undefined; }
  }, { timeout: 10_000 }).toEqual(expect.any(String)).then(() => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")).mcpConfig.mcpServers.ogb.args[1] as string);
  const socket = connect(socketPath);
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const requestId = randomUUID();
  socket.write(`${JSON.stringify("question" in card
    ? { t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion", input: { questions: [{ question: card.question, options: [{ label: "Yes" }, { label: "No" }] }] } }
    : { t: "ask", id: requestId, tool: card.tool, input: { command: card.command } })}\n`);
  await expect.poll(async () => (await messages(olive, threadId)).some((row) => row.card?.requestId === requestId), { timeout: 10_000 }).toBe(true);
  return requestId;
}
async function settle(bot: Bot) {
  letGo();
  await expect.poll(() => busy(bot.id), { timeout: 20_000 }).toBe(false);
}

it("records who created each team bot, offers everyone who opened the team, and lets an Admin set a department's owner", async () => {
  fox = await create(ada, { name: "Fox", section: "Product A" });
  owl = await create(ada, { name: "Owl", section: "Product A" });
  lead = await create(olive, { name: "Tech Lead", section: "Product A", reportsTo: ADA.email });
  expect(fox).toMatchObject({ createdBy: ADA.email });
  expect(fox.reportsTo).toBeUndefined();
  expect(lead).toMatchObject({ createdBy: OLIVE.email, reportsTo: ADA.email });

  const people = (await team.as(bob, "GET", "/api/team/people")).body.people;
  expect(people).toEqual(expect.arrayContaining([
    { email: OLIVE.email, name: "Olive", role: "owner" }, { email: ADA.email, name: "Ada", role: "admin" }, { email: BOB.email, name: "Bob", role: "member", you: true },
  ]));
  expect((await team.as(olive, "POST", "/api/bots", { name: "Nobody's", reportsTo: "stranger@elsewhere.test" })).status).toBe(400);

  // "Set owner for all bots…" on Product A, except Tech Lead, which keeps reporting to Ada.
  expect((await team.as(bob, "PUT", "/api/team/reports-to", { botIds: [fox.id, owl.id], email: BOB.email })).status).toBe(403);
  expect((await team.as(ada, "PUT", "/api/team/reports-to", { botIds: [fox.id, owl.id], email: "stranger@elsewhere.test" })).status).toBe(400);
  const set = await team.as(ada, "PUT", "/api/team/reports-to", { botIds: [fox.id, owl.id], email: BOB.email });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect((await botNamed("Fox")).reportsTo).toBe(BOB.email);
  expect((await botNamed("Owl")).reportsTo).toBe(BOB.email);
  expect((await botNamed("Tech Lead")).reportsTo).toBe(ADA.email);
}, hostTimeout(60_000));

it("puts a question in a shared chat in its owner's Needs you and notifications, nobody else's", async () => {
  const [olives, adas, bobs] = [listen(olive), listen(ada), listen(bob)];
  await new Promise((resolve) => setTimeout(resolve, 500));
  await askedBy(olive, fox, fox.threadId, { question: "Which landing page should I rewrite?" });
  await expect.poll(() => asked(bob), { timeout: 10_000 }).toEqual(["Which landing page should I rewrite?"]);
  expect(await asked(ada)).toEqual([]);
  expect(await asked(olive)).toEqual([]);
  await expect.poll(() => notified(bobs, "question", fox).length, { timeout: 10_000 }).toBe(1);
  expect(notified(adas, "question", fox)).toEqual([]);
  expect(notified(olives, "question", fox)).toEqual([]);
  // It reaches Bob from his inbox, and the Admins' notification feed holds it for nobody but Bob.
  expect(notified(bobs, "question", fox)[0]!.notification).toMatchObject({ forPerson: personKey({ id: "", email: BOB.email }) });
  expect(notified(bobs, "question", fox)[0]!.notification!.threadId).not.toBe(fox.threadId);
  for (const token of [olive, ada]) {
    const feed = (await team.as(token, "GET", "/api/notifications")).body.notifications as Array<{ kind: string; title: string }>;
    expect(feed.filter((entry) => entry.kind === "question" && entry.title.startsWith("Fox"))).toEqual([]);
  }
  // The card itself stays in the shared chat, for everyone who sees it.
  expect((await messages(ada, fox.threadId)).some((row) => row.kind === "options")).toBe(true);
  await settle(fox);
  expect(await asked(bob)).toEqual(["Which landing page should I rewrite?"]);
}, hostTimeout(90_000));

it("follows a bot's own Reports to over its department's, and routes an approval the same way", async () => {
  await askedBy(bob, lead, lead.threadId, { question: "Can I merge the auth refactor?" });
  await expect.poll(() => asked(ada), { timeout: 10_000 }).toEqual(["Can I merge the auth refactor?"]);
  expect(await asked(bob)).toEqual(["Which landing page should I rewrite?"]);
  await settle(lead);

  expect((await team.as(ada, "PATCH", `/api/bots/${owl.id}`, { approvalMode: "ask" })).status).toBe(200);
  await askedBy(olive, owl, owl.threadId, { tool: "Bash", command: "rm -rf ./build" });
  await expect.poll(async () => (await needsYou(bob)).some((item) => item.botId === owl.id && item.text.startsWith("Approve:")), { timeout: 10_000 }).toBe(true);
  expect((await needsYou(ada)).some((item) => item.botId === owl.id)).toBe(false);
  await settle(owl);
}, hostTimeout(90_000));

it("lets the member who owns a bot hand it over, and nobody else but an Admin", async () => {
  expect((await team.as(bob, "PUT", `/api/bots/${lead.id}/reports-to`, { email: BOB.email })).status).toBe(403);
  const handed = await team.as(bob, "PUT", `/api/bots/${fox.id}/reports-to`, { email: ADA.email });
  expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  expect(handed.body.bot.reportsTo).toBe(ADA.email);
  // Its open question moves with it.
  expect(await asked(ada)).toContain("Which landing page should I rewrite?");
  expect(await asked(bob)).not.toContain("Which landing page should I rewrite?");
  expect((await team.as(ada, "PUT", `/api/bots/${fox.id}/reports-to`, { email: BOB.email })).status).toBe(200);
  expect(await asked(bob)).toContain("Which landing page should I rewrite?");
}, hostTimeout(30_000));

it("makes each person's MausBot their Chief, crowns no other bot someone owns, and keeps the department's own Chief", async () => {
  const ownOf = async (token: string, email: string) => (await bots(token)).find((one) => (one as { defaultBot?: { person?: string } }).defaultBot?.person === email)!;
  for (const [token, email] of [[ada, ADA.email], [bob, BOB.email]] as const) expect((await ownOf(token, email)).chiefOfStaff).toBe(true);
  const second = await create(ada, { name: "Ada's Chief", reportsTo: ADA.email });
  const refused = await team.as(ada, "PATCH", `/api/bots/${second.id}`, { chiefOfStaff: true });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("Ada's Chief can't be made a Chief of Staff on a team: each person's own MausBot already looks after their bots and holds their inbox.");
  const made = await team.as(ada, "POST", "/api/bots", { name: "Also a Chief?", reportsTo: ADA.email, settings: { chiefOfStaff: true } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body.bot.chiefOfStaff).toBeFalsy();
  const department = (await bots(olive)).find((one) => one.chiefOfStaff && !one.reportsTo && !one.createdBy && !(one as { defaultBot?: unknown }).defaultBot)!;
  expect(department).toBeTruthy();
  // Bob's MausBot is his Chief, so a Chief handed to him would be his second.
  const handed = await team.as(ada, "PUT", `/api/bots/${department.id}/reports-to`, { email: BOB.email });
  expect(handed.status).toBe(409);
  expect(handed.body.error).toContain("Bob already has a Chief of Staff");
}, hostTimeout(90_000));

it("keeps a member's private chat theirs: its asks reach only them, never the bot's owner, an Admin, or the owner's inbox", async () => {
  const bobs = listen(bob);
  const created = await team.as(olive, "POST", `/api/bots/${fox.id}/tasks`, { title: "Olive and Fox" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const private_ = created.body.task.threadId as string;
  await askedBy(olive, fox, private_, { question: "Should I tell the board about my resignation?" });
  await expect.poll(() => asked(olive), { timeout: 10_000 }).toEqual(["Should I tell the board about my resignation?"]);
  expect(await asked(bob)).not.toContain("Should I tell the board about my resignation?");
  expect(await asked(ada)).not.toContain("Should I tell the board about my resignation?");
  await settle(fox);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(notified(bobs, "question", fox)).toEqual([]);

  // Bob opens the app: his inbox, a private chat with the bot of his own, holds Fox's shared question and never Olive's.
  const arrived = await team.as(bob, "POST", "/api/presence/active", { source: "desktop" });
  expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
  const inbox = JSON.stringify(await messages(bob, arrived.body.open.threadId));
  expect(inbox).toContain("Which landing page should I rewrite?");
  expect(inbox).not.toContain("resignation");
  const tasks = (await bots(bob)).find((one) => one.id === arrived.body.open.botId) as unknown as { tasks: Array<{ threadId: string; private?: boolean }> };
  expect(tasks.tasks.find((task) => task.threadId === arrived.body.open.threadId)?.private).toBe(true);
  // Ada's own inbox holds Tech Lead's question, not Fox's.
  const adaArrived = await team.as(ada, "POST", "/api/presence/active", { source: "desktop" });
  const adas = JSON.stringify(await messages(ada, adaArrived.body.open.threadId));
  expect(adas).toContain("Can I merge the auth refactor?");
  expect(adas).not.toContain("Which landing page");
  expect(adas).not.toContain("resignation");
}, hostTimeout(90_000));

it("routes nothing on a server that is not a team", async () => {
  expect((await fx.onCloud("GET", "/api/team/people")).status).toBe(400);
  const mine = (await fx.onCloud("POST", "/api/bots", { name: "Mine" })).body.bot as Bot;
  expect(mine.createdBy).toBeUndefined();
  expect((await fx.onCloud("PUT", `/api/bots/${mine.id}/reports-to`, { email: ADA.email })).status).toBe(400);
  expect((await fx.onCloud("POST", "/api/bots", { name: "Solo", reportsTo: ADA.email })).status).toBe(400);
  expect((await fx.onCloud("GET", "/api/needs-you")).status).toBe(200);
}, hostTimeout(30_000));
