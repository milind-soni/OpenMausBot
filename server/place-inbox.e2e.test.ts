// The Inbox with no team, end to end on both places a person's bots live (docs/team-cloud.md "Off a team"): this computer
// and My Cloud, each its own real server with a synthetic Claude CLI. A bot's approval and question are listed with the
// right count, answered through the row's own conversation, and the turn goes on; message_person arrives once and its
// reply reaches the bot. A guest's conversation left on a shared Cloud reaches the owner labelled, not as their own. It
// proves where things land, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { markLeftBehind } from "./testing/cloud-left-behind.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_ROOM_PLAN = dir + "/room-plan.json";`;
const TOKEN = `ops_fake-inbox-${randomBytes(8).toString("hex")}`;

type Card = { requestId?: string; tool?: string; answered?: string };
type Row = { id: string; kind: string; tab: string; unread: boolean; replies?: true; text: string; from: { name: string; botId?: string }; workingFor?: { name: string }; askedBy?: { name: string };
  origin?: { botId: string; threadId: string; title: string }; card?: Card };
type Note = { kind: string; botId: string; threadId: string; title: string; body: string };
type Bot = { id: string; name: string; threadId: string; busy?: boolean; activity?: string };
type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

let fx: CloudSendFixture;

async function until(done: () => Promise<boolean> | boolean, what: string, timeoutMs = hostTimeout(60_000)): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function place(call: Call, home: () => string) {
  const plan: Record<string, { script: unknown[] }> = {};
  const file = () => join(home(), "room-plan.json");
  const script = (botId: string, ...entries: unknown[]) => {
    (plan[botId] ??= { script: [] }).script.push(...entries);
    writeFileSync(file(), JSON.stringify(plan));
  };
  const turns = (botId: string): Array<{ planKey?: string; threadId?: string; prompt: unknown }> => {
    const path = `${file()}.evidence.jsonl`;
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn) => turn.botId === botId) : [];
  };
  const inbox = async () => (await call("GET", "/api/inbox")).body as { rows: Row[]; threadId: string | null };
  const count = async () => (await call("GET", "/api/inbox/count")).body.count as number;
  const listed = async () => (await inbox()).rows.filter((row) => row.tab !== "done");
  const notes = async () => ((await call("GET", "/api/notifications")).body.notifications ?? []) as Note[];
  const messages = async (threadId: string) => ((await call("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ id: string; role: string; kind: string; text?: string; at: number; card?: Card; inbox?: unknown }>;
  const bot = async (name: string) => {
    const created = await call("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await call("PATCH", `/api/bots/${created.body.bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
    return created.body.bot as Bot;
  };
  const thread = async (botId: string, title: string) => {
    const opened = await call("POST", `/api/bots/${botId}/tasks`, { title });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    return opened.body.task.threadId as string;
  };
  const say = async (botId: string, threadId: string, text: string, more: Record<string, unknown> = {}) => {
    const sent = await call("POST", `/api/bots/${botId}/messages`, { text, threadId, ...more });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  };
  return { script, turns, inbox, count, listed, notes, messages, bot, thread, say };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, cloudEngine: ENGINE, desktopEngine: ENGINE });
  writeFileSync(join(fx.root, "desktop", "room-plan.json"), "{}");
  writeFileSync(join(fx.root, "cloud", "room-plan.json"), "{}");
}, hostTimeout(180_000));

afterAll(async () => { await fx?.close(); });

