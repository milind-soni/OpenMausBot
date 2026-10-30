// A teammate's question as a card on a Team Cloud, end to end (docs/team-cloud.md "One inbox per person"): Cleo asks
// Scout, her Chief, whose chat is her inbox, to have Ledger fix something. Ledger asks a decision with set answers through
// the synthetic Claude CLI's real ask_user server; the card is in Ledger's chat and its copy in Cleo's inbox has the
// same choices; a tap there, or her own words in Ledger's chat, answers Ledger, who carries on with that answer, and Scout
// hears the result once. Ledger's NEEDS INPUT question becomes the same card with a reply field. Cleo is never sent a
// question twice. It proves where things land, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CLEO = { email: "cleo@acme.test", role: "owner" as const };
const QUESTION = "Should I apply the fix to the pricing page?";
const CHOICES = ["Yes, only the footer text", "Yes, the welcome text too", "No"];
const OPEN = "What wording should the new footer text use?";
const SETTLED = "Your downstream room requests have settled.";
const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_ROOM_PLAN = dir + "/room-plan.json";`;
const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;

type Card = { requestId?: string; requestType?: string; options?: string[]; subtitle?: string; answered?: string; answeredText?: string; stopped?: boolean };
type Row = { id: string; role: string; kind: string; at: number; text?: string; card?: Card; replyToId?: string; tool?: { name: string };
  inbox?: { kind: string; from: { name: string }; origin?: { threadId: string } } };
type Task = { threadId: string; title: string; inbox?: true; openedBy?: { botId: string } };
type Bot = { id: string; name: string; threadId: string; busy?: boolean; activity?: string; tasks?: Task[] };
type Frame = { kind: string; notification?: { kind: string; botId: string; threadId: string; title: string; body: string; forPerson?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let cleo = "";
let scout: Bot, ledger: Bot;
let inbox = "";
const streams: AbortController[] = [];
let frames: Frame[] = [];

const file = (name: string) => join(team.home, name);
const plan: Record<string, { script: unknown[] }> = {};
const script = (botId: string, ...entries: unknown[]) => {
  (plan[botId] ??= { script: [] }).script.push(...entries);
  writeFileSync(file("room-plan.json"), JSON.stringify(plan));
};
const turns = (botId: string): Array<{ planKey?: string; threadId?: string; prompt: unknown }> => {
  const path = file("room-plan.json.evidence.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn) => turn.botId === botId) : [];
};
const told = (botId: string, key: string) => JSON.stringify(turns(botId).find((turn) => turn.planKey === key)?.prompt ?? "");
const messages = async (threadId: string) => ((await team.as(cleo, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Row[];
const bots = async () => (await team.as(cleo, "GET", "/api/bots")).body.bots as Bot[];
const idle = async () => (await bots()).every((bot) => !bot.busy && bot.activity !== "working");
const questionsIn = async (threadId: string, text: string) => (await messages(threadId)).filter((row) => JSON.stringify([row.text, row.card?.subtitle, row.tool?.name]).includes(text));
const questionsNotified = (threadId: string) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.threadId === threadId && frame.notification.kind === "question");

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function listen(token: string): Frame[] {
  const seen: Frame[] = [];
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
        if (data) try { seen.push(JSON.parse(data.slice(6)) as Frame); } catch { /* a heartbeat */ }
      }
    }
  })().catch(() => {});
  return seen;
}
async function say(bot: Bot, threadId: string, text: string) {
  const sent = await team.as(cleo, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return sent.body as { message?: Row };
}
/** The question card a job's turn asks with, once it is there: an open one since `since`, in the work Scout handed Ledger. */
async function cardIn(since: number, match: (card: Card) => boolean): Promise<{ work: string; row: Row }> {
  let found: { work: string; row: Row } | undefined;
  const handed = async () => ((await bots()).find((bot) => bot.id === ledger.id)!.tasks ?? []).filter((task) => task.openedBy?.botId === scout.id);
  await until(async () => {
    for (const { threadId: work } of await handed()) {
      const row = (await messages(work)).find((one) => one.card && match(one.card) && !one.card.answered && one.at >= since);
      if (row) found = { work, row };
    }
    return Boolean(found);
  }).catch(async (error: Error) => {
    const seen = await Promise.all((await handed()).map(async (task) => ({ task: task.title, rows: (await messages(task.threadId)).slice(-4).map((row) => [row.role, row.kind, row.text?.slice(0, 80), row.card?.answered]) })));
    throw new Error(`${error.message}: ${JSON.stringify({ seen, scout: turns(scout.id).map((turn) => turn.planKey), ledger: turns(ledger.id).map((turn) => turn.planKey) })}`);
  });
  return found!;
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-qc", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  writeFileSync(file("room-plan.json"), "{}");
  cleo = (await team.pair(CLEO)).token!;
  const create = async (body: Record<string, unknown>) => {
    const created = await team.as(cleo, "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  scout = await create({ name: "Scout", reportsTo: CLEO.email });
  expect((await team.as(cleo, "PATCH", `/api/bots/${scout.id}`, { chiefOfStaff: true })).status).toBe(200);
  ledger = await create({ name: "Ledger", reportsTo: CLEO.email });
  // Questions reach the person on "Ask me first"; at Full access, the default, the requesting bot decides them instead.
  for (const bot of [scout, ledger]) expect((await team.as(cleo, "PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
  const opened = await team.as(cleo, "POST", `/api/bots/${scout.id}/tasks`, { title: "Cleo and Scout" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  inbox = opened.body.task.threadId as string;
  frames = listen(cleo);
  await new Promise((resolve) => setTimeout(resolve, 500));
}, hostTimeout(180_000));

afterAll(async () => {
  for (const stream of streams) stream.abort();
  await fx?.close();
});

const brief = (job: string) => `${job}-BRIEF: Apply the fix to the pricing page, on branch fix/pricing-page-footer, with a PR into main.`;
const handOn = (job: string) => [
  { key: `${job}-L`, match: [`${job}-JOB`], steps: [{ arguments: { bot_ids: [ledger.id], message: brief(job) } }], reply: `${job}-L: Ledger is applying the fix.` },
  { key: `${job}-L-DONE`, match: [SETTLED, `${job}-JOB`], reply: `${job}-L-DONE: Ledger is done.` },
];
const askWithCard = (job: string) => ({ key: `${job}-B`, match: [`${job}-BRIEF`], timeoutMs: 120_000,
  steps: [{ server: "ogb", tool: "ask_user", arguments: { question: QUESTION, choices: CHOICES }, capture: { answer: "([\\s\\S]+)" } }],
  reply: `${job}-B: Done with: {{answer}}` });

it("asks Cleo a decision with set answers as a card in Ledger's chat and a copy in her inbox, and a tap there answers Ledger, who carries on", async () => {
  script(scout.id, ...handOn("QC1"));
  script(ledger.id, askWithCard("QC1"));
  const sinceQC1 = Date.now();
  await say(scout, inbox, "QC1-JOB: Have Ledger apply the fix to the pricing page.");
  const { work, row } = await cardIn(sinceQC1, (card) => card.subtitle === QUESTION);
  expect(row.card).toMatchObject({ requestType: "question", options: CHOICES });

  await until(async () => (await messages(inbox)).some((line) => line.card?.requestId === row.card!.requestId));
  expect((await bots()).find((bot) => bot.id === scout.id)!.tasks!.find((task) => task.inbox)?.threadId, "Cleo's chat with Scout is her inbox").toBe(inbox);
  const copy = (await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)!;
  expect(copy).toMatchObject({ kind: "options", card: { options: CHOICES, requestType: "question" }, inbox: { kind: "ask", from: { name: "Ledger" }, origin: { threadId: work } } });
  const listed = (await team.as(cleo, "GET", "/api/inbox")).body as { rows: Array<{ id: string; tab: string; card?: Card }> };
  expect(listed.rows.find((line) => line.id === copy.id)).toMatchObject({ tab: "needs-you", card: { options: CHOICES } });
  await until(() => questionsNotified(inbox).length === 1);
  expect(questionsNotified(inbox)[0]!.notification).toMatchObject({ botId: scout.id, title: "Ledger has a question" });
  expect(frames.filter((frame) => frame.kind === "notify" && frame.notification?.botId === ledger.id), "one notification, from the inbox").toEqual([]);
  expect((await messages(inbox)).some((line) => line.tool?.name.startsWith("Waiting on your answer")), "no chip beside the copy").toBe(false);

  const answered = await team.as(cleo, "POST", `/api/threads/${inbox}/respond`, { requestId: row.card!.requestId, behavior: "answer", message: CHOICES[0] });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => (await messages(work)).some((line) => line.role === "bot" && line.text === `QC1-B: Done with: ${CHOICES[0]}`));
  expect(told(ledger.id, "QC1-B"), "the envelope offered the card tool for set answers, by the name Claude calls it").toContain("ask it with mcp__ogb__ask_user, not show_widget");
  await until(async () => (await messages(inbox)).some((line) => line.text === "QC1-L-DONE: Ledger is done."));
  expect((await messages(work)).find((line) => line.id === row.id)!.card).toMatchObject({ answered: "answer", answeredText: CHOICES[0] });
  expect((await messages(inbox)).find((line) => line.id === copy.id)!.card, "the copy follows").toMatchObject({ answered: "answer" });
  expect(told(scout.id, "QC1-L-DONE")).toContain(`QC1-B: Done with: ${CHOICES[0]}`);
  expect(turns(scout.id).map((turn) => turn.planKey), "Scout is woken once, with the result").toEqual(["QC1-L", "QC1-L-DONE"]);
  expect(await questionsIn(inbox, QUESTION), "the question reaches Cleo once: the card's copy").toHaveLength(1);
  await until(idle);
}, hostTimeout(150_000));

it("takes Cleo's own words in Ledger's chat as the answer to the card Ledger waits on", async () => {
  script(scout.id, ...handOn("QC2"));
  script(ledger.id, askWithCard("QC2"));
  const sinceQC2 = Date.now();
  await say(scout, inbox, "QC2-JOB: Have Ledger apply the fix to the pricing page.");
  const { work, row } = await cardIn(sinceQC2, (card) => card.subtitle === QUESTION);
  const sent = await say(ledger, work, "Just the footer text, please");
  expect(sent.message, "her line is kept, under the card it answers").toMatchObject({ role: "user", text: "Just the footer text, please", replyToId: row.id });
  await until(async () => (await messages(work)).some((line) => line.role === "bot" && line.text === "QC2-B: Done with: Just the footer text, please"));
  expect((await messages(work)).find((line) => line.id === row.id)!.card).toMatchObject({ answered: "answer", answeredText: "Just the footer text, please" });
  await until(async () => (await messages(inbox)).some((line) => line.text === "QC2-L-DONE: Ledger is done."));
  expect((await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)!.card, "the copy follows").toMatchObject({ answered: "answer" });
  await until(idle);
}, hostTimeout(150_000));

it("turns Ledger's NEEDS INPUT question into the same card with a reply field, in its chat and in Cleo's inbox, and her reply there answers Ledger", async () => {
  script(scout.id, ...handOn("QC3"), { key: "QC3-L-ASKED", match: ["stopped on a question for", "[OpenMausBot question from @Ledger", "QC3-JOB"], reply: "QC3-L-ASKED" });
  script(ledger.id,
    { key: "QC3-B2", match: ["QC3-BRIEF", "The person answered"], reply: "QC3-B2: Done, the new footer text is in." },
    { key: "QC3-B", match: ["QC3-BRIEF"], reply: `Checked: the footer text still uses the old template.\nNEEDS INPUT: ${OPEN}` });
  const sinceQC3 = Date.now();
  await say(scout, inbox, "QC3-JOB: Have Ledger check the footer text on the pricing page.");
  const { work, row } = await cardIn(sinceQC3, (card) => card.subtitle === OPEN);
  expect(row.card).toMatchObject({ requestType: "question", options: [], requestId: expect.stringMatching(/^needs-input-/) });
  expect((await messages(work)).find((line) => line.role === "bot" && line.text?.startsWith("Checked"))!.text, "the line keeps its words, the card asks")
    .toBe("Checked: the footer text still uses the old template.");
  await until(async () => (await messages(inbox)).some((line) => line.card?.requestId === row.card!.requestId));
  const copy = (await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)!;
  expect(copy).toMatchObject({ kind: "options", card: { options: [], subtitle: OPEN }, inbox: { kind: "ask", from: { name: "Ledger" } } });
  await until(() => turns(scout.id).some((turn) => turn.planKey === "QC3-L-ASKED"));
  expect(told(scout.id, "QC3-L-ASKED")).toContain("do not repeat it to them or ask it again");
  expect((await messages(inbox)).some((line) => line.tool?.name.includes("needs your input")), "no chip beside the copy").toBe(false);
  expect((await questionsIn(inbox, OPEN)).filter((line) => line.role === "bot"), "the question reaches Cleo once: the card's copy").toHaveLength(1);

  const answered = await team.as(cleo, "POST", `/api/threads/${inbox}/respond`, { requestId: row.card!.requestId, behavior: "answer", message: "Short and friendly" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(() => turns(ledger.id).some((turn) => turn.planKey === "QC3-B2"));
  expect(told(ledger.id, "QC3-B2")).toContain('The person answered: \\"Short and friendly\\"');
  await until(async () => (await messages(inbox)).some((line) => line.text === "QC3-L-DONE: Ledger is done."));
  expect((await messages(work)).find((line) => line.id === row.id)!.card).toMatchObject({ answered: "answer", answeredText: "Short and friendly" });
  expect((await messages(inbox)).find((line) => line.id === copy.id)!.card, "the copy follows").toMatchObject({ answered: "answer" });
  await until(idle);
}, hostTimeout(150_000));

it("closes the open question as stopped when Cleo stops Ledger's work, in its chat and in her inbox", async () => {
  script(scout.id, ...handOn("QC4"), { key: "QC4-L-ASKED", match: ["stopped on a question for", "[OpenMausBot question from @Ledger", "QC4-JOB"], reply: "QC4-L-ASKED" });
  script(ledger.id, { key: "QC4-B", match: ["QC4-BRIEF"], reply: `Checked.\nNEEDS INPUT: ${OPEN}` });
  const sinceQC4 = Date.now();
  await say(scout, inbox, "QC4-JOB: Have Ledger check the welcome text.");
  const { work, row } = await cardIn(sinceQC4, (card) => card.subtitle === OPEN);
  await until(async () => (await messages(inbox)).some((line) => line.card?.requestId === row.card!.requestId));
  const stopped = await team.as(cleo, "POST", `/api/bots/${ledger.id}/interrupt`, { threadId: work });
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  await until(async () => (await messages(work)).find((line) => line.id === row.id)?.card?.stopped === true);
  await until(async () => (await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)?.card?.stopped === true);
  await until(idle);
}, hostTimeout(120_000));
