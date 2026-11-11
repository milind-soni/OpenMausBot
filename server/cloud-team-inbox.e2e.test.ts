// Each person's inbox on a Team Cloud, end to end (docs/team-cloud.md "One inbox per person"): Acme's Owner Cleo and
// a member Ben, the synthetic Claude CLI calling message_person through the real agents MCP server, real approval
// cards through the permission socket, and Ben's own Google Calendar on the fake connected-apps service. A bot's "tell
// Ben", an @Ben and an approval routed to Ben land in his inbox, his chat with his Chief, with one notification
// each; his answer reaches the bot that asked, which carries on; his assistant answers when he is free, labelled, and
// leaves decisions and his private chats alone. The asks waiting on him are counted on his inbox, live, and each stops
// waiting however he answers it: in the bot's own chat, through either respond route, or with a 👍. It proves where
// things land and what is read, not a model's judgement.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CLEO = { email: "cleo@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const BEN_KEY = personKey({ id: "", email: BEN.email });
const SECRET = "interviewing at Globex";
// Each turn reads its scripted calls again; a conversation's engine stays warm across turns. One started while the
// hang-mode file exists holds each turn until the release file exists, so a card can be asked through its socket.
const ENGINE = `const { existsSync } = process.getBuiltinModule("node:fs");
const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_DUMP = dir + "/dump.json";
process.env.FAKE_CLAUDE_TEXT_DUMP = dir + "/text-dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = dir + "/tool-calls.json";
process.env.FAKE_CLAUDE_REPLY_FILE = dir + "/reply.txt";
process.env.FAKE_CLAUDE_TEXT_ROUTES = dir + "/text-routes.json";
process.env.FAKE_CLAUDE_TEXT_LOG = dir + "/text-log.jsonl";
if (existsSync(dir + "/hang-mode")) { process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = dir + "/release"; }`;
const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;

type Row = { id: string; role: string; kind: string; text?: string; card?: { requestId?: string; answered?: string }; replyToId?: string;
  relay?: { kind: string; email: string; name: string }; peerAsk?: { botId: string; name: string };
  inbox?: { kind: string; from: { name: string; email?: string; botId?: string }; via?: { name: string }; origin?: { botId: string; threadId: string; title: string }; replies?: true; answers?: Array<{ by: string; text: string }> } };
type Task = { threadId: string; title: string; inbox?: true; private?: true; openAsks?: number; inboxChangedAt?: number };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; busy?: boolean; activity?: string; tasks?: Task[] };
type Frame = { kind: string; bot?: Bot; notification?: { kind: string; botId: string; threadId: string; title: string; body: string; forPerson?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture, broker: BrokerFake;
let cleo = "", ben = "";
let scout: Bot, chief: Bot, reporter: Bot;
let cleoThread = "", benThread = "", inbox = "";
const streams: AbortController[] = [];
const sockets: Socket[] = [];
let bens: Frame[] = [], cleos: Frame[] = [];

const file = (name: string) => join(team.home, name);
const script = (calls: unknown[] | null, reply = "Done.") => {
  if (calls) writeFileSync(file("tool-calls.json"), JSON.stringify(calls)); else rmSync(file("tool-calls.json"), { force: true });
  writeFileSync(file("reply.txt"), reply);
};
const tell = (to: string, message: string) => [{ name: "message_person", server: "agents", input: { to, message } }];
const routes = (answers: Record<string, string>) => writeFileSync(file("text-routes.json"), JSON.stringify(answers));
const assistantPrompts = () => existsSync(file("text-log.jsonl")) ? readFileSync(file("text-log.jsonl"), "utf8").trim().split("\n").filter(Boolean)
  .map((line) => (JSON.parse(line) as { prompt: string }).prompt).filter((prompt) => prompt.includes("assistant on Acme")) : [];
const messages = async (token: string, threadId: string) => {
  const answer = await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  return { status: answer.status, rows: (answer.body.messages ?? []) as Row[] };
};
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const idle = async () => (await bots(cleo)).every((bot) => !bot.busy && bot.activity !== "working");
const notifiedIn = (frames: Frame[], threadId: string) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.threadId === threadId);
const inboxLines = async () => (await messages(ben, inbox)).rows.filter((row) => row.inbox);
const inboxTask = async () => (await bots(ben)).find((bot) => bot.id === chief.id)!.tasks!.find((task) => task.inbox)!;
/** Ben's inbox task in each frame about his Chief that reached his live stream. */
const inboxFrames = (frames: Frame[]) => frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === chief.id).map((frame) => frame.bot!.tasks?.find((task) => task.inbox));
const needsYou = async (token: string) => (await team.as(token, "GET", "/api/needs-you")).body.items as Array<{ kind: string; botId?: string; text?: string }>;
const chiefTurns = async () => (await messages(ben, inbox)).rows.filter((row) => row.role === "bot" && row.kind === "text" && !row.inbox);

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** As `token`, one message to `bot` in `threadId`, through the bot's settled turn. */
async function turn(token: string, bot: Bot, threadId: string, text: string) {
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => existsSync(file("dump.json")));
  await until(async () => await idle() && (await messages(token, threadId)).rows.some((row) => row.role === "bot" && row.kind === "text" && row.text === readFileSync(file("reply.txt"), "utf8")));
}
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
async function newThread(token: string, bot: Bot, title: string) {
  const opened = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body.task.threadId as string;
}
/** message_person from Scout in Cleo's chat, straight from the turn's own bearer as the agents server sends it: the bot
 * that then carries on is scripted with no calls, so it does not ask again. */
