// Telling a teammate on a Team Cloud, end to end (docs/team-cloud.md "Telling a teammate"): Acme's Owner (Olive), an
// Admin (Ada) and two members (Bob, Carl), the synthetic Claude CLI calling message_person through the real agents MCP
// server. Ada's private chat passes Bob one message into a new private conversation of his own, Bob's answer comes back
// to Ada's chat, an @Bob in a shared chat reaches Bob alone, someone who left is refused, and a My Cloud has none of it.
// It proves where each message lands and who may see it, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const CARL = { email: "carl@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_REPLY_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/reply.txt";`;
const CLOUD_CAPABILITY_KEY = randomBytes(16).toString("hex");

type Row = { id: string; role: string; kind: string; text?: string; tool?: { name: string; ok?: boolean; output?: string }; relay?: { kind: string; email: string; name: string } };
type Task = { threadId: string; title: string; private?: boolean };
type Frame = { kind: string; notification?: { kind: string; threadId: string; title: string; forPerson?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", ada = "", bob = "", carl = "";
let scout: { id: string; threadId: string; mainThreadId?: string };
let mainThread = "", adaThread = "", bobThread = "";
const streams: AbortController[] = [];

const script = (calls: unknown[] | null, reply = "Done.") => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
  writeFileSync(join(team.home, "reply.txt"), reply);
};
const tell = (to: string, message: string) => [{ name: "message_person", server: "agents", input: { to, message } }];
const messages = async (token: string, threadId: string) => {
  const answer = await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  return { status: answer.status, rows: (answer.body.messages ?? []) as Row[] };
};
const tasks = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks?: Task[] }>)
  .find((bot) => bot.id === scout.id)?.tasks ?? [];