describe.each([
  ["this computer", "desktop"],
  ["My Cloud", "cloud"],
] as const)("on %s", (_name, role) => {
  const here = () => place(role === "desktop" ? fx.local : fx.onCloud, () => join(fx.root, role));

  it("starts with an inbox with nothing in it, not a missing one", async () => {
    const h = here();
    expect(await h.inbox()).toMatchObject({ rows: [], threadId: null });
    expect(await h.count()).toBe(0);
  });

  it("lists a bot's approval and question with the right count and their threads, and an answer from the inbox reaches the bot, whose turn goes on", async () => {
    const h = here();
    const eli = await h.bot(`Eli ${role}`);
    const pricing = await h.thread(eli.id, "Pricing work");
    const launch = await h.thread(eli.id, "Launch work");
    h.script(eli.id,
      { key: "P1", match: ["P1-GO"], timeoutMs: 120_000, approve: { tool: "Bash", input: { command: "echo hi" } }, reply: "P1: approved and ran", replyIfDenied: "P1: denied" },
      { key: "Q1", match: ["Q1-GO"], timeoutMs: 120_000, steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Which page?", choices: ["Home", "Pricing"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "Q1: going with {{answer}}" });
    const before = (await h.notes()).length;
    await h.say(eli.id, pricing, "P1-GO");
    await h.say(eli.id, launch, "Q1-GO");

    await until(async () => (await h.listed()).length === 2, "the approval and the question in the inbox");
    expect(await h.count()).toBe(2);
    const rows = await h.listed();
    const approval = rows.find((row) => row.card?.tool)!;
    const question = rows.find((row) => !row.card?.tool)!;
    expect(approval).toMatchObject({ kind: "ask", tab: "needs-you", from: { name: eli.name }, origin: { threadId: pricing, title: "Pricing work" } });
    expect(question).toMatchObject({ kind: "ask", tab: "needs-you", from: { name: eli.name }, origin: { threadId: launch, title: "Launch work" } });
    expect((await h.inbox()).threadId, "nothing was copied into a conversation of its own").toBeNull();

    const notified = (await h.notes()).slice(0, (await h.notes()).length - before);
    expect(notified.filter((note) => note.threadId === pricing && note.kind === "approval"), "one notification per item").toHaveLength(1);
    expect(notified.filter((note) => note.threadId === launch && note.kind === "question"), "one notification per item").toHaveLength(1);

    const call = role === "desktop" ? fx.local : fx.onCloud;
    const allowed = await call("POST", `/api/threads/${approval.origin!.threadId}/respond`, { requestId: approval.card!.requestId, behavior: "allow" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    await until(async () => (await h.messages(pricing)).some((line) => line.text === "P1: approved and ran"), "the approved turn to go on");
    expect(await h.count()).toBe(1);

    const answered = await call("POST", `/api/threads/${question.origin!.threadId}/respond`, { requestId: question.card!.requestId, behavior: "answer", message: "Pricing" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await until(async () => (await h.messages(launch)).some((line) => line.text === "Q1: going with Pricing"), "the answered turn to go on");
    expect(await h.count()).toBe(0);
    expect(await h.listed()).toEqual([]);

    const again = await call("POST", `/api/threads/${question.origin!.threadId}/respond`, { requestId: question.card!.requestId, behavior: "answer", message: "Home" });
    expect(again.status, "no answer is sent twice").toBeGreaterThanOrEqual(400);
    expect((await h.messages(launch)).some((line) => line.text?.includes("going with Home"))).toBe(false);
  }, hostTimeout(180_000));

  it("gets a bot's message_person to the person once, and their reply reaches the bot", async () => {
    const h = here();
    const eli = await h.bot(`Mel ${role}`);
    const work = await h.thread(eli.id, "Background work");
    h.script(eli.id,
      { key: "M1", match: ["M1-GO"], steps: [{ server: "agents", tool: "message_person", arguments: { message: "The report is ready." } }], reply: "M1: told them" },
      { key: "M2", match: ["Send it to Ada"], reply: "M2: sending it" });
    await h.say(eli.id, work, "M1-GO");
    await until(async () => (await h.messages(work)).some((line) => line.text === "M1: told them"), "the bot's turn");
    const line = (await h.listed()).find((row) => row.kind === "message")!;
    expect(line).toMatchObject({ tab: "info", unread: true, replies: true, text: "The report is ready.", from: { name: eli.name }, origin: { threadId: work, title: "Background work" } });
    expect(await h.count()).toBe(1);
    expect((await h.notes()).filter((note) => note.threadId === work && note.body === "The report is ready."), "one notification, not one for the chat and one for the inbox").toHaveLength(1);
    expect((await h.messages(work)).filter((one) => one.text === "The report is ready."), "one line").toHaveLength(1);

    await h.say(eli.id, work, "Send it to Ada", { replyToId: line.id });
    await until(() => h.turns(eli.id).some((turn) => turn.planKey === "M2"), "the reply to reach the bot");
    await until(async () => (await h.messages(work)).some((one) => one.text === "M2: sending it"), "the bot to carry on");
    expect(await h.count()).toBe(0);
    expect((await h.inbox()).rows.find((row) => row.id === line.id)!.tab).toBe("done");
  }, hostTimeout(120_000));

  it("says who a bot was working for, on a question from work another bot handed it", async () => {
    const h = here();
    const mira = await h.bot(`Mira ${role}`);
    const eli = await h.bot(`Ori ${role}`);
    h.script(mira.id,
      { key: "W1", match: ["W1-GO"], steps: [{ arguments: { bot_ids: [eli.id], message: "W1-BRIEF: pick the page." } }], reply: "W1: handed on" },
      { key: "W1-DONE", match: ["Your downstream room requests have settled.", "W1-GO"], reply: "W1-DONE" });
    h.script(eli.id, { key: "W1-E", match: ["W1-BRIEF"], timeoutMs: 120_000, steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Which page for Mira?", choices: ["Home", "Pricing"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "W1-E: {{answer}}" });
    await h.say(mira.id, mira.threadId, "W1-GO");
    await until(async () => (await h.listed()).some((row) => row.from.name === eli.name && row.kind === "ask"), "the handed-on question in the inbox");
    const row = (await h.listed()).find((one) => one.from.name === eli.name && one.kind === "ask")!;
    expect(row.workingFor?.name).toBe(mira.name);
    expect(row.origin?.botId).toBe(eli.id);
    const call = role === "desktop" ? fx.local : fx.onCloud;
    expect((await call("POST", `/api/threads/${row.origin!.threadId}/respond`, { requestId: row.card!.requestId, behavior: "answer", message: "Home" })).status).toBe(200);
    await until(async () => (await h.messages(row.origin!.threadId)).some((line) => line.text === "W1-E: Home"), "the work to go on");
    expect((await h.listed()).some((one) => one.id === row.id)).toBe(false);
  }, hostTimeout(180_000));

  it("clears news once it is read, and keeps it listed until it is done", async () => {
    const h = here();
    const eli = await h.bot(`Nia ${role}`);
    h.script(eli.id, { key: "N1", match: ["N1-GO"], steps: [{ server: "agents", tool: "message_person", arguments: { message: "News for you." } }], reply: "N1: told them" });
    await h.say(eli.id, eli.threadId, "N1-GO");
    await until(async () => (await h.messages(eli.threadId)).some((line) => line.text === "N1: told them"), "the bot's turn");
    const call = role === "desktop" ? fx.local : fx.onCloud;
    const row = (await h.listed()).find((one) => one.text === "News for you.")!;
    expect(row.unread).toBe(true);
    expect((await call("POST", `/api/inbox/${row.id}/read`)).status).toBe(200);
    expect((await h.listed()).find((one) => one.id === row.id)).toMatchObject({ unread: false, tab: "info" });
    expect(await h.count()).toBe(0);
    expect((await call("POST", `/api/inbox/${row.id}/done`)).body.rows.find((one: Row) => one.id === row.id).tab).toBe("done");
    expect((await call("POST", "/api/inbox/not-a-line/read")).status).toBe(404);
  }, hostTimeout(120_000));
});

describe("on a Cloud someone else once used", () => {
  it("lets nobody connect as a guest, shows a bot's shell nothing, and labels a guest's ask to its owner while keeping a guest's news away", async () => {
    const h = place(fx.onCloud, () => join(fx.root, "cloud"));
    const refused = await fx.onCloud("POST", "/api/auth/pairing", { label: "Friend", scopes: ["client"] });
    expect(refused.status, "a personal Cloud takes the owner's own devices only").toBeGreaterThanOrEqual(400);

    const shell = await fetch(`${fx.cloudBase}/api/inbox`);
    const seen = await shell.json().catch(() => null) as { rows?: Row[]; error?: string } | null;
    expect(shell.ok ? seen?.rows : [], `status ${shell.status}`).toEqual([]);

    const zed = await h.bot("Zed");
    const theirs = await h.thread(zed.id, "Sam's work");
    const owners = await h.thread(zed.id, "My work");
    h.script(zed.id,
      { key: "G1", match: ["G1-GO"], timeoutMs: 120_000, steps: [{ server: "agents", tool: "message_person", arguments: { message: "For the guest" } }, { server: "ogb", tool: "ask_user", arguments: { question: "Guest's question?", choices: ["A", "B"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "G1: {{answer}}" },
      { key: "G2", match: ["G2-GO"], timeoutMs: 120_000, steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Owner's question?", choices: ["A", "B"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "G2: {{answer}}" },
      { key: "G3", match: ["G3-GO"], reply: "G3 done" });

    markLeftBehind(join(fx.root, "cloud", ".openmausbot"), { threadIds: [theirs] });
    await fx.relaunch({ cloud: {} });
    await h.say(zed.id, theirs, "G1-GO");
    await h.say(zed.id, owners, "G2-GO");
    await until(async () => (await h.listed()).filter((row) => row.from.name === "Zed" && row.kind === "ask").length === 2, "both asks");
    const rows = await h.listed();
    const guests = rows.find((row) => row.origin?.threadId === theirs && row.kind === "ask")!;
    const own = rows.find((row) => row.origin?.threadId === owners && row.kind === "ask")!;
    expect(guests.askedBy, "a guest's ask says it isn't the owner's").toBeDefined();
    expect(own.askedBy).toBeUndefined();
    expect((await h.messages(theirs)).some((line) => line.text === "For the guest"), "the bot did send it").toBe(true);
    expect(rows.some((row) => row.text === "For the guest"), "a guest's news isn't the owner's").toBe(false);
    expect((await h.notes()).some((note) => note.body === "For the guest")).toBe(false);
    // The owner's answer reaches the guest's turn, and the guest's conversation stays confined after it.
    const answered = await fx.onCloud("POST", `/api/threads/${theirs}/respond`, { requestId: guests.card!.requestId, behavior: "answer", message: "A" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await until(async () => (await h.messages(theirs)).some((line) => line.text === "G1: A"), "the guest's turn to go on");
    await h.say(zed.id, theirs, "G3-GO");
    await until(() => h.turns(zed.id).some((turn) => turn.planKey === "G3"), "a later turn in the guest's conversation");
    const restricted = (key: string) => (h.turns(zed.id).find((turn) => turn.planKey === key) as { restricted?: boolean } | undefined)?.restricted;
    expect([restricted("G1"), restricted("G3")]).toEqual([true, true]);
  }, hostTimeout(420_000));
});