async function passFromScout(message: string) {
  script(null, "Thanks, noted.");
  const bearer = await team.capability(scout.id, cleoThread);
  const answer = await fetch(`${team.base}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "Ben", message }) });
  expect(answer.status, await answer.clone().text()).toBe(200);
}
/** Cleo's message holds Reporter's turn in its main chat while it asks Ben's approval through its permission socket. */
const approvalFromReporter = (command: string) => askedOfBen((id) => ({ t: "ask", id, tool: "Bash", input: { command } }));
/** Cleo's message holds Reporter's turn in its main chat while it asks Ben a card through its permission socket. Every
 * other turn has ended first, so the turn that writes the dump next is this one. */
async function askedOfBen(ask: (requestId: string) => Record<string, unknown>) {
  await until(idle);
  writeFileSync(file("hang-mode"), "");
  rmSync(file("release"), { force: true });
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(cleo, "POST", `/api/bots/${reporter.id}/messages`, { text: "Clean the build", threadId: reporter.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const socketPath = await expect.poll(() => {
    try { return JSON.parse(readFileSync(file("dump.json"), "utf8")).mcpConfig?.mcpServers?.ogb?.args?.[1] as string | undefined; } catch { return undefined; }
  }, { timeout: 20_000 }).toEqual(expect.any(String)).then(() => JSON.parse(readFileSync(file("dump.json"), "utf8")).mcpConfig.mcpServers.ogb.args[1] as string);
  rmSync(file("hang-mode"), { force: true });
  const socket = connect(socketPath);
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const requestId = randomUUID();
  socket.write(`${JSON.stringify(ask(requestId))}\n`);
  await expect.poll(async () => (await messages(cleo, reporter.threadId)).rows.some((row) => row.card?.requestId === requestId), { timeout: 10_000 }).toBe(true);
  return requestId;
}

beforeAll(async () => {
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  writeFileSync(file("release"), "");
  cleo = (await team.pair(CLEO)).token!;
  ben = (await team.pair(BEN)).token!;
  await bots(ben);
  const create = async (body: Record<string, unknown>) => {
    const created = await team.as(cleo, "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  scout = await create({ name: "Scout" });
  chief = await create({ name: "Ben's Chief", reportsTo: BEN.email });
  expect((await team.as(cleo, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  reporter = await create({ name: "Reporter", reportsTo: BEN.email });
  expect((await team.as(cleo, "PATCH", `/api/bots/${reporter.id}`, { approvalMode: "ask" })).status).toBe(200);
  cleoThread = await newThread(cleo, scout, "Cleo and Scout");
  benThread = await newThread(ben, scout, "Ben and Scout");
  script(null);
  await turn(ben, scout, benThread, `Keep this between us: I'm ${SECRET} on Thursday.`);

  // Google Calendar is each person's own on Acme, and Ben connected his.
  expect((await team.as(cleo, "PUT", "/api/team/connection-scopes", { kind: "app", id: "googlecalendar", scope: "person" })).status).toBe(200);
  expect((await team.as(ben, "POST", "/api/team/my-connections/apps/googlecalendar/connect", {})).status).toBe(200);
  const benUser = broker.userFor(broker.installationIds().at(-1)!);
  broker.account(benUser, "googlecalendar", BEN.email);
  // At noon two days on, so the busy hour never runs past midnight, which the prompt words as two days.
  const noon = new Date(Date.now() + 2 * 24 * 60 * 60_000);
  noon.setHours(12, 0, 0, 0);
  const start = noon.getTime();
  broker.calendarEvents[benUser] = [{ id: "ev1", summary: "Interview at Globex", status: "confirmed", location: "Globex HQ", attendees: [{ email: "hr@globex.test" }],
    start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 60 * 60_000).toISOString() } }];
  bens = listen(ben);
  cleos = listen(cleo);
  await new Promise((resolve) => setTimeout(resolve, 500));
}, hostTimeout(180_000));

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const stream of streams) stream.abort();
  await fx?.close();
  await broker?.close();
});