const needsYou = async (token: string) => (await team.as(token, "GET", "/api/needs-you")).body.items as Array<{ kind: string; threadId: string; messageId?: string; from?: string; fromEmail?: string; text?: string }>;
const feed = async (token: string) => (await team.as(token, "GET", "/api/notifications")).body.notifications as Array<{ kind: string; threadId: string; title: string; forPerson?: string }>;
const idle = async () => ((await team.as(olive, "GET", "/api/bots")).body.bots as Array<{ busy?: boolean; activity?: string }>).every((bot) => !bot.busy && bot.activity !== "working");

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** As `token`, one message to Scout in `threadId`, through the bot's settled turn. */
async function turn(token: string, threadId: string, text: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${scout.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => existsSync(join(team.home, "dump.json")));
  await until(async () => await idle() && (await messages(token, threadId)).rows.some((row) => row.role === "bot" && row.kind === "text" && row.text === readFileSync(join(team.home, "reply.txt"), "utf8")));
  return JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string; mcpConfig: { mcpServers: { agents?: { env?: Record<string, string> } } } };
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
const notifiedIn = (frames: Frame[], threadId: string) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.threadId === threadId && frame.notification.kind === "mention");
/** message_person straight from a turn's own bearer, as the agents server sends it. */
async function passDirect(threadId: string, to: string, message: string) {
  const bearer = await team.capability(scout.id, threadId);
  const answer = await fetch(`${team.base}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ to, message }) });
  return { status: answer.status, body: await answer.json() as { text?: string; error?: string } };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, cloudEnv: { OMB_TEST_INTERNAL_CAPABILITY_KEY: CLOUD_CAPABILITY_KEY },
    team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  ada = (await team.pair(ADA)).token!;
  bob = (await team.pair(BOB)).token!;
  carl = (await team.pair(CARL)).token!;
  const created = await team.as(olive, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot;
  mainThread = scout.mainThreadId ?? scout.threadId;
  const opened = await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Ada's planning" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  adaThread = opened.body.task.threadId;
}, hostTimeout(120_000));

afterAll(async () => {
  for (const stream of streams) stream.abort();
  await fx?.close();
});

it("lists the team's people for the @ menu and mounts message_person on a team's turns", async () => {
  const people = (await team.as(ada, "GET", "/api/team/people")).body.people as Array<{ email: string; name: string; you?: boolean }>;
  expect(people.map((person) => person.name).sort()).toEqual(["Ada", "Bob", "Carl", "Olive"]);
  script(null);
  const dump = await turn(ada, adaThread, "Hello Scout, my salary review is on Monday.");
  expect(dump.mcpConfig.mcpServers.agents?.env?.OMB_TEAM_PEOPLE).toBe("1");
  expect(dump.systemPrompt).toContain('The people in Acme (the names they chose): "Bob", "Carl", "Olive" (owner).');
  expect(dump.systemPrompt).toContain("message_person");
}, hostTimeout(90_000));

it("passes Ada's message to Bob in a new private conversation of his own, and nothing else of her chat", async () => {
  const [olives, adas, bobs] = [listen(olive), listen(ada), listen(bob)];
  await new Promise((resolve) => setTimeout(resolve, 500));
  script(tell("Bob", "The launch moved to Friday."), "Told Bob.");
  await turn(ada, adaThread, "Tell @Bob the launch moved to Friday.");

  const chip = (await messages(ada, adaThread)).rows.find((row) => row.relay?.kind === "told");
  expect(chip).toMatchObject({ kind: "activity", tool: { name: "Told Bob", ok: true, output: "The launch moved to Friday." }, relay: { email: BOB.email, name: "Bob" } });

  const delivered = (await tasks(bob)).find((task) => task.title === "From Ada");
  expect(delivered, JSON.stringify(await tasks(bob))).toMatchObject({ private: true });
  bobThread = delivered!.threadId;
  const bobsRows = (await messages(bob, bobThread)).rows;
  expect(bobsRows.map((row) => row.text)).toEqual(["Ada asked me to pass this on: The launch moved to Friday."]);
  expect(bobsRows[0]!.relay).toEqual({ kind: "from", email: ADA.email, name: "Ada" });
  expect(JSON.stringify(bobsRows)).not.toContain("salary");

  // Only Bob: his Needs you, his notification; no one else's, the Owner's included.
  await until(async () => (await needsYou(bob)).some((item) => item.kind === "message" && item.threadId === bobThread));
  expect((await needsYou(bob)).find((item) => item.threadId === bobThread)).toMatchObject({ from: "Ada", fromEmail: ADA.email, text: "The launch moved to Friday." });
  for (const token of [ada, olive]) expect((await needsYou(token)).filter((item) => item.kind === "message")).toEqual([]);
  for (const token of [ada, olive]) expect((await feed(token)).filter((entry) => entry.threadId === bobThread)).toEqual([]);
  await until(() => notifiedIn(bobs, bobThread).length === 1);
  expect(notifiedIn(bobs, bobThread)[0]!.notification).toMatchObject({ title: "Message from Ada via Scout" });
  expect(notifiedIn(adas, bobThread)).toEqual([]);
  expect(notifiedIn(olives, bobThread)).toEqual([]);

  // Ada asking in her private chat never makes it the bot's main chat for anyone.
  for (const token of [bob, olive]) {
    const seen = ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; mainThreadId?: string; threadId?: string }>).find((bot) => bot.id === scout.id)!;
    expect(seen).toMatchObject({ mainThreadId: mainThread, threadId: mainThread });
  }
  // Each private chat stays its person's: Bob never reads Ada's, Ada and the Owner never read or list Bob's.
  expect((await messages(bob, adaThread)).status).toBe(404);
  for (const token of [ada, olive]) {
    expect((await messages(token, bobThread)).status).toBe(404);
    expect((await tasks(token)).some((task) => task.threadId === bobThread)).toBe(false);
  }
}, hostTimeout(90_000));

it("brings Bob's answer back into Ada's own conversation, where only Ada reads it", async () => {
  const [adas, olives] = [listen(ada), listen(olive)];
  await new Promise((resolve) => setTimeout(resolve, 500));
  script(tell("Ada", "Bob will review it tonight."), "I'll let Ada know.");
  const dump = await turn(bob, bobThread, "Thanks! Tell Ada I'll review it tonight. (Private: I'm job hunting.)");
  expect(dump.systemPrompt).toContain('This conversation began when "Ada" asked you to pass a message on');
  expect(dump.systemPrompt).toContain('message_person to "Ada"');

  const adasRows = (await messages(ada, adaThread)).rows;
  const reply = adasRows.find((row) => row.relay?.kind === "reply");
  expect(reply).toMatchObject({ role: "bot", kind: "text", text: "Bob replied: Bob will review it tonight.", relay: { email: BOB.email, name: "Bob" } });
  expect(JSON.stringify(adasRows)).not.toContain("job hunting");
  expect((await messages(bob, bobThread)).rows.some((row) => row.relay?.kind === "told" && row.relay.email === ADA.email)).toBe(true);
  await until(async () => (await needsYou(ada)).some((item) => item.kind === "message" && item.threadId === adaThread));
  expect((await needsYou(ada)).find((item) => item.threadId === adaThread)).toMatchObject({ from: "Bob", fromEmail: BOB.email, messageId: reply!.id });
  await until(() => notifiedIn(adas, adaThread).length === 1);
  expect(notifiedIn(olives, adaThread)).toEqual([]);
  expect((await messages(ada, bobThread)).status).toBe(404);
  expect((await messages(bob, adaThread)).status).toBe(404);

  // Opening the conversation settles what waited there.
  expect((await team.as(bob, "POST", `/api/bots/${scout.id}/read`, { threadId: bobThread })).status).toBe(200);
  expect((await needsYou(bob)).filter((item) => item.threadId === bobThread)).toEqual([]);
}, hostTimeout(90_000));

it("notifies only Bob of an @Bob in the bot's shared chat, from a person or from the bot", async () => {
  const [olives, adas, bobs, carls] = [listen(olive), listen(ada), listen(bob), listen(carl)];
  await new Promise((resolve) => setTimeout(resolve, 500));
  script(null, "Noted. @Carl can you pull the numbers too?");
  await turn(ada, mainThread, "@Bob can you check the numbers before Friday?");
  await until(() => notifiedIn(bobs, mainThread).length === 1);
  expect(notifiedIn(bobs, mainThread)[0]!.notification).toMatchObject({ title: "Ada mentioned you in Scout", forPerson: personKey({ id: "", email: BOB.email }) });
  expect(notifiedIn(adas, mainThread)).toEqual([]);
  expect(notifiedIn(olives, mainThread)).toEqual([]);
  expect((await needsYou(bob)).find((item) => item.threadId === mainThread)).toMatchObject({ kind: "message", from: "Ada" });
  for (const token of [ada, olive]) expect((await feed(token)).filter((entry) => entry.threadId === mainThread && entry.kind === "mention")).toEqual([]);
  await until(() => notifiedIn(carls, mainThread).length === 1);
  expect(notifiedIn(carls, mainThread)[0]!.notification).toMatchObject({ title: "Scout mentioned you" });
  expect(notifiedIn(bobs, mainThread).map((frame) => frame.notification!.title)).toEqual(["Ada mentioned you in Scout"]);
}, hostTimeout(90_000));

it("refuses someone who left in plain words, and caps passes per conversation", async () => {
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: CARL.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(await passDirect(adaThread, "Carl", "Are you around?")).toEqual({ status: 410, body: { error: "Carl has left Acme, so nothing can be passed to them any more. Tell the person." } });
  expect((await passDirect(adaThread, "Mallory", "Hi")).status).toBe(404);
  expect((await passDirect(adaThread, "Ada", "Note to self")).status).toBe(400);

  const sent: number[] = [];
  for (let i = 0; i < 11; i += 1) sent.push((await passDirect(mainThread, "Bob", `Reminder ${i}`)).status);
  expect(sent).toEqual([...Array(10).fill(200), 429]);
}, hostTimeout(90_000));

it("has none of it on a My Cloud: no tool route, no tags by name, nothing new in Needs you", async () => {
  const solo = (await fx.onCloud("POST", "/api/bots", { name: "Solo" })).body.bot as { id: string; threadId: string };
  const minted = await fetch(`${fx.cloudBase}/api/testing/internal-capability`, { method: "POST",
    headers: { "content-type": "application/json", "x-openmausbot-test-capability": CLOUD_CAPABILITY_KEY }, body: JSON.stringify({ botId: solo.id, threadId: solo.threadId }) });
  expect(minted.status).toBe(201);
  const { token } = await minted.json() as { token: string };
  const answer = await fetch(`${fx.cloudBase}/api/internal/people/message`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ to: "Bob", message: "Hi" }) });
  expect(answer.status).toBe(404);
  expect(((await fx.onCloud("GET", "/api/needs-you")).body.items as Array<{ kind: string }>).filter((item) => item.kind === "message")).toEqual([]);
  expect((await fx.onCloud("GET", "/api/notifications")).body.notifications.filter((entry: { forPerson?: string }) => entry.forPerson)).toEqual([]);
}, hostTimeout(60_000));