it("lands a bot's \"tell Ben\" in his inbox, his chat with his Chief, with one notification and nothing else of Cleo's chat", async () => {
  script(tell("Ben", "The launch moved to Friday."), "Told Ben.");
  await turn(cleo, scout, cleoThread, "Tell Ben the launch moved to Friday. (My bonus talk is private.)");
  const tasks = (await bots(ben)).find((bot) => bot.id === chief.id)!.tasks ?? [];
  inbox = tasks.find((task) => task.inbox)!.threadId;
  expect(tasks.find((task) => task.threadId === inbox)).toMatchObject({ title: "Inbox", private: true, inbox: true });
  await until(async () => (await inboxLines()).length === 1);
  const [line] = await inboxLines();
  expect(line).toMatchObject({ role: "bot", text: "The launch moved to Friday.", inbox: { kind: "message", from: { name: "Cleo", email: CLEO.email }, via: { name: "Scout" }, replies: true } });
  expect(line!.inbox!.origin, "Ben can't open Cleo's private chat").toBeUndefined();
  expect(JSON.stringify((await messages(ben, inbox)).rows)).not.toContain("bonus");
  await until(() => notifiedIn(bens, inbox).length === 1);
  expect(notifiedIn(bens, inbox)[0]!.notification).toMatchObject({ kind: "mention", botId: chief.id, title: "Message from Cleo via Scout", forPerson: BEN_KEY });
  expect(notifiedIn(cleos, inbox)).toEqual([]);
  expect((await messages(cleo, inbox)).status, "Cleo never reads Ben's inbox").toBe(404);
  expect((await messages(cleo, cleoThread)).rows.some((row) => row.relay?.kind === "told" && row.relay.email === BEN.email)).toBe(true);
}, hostTimeout(120_000));

it("brings Ben's reply back to Scout in Cleo's chat, where Scout carries on, and his Chief takes no turn", async () => {
  const [line] = await inboxLines();
  script(null, "Great, Friday it is.");
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(ben, "POST", `/api/bots/${chief.id}/messages`, { text: "Friday works for me.", threadId: inbox, replyToId: line!.id });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => (await messages(cleo, cleoThread)).rows.some((row) => row.role === "bot" && row.text === "Great, Friday it is."));
  const rows = (await messages(cleo, cleoThread)).rows;
  expect(rows.find((row) => row.relay?.kind === "reply")).toMatchObject({ role: "user", text: 'Ben replied to your message ("The launch moved to Friday."): Friday works for me.', relay: { email: BEN.email, name: "Ben" }, peerAsk: { botId: chief.id } });
  expect(JSON.stringify(JSON.parse(readFileSync(file("dump.json"), "utf8")).prompt)).toContain("Ben replied to your message");
  const inboxRows = (await messages(ben, inbox)).rows;
  expect(inboxRows.filter((row) => row.role === "bot" && row.kind === "text" && !row.inbox), "no turn of Ben's Chief").toEqual([]);
  expect(inboxRows.at(-1)).toMatchObject({ kind: "activity", relay: { kind: "told", email: CLEO.email } });
  expect(inboxRows.find((row) => row.id === line!.id)!.inbox!.answers).toEqual([expect.objectContaining({ by: "person", text: "Friday works for me." })]);
}, hostTimeout(120_000));

it("lands an @Ben from a shared chat in his inbox with a link back and one notification", async () => {
  script(null, "Noted.");
  const before = (await inboxLines()).length;
  await turn(cleo, scout, scout.mainThreadId ?? scout.threadId, "@Ben can you check the numbers before Friday?");
  await until(async () => (await inboxLines()).length === before + 1);
  expect((await inboxLines()).at(-1)).toMatchObject({ text: "@Ben can you check the numbers before Friday?", inbox: {
    from: { name: "Cleo" }, origin: { botId: scout.id, threadId: scout.mainThreadId ?? scout.threadId, title: "Scout" } } });
  await until(() => notifiedIn(bens, inbox).length === 2);
  expect(notifiedIn(bens, inbox)[1]!.notification).toMatchObject({ title: "Cleo mentioned you in Scout", forPerson: BEN_KEY });
  expect(bens.filter((frame) => frame.notification?.kind === "mention" && frame.notification.threadId !== inbox), "the mention's one notification is the inbox's").toEqual([]);
}, hostTimeout(120_000));

it("copies an approval Ben's bot asks into his inbox, with one notification, and Ben approves it there", async () => {
  const requestId = await approvalFromReporter("rm -rf ./build");
  await until(async () => (await inboxLines()).some((row) => row.card?.requestId === requestId));
  const copy = (await inboxLines()).find((row) => row.card?.requestId === requestId)!;
  expect(copy).toMatchObject({ kind: "options", inbox: { kind: "ask", from: { name: "Reporter" }, origin: { botId: reporter.id, threadId: reporter.threadId } } });
  await until(() => notifiedIn(bens, inbox).length === 3);
  expect(notifiedIn(bens, inbox)[2]!.notification).toMatchObject({ kind: "approval", botId: chief.id, title: "Reporter needs approval", forPerson: BEN_KEY });
  expect(bens.filter((frame) => frame.kind === "notify" && frame.notification?.botId === reporter.id), "one notification, from the inbox").toEqual([]);
  expect(notifiedIn(cleos, inbox)).toEqual([]);
  const answered = await team.as(ben, "POST", `/api/threads/${inbox}/respond`, { requestId, behavior: "allow" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => Boolean((await messages(cleo, reporter.threadId)).rows.find((row) => row.card?.requestId === requestId)?.card?.answered));
  await until(async () => Boolean((await inboxLines()).find((row) => row.card?.requestId === requestId)?.card?.answered));
  writeFileSync(file("release"), "");
  await until(idle);
}, hostTimeout(120_000));

it("has Ben's assistant answer a free/busy question itself, labelled, from busy times alone", async () => {
  routes({ "free on Thursday at 3pm": '{"answer": "Ben is busy for an hour that afternoon and free after it."}' });
  const before = (await inboxLines()).length;
  await passFromScout("Are you free on Thursday at 3pm?");
  await until(async () => (await messages(cleo, cleoThread)).rows.some((row) => row.relay?.kind === "assistant"), 60_000);
  expect((await messages(cleo, cleoThread)).rows.find((row) => row.relay?.kind === "assistant")).toMatchObject({ role: "user",
    text: 'Ben\'s assistant answered your message ("Are you free on Thursday at 3pm?"), from what Ben shares with the team: Ben is busy for an hour that afternoon and free after it.', relay: { email: BEN.email } });
  const [prompt] = assistantPrompts();
  expect(prompt).toMatch(/Busy times in the next 14 days \(free at every other time\): \w{3} \d{1,2} \w{3} \d\d:\d\d–\d\d:\d\d\./u);
  expect(prompt).not.toMatch(/Globex|Interview|hr@/u);
  expect(prompt).not.toContain(SECRET);
  const line = (await inboxLines())[before]!;
  expect(line).toMatchObject({ text: "Are you free on Thursday at 3pm?", inbox: { answers: [{ by: "assistant", text: "Ben is busy for an hour that afternoon and free after it." }] } });
  await until(() => notifiedIn(bens, inbox).length === 4);
  expect(notifiedIn(bens, inbox)[3]!.notification).toMatchObject({ title: "Message from Cleo via Scout · your assistant answered" });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(notifiedIn(bens, inbox).map((frame) => frame.notification!.title), "one notification for the question and its answer").toHaveLength(4);
}, hostTimeout(150_000));

it("never lets the assistant decide or approve for Ben, and never shows it his private chats", async () => {
  routes({ "budget": '{"answer": "Approved."}', "Q4 report": '{"answer": "The Q4 report is being written now."}' });
  const asked = assistantPrompts().length;
  const before = (await inboxLines()).length;
  await passFromScout("Can you approve the travel budget for me?");
  await passFromScout("What has Ben told Scout in private?");
  await until(() => notifiedIn(bens, inbox).length === 6);
  const lines = (await inboxLines()).slice(before);
  expect(lines.map((row) => row.text)).toEqual(["Can you approve the travel budget for me?", "What has Ben told Scout in private?"]);
  expect(lines.every((row) => !row.inbox!.answers)).toBe(true);
  expect(assistantPrompts(), "a decision or a private question never reaches the model").toHaveLength(asked);
  expect((await messages(cleo, cleoThread)).rows.filter((row) => row.relay?.kind === "assistant")).toHaveLength(1);
  expect(notifiedIn(bens, inbox).slice(4).map((frame) => frame.notification!.title)).toEqual(["Message from Cleo via Scout", "Message from Cleo via Scout"]);

  await passFromScout("How is your Q4 report going?");
  await until(() => assistantPrompts().length === asked + 1);
  const prompt = assistantPrompts().at(-1)!;
  expect(prompt).toContain("Reporter");
  expect(prompt).not.toContain(SECRET);
  expect(prompt).not.toContain("Globex");
}, hostTimeout(180_000));

it("counts the asks waiting on Ben on his inbox, live, and drops one as soon as he answers it in the bot's own chat", async () => {
  expect((await inboxTask()).openAsks, "what came before is answered or only news").toBeUndefined();
  const before = bens.length;
  const requestId = await approvalFromReporter("rm -rf ./dist");
  await until(async () => (await inboxTask()).openAsks === 1);
  await until(() => inboxFrames(bens.slice(before)).some((task) => task?.openAsks === 1));
  const answered = await team.as(ben, "POST", `/api/threads/${reporter.threadId}/respond`, { requestId, behavior: "deny" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => (await inboxTask()).openAsks === undefined);
  await until(() => { const seen = inboxFrames(bens.slice(before)); return seen.length > 1 && seen.at(-1)!.openAsks === undefined; });
  expect((await inboxLines()).find((row) => row.card?.requestId === requestId)!.card!.answered, "the copy in his inbox follows").toBeTruthy();
  expect((await needsYou(ben)).filter((item) => item.botId === reporter.id)).toEqual([]);
  writeFileSync(file("release"), "");
  await until(idle);
}, hostTimeout(120_000));

it("brings an answer given through the inbox bot's own respond route to the bot that asked, after its turn ended too", async () => {
  const requestId = await askedOfBen((id) => ({ t: "ask", kind: "question", id, tool: "AskUserQuestion",
    input: { questions: [{ question: "Which chart goes first?", options: [{ label: "Revenue" }, { label: "Costs" }] }] } }));
  await until(async () => (await inboxTask()).openAsks === 1);
  writeFileSync(file("release"), "");
  await until(idle);
  expect((await inboxTask()).openAsks, "a question nobody answered still waits once its turn is over").toBe(1);
  const answered = await team.as(ben, "POST", `/api/bots/${chief.id}/respond`, { threadId: inbox, requestId, behavior: "answer", message: "Revenue" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  const asked = async () => (await messages(cleo, reporter.threadId)).rows.find((row) => row.card?.requestId === requestId)!;
  await until(async () => { const card = await asked(); return (await messages(cleo, reporter.threadId)).rows.some((row) => row.role === "user" && row.text === "Revenue" && row.replyToId === card.id); });
  expect((await asked()).card!.answered, "Reporter got the answer where it asked").toBe("answer");
  await until(async () => (await inboxTask()).openAsks === undefined);
  expect(await chiefTurns(), "Ben's Chief took no turn").toEqual([]);
  await until(idle);
}, hostTimeout(120_000));

it("takes Ben's 👍 on a line in his inbox back to the bot that asked, which carries on", async () => {
  await passFromScout("Can you send me the slides by Friday?");
  const line = (await inboxLines()).findLast((row) => row.text === "Can you send me the slides by Friday?")!;
  script(null, "Great, the slides are on their way.");
  const reacted = await team.as(ben, "POST", `/api/threads/${inbox}/messages/${line.id}/reactions`, { emoji: "👍" });
  expect(reacted.status, JSON.stringify(reacted.body)).toBe(200);
  await until(async () => (await messages(cleo, cleoThread)).rows.some((row) => row.role === "bot" && row.text === "Great, the slides are on their way."));
  expect((await messages(cleo, cleoThread)).rows.findLast((row) => row.relay?.kind === "reply"))
    .toMatchObject({ text: 'Ben replied to your message ("Can you send me the slides by Friday?"): 👍', relay: { email: BEN.email } });
  expect((await inboxLines()).find((row) => row.id === line.id)!.inbox!.answers).toEqual([expect.objectContaining({ by: "person", text: "👍" })]);
  expect(await chiefTurns(), "Ben's Chief took no turn").toEqual([]);
  await until(idle);
}, hostTimeout(120_000));

it("lets a tag Ben answered in the chat it came from leave his Needs you", async () => {
  const main = scout.mainThreadId ?? scout.threadId;
  const tag = "@Ben can you confirm the Q4 numbers?";
  script(null, tag);
  await turn(cleo, scout, main, "Ask Ben to confirm the Q4 numbers.");
  const listed = async () => (await needsYou(ben)).some((item) => item.kind === "message" && item.text === tag);
  await until(listed);
  script(null, "Thanks Ben, the numbers stand.");
  await turn(ben, scout, main, "Confirmed, they are right.");
  expect(await listed()).toBe(false);
}, hostTimeout(120_000));

it("lists Ben's inbox by tab, settles an ask answered from its row, and keeps news until he marks it done", async () => {
  type Listed = { id: string; kind: string; tab: string; text: string; card?: { requestId?: string } };
  const listed = async () => (await team.as(ben, "GET", "/api/inbox")).body as { botId: string; threadId: string; rows: Listed[] };
  const before = bens.length;
  const requestId = await approvalFromReporter("rm -rf ./tmp");
  await until(async () => (await listed()).rows.some((row) => row.card?.requestId === requestId));
  const view = await listed();
  expect(view).toMatchObject({ botId: chief.id, threadId: inbox });
  expect(view.rows.find((row) => row.card?.requestId === requestId)).toMatchObject({ kind: "ask", tab: "needs-you" });
  expect(view.rows.filter((row) => row.tab === "needs-you").map((row) => row.card?.requestId), "only what waits on him needs him").toEqual([requestId]);
  expect(view.rows.find((row) => row.text === "Can you approve the travel budget for me?")).toMatchObject({ kind: "message", tab: "info" });
  expect(view.rows.find((row) => row.text === "The launch moved to Friday."), "answered from the inbox").toMatchObject({ tab: "done" });
  const ask = view.rows.find((row) => row.card?.requestId === requestId)!;
  expect((await team.as(ben, "POST", `/api/inbox/${ask.id}/done`)).status, "an ask is settled by its answer").toBe(409);

  const answered = await team.as(ben, "POST", `/api/threads/${inbox}/respond`, { requestId, behavior: "allow" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => (await listed()).rows.find((row) => row.id === ask.id)?.tab === "done");
  expect((await inboxTask()).openAsks).toBeUndefined();
  await until(() => inboxFrames(bens.slice(before)).some((task, index, all) => index > 0 && (task?.inboxChangedAt ?? 0) > (all[0]?.inboxChangedAt ?? 0)));

  const news = view.rows.find((row) => row.text === "Can you approve the travel budget for me?")!;
  const marked = await team.as(ben, "POST", `/api/inbox/${news.id}/done`);
  expect(marked.status, JSON.stringify(marked.body)).toBe(200);
  expect((marked.body as { rows: Listed[] }).rows.find((row) => row.id === news.id)).toMatchObject({ tab: "done" });
  expect((await team.as(cleo, "POST", `/api/inbox/${news.id}/done`)).status, "only his own").toBe(404);
  writeFileSync(file("release"), "");
  await until(idle);
}, hostTimeout(120_000));

it("opens Ben's inbox on his first arrival of the day, and forgets it once he leaves", async () => {
  await passFromScout("Can you book the meeting room for Friday?");
  const arrived = await team.as(ben, "POST", "/api/presence/active", { source: "desktop" });
  expect(arrived.body.open, JSON.stringify(arrived.body)).toEqual({ botId: chief.id, threadId: inbox });
  expect((await team.as(ben, "POST", "/api/presence/active", { source: "desktop" })).body.open).toBeUndefined();
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: BEN.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  const bearer = await team.capability(scout.id, cleoThread);
  const refused = await fetch(`${team.base}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "Ben", message: "Still there?" }) });
  expect(refused.status).toBe(410);
}, hostTimeout(60_000));

it("has none of it on a My Cloud: no inbox, no person route", async () => {
  const solo = (await fx.onCloud("POST", "/api/bots", { name: "Solo" })).body.bot as Bot;
  expect(solo.tasks?.some((task) => task.inbox || task.openAsks !== undefined) ?? false).toBe(false);
  expect(((await fx.onCloud("GET", "/api/needs-you")).body.items as Array<{ kind: string }>).filter((item) => item.kind === "message")).toEqual([]);
  expect((await fx.onCloud("GET", "/api/notifications")).body.notifications.filter((entry: { forPerson?: string }) => entry.forPerson)).toEqual([]);
}, hostTimeout(60_000));
