// A teammate's question as a card on a Team Cloud, end to end (docs/team-cloud.md "One inbox per person"): Philipp asks
// Luchs, his Chief, whose chat is his inbox, to have Biber fix something. Biber asks a decision with set answers through
// the synthetic Claude CLI's real ask_user server; the card is in Biber's chat and its copy in Philipp's inbox has the
// same choices; a tap there, or his own words in Biber's chat, answers Biber, who carries on with that answer, and Luchs
// hears the result once. Biber's NEEDS INPUT question becomes the same card with a reply field. Philipp is never sent a
// question twice. It proves where things land, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const PHILIPP = { email: "philipp@acme.test", role: "owner" as const };
const QUESTION = "Soll ich den Fix für die Sondervariante umsetzen?";
const CHOICES = ["Ja, nur den Abschlusstext", "Ja, auch den Einladungstext", "Nein"];
const OPEN = "Welche Formulierung soll der neue Abschlusstext bekommen?";
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
let philipp = "";
let luchs: Bot, biber: Bot;
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
const messages = async (threadId: string) => ((await team.as(philipp, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Row[];
const bots = async () => (await team.as(philipp, "GET", "/api/bots")).body.bots as Bot[];
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
  const sent = await team.as(philipp, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return sent.body as { message?: Row };
}
/** The question card a job's turn asks with, once it is there: an open one since `since`, in the work Luchs handed Biber. */
async function cardIn(since: number, match: (card: Card) => boolean): Promise<{ work: string; row: Row }> {
  let found: { work: string; row: Row } | undefined;
  const handed = async () => ((await bots()).find((bot) => bot.id === biber.id)!.tasks ?? []).filter((task) => task.openedBy?.botId === luchs.id);
  await until(async () => {
    for (const { threadId: work } of await handed()) {
      const row = (await messages(work)).find((one) => one.card && match(one.card) && !one.card.answered && one.at >= since);
      if (row) found = { work, row };
    }
    return Boolean(found);
  }).catch(async (error: Error) => {
    const seen = await Promise.all((await handed()).map(async (task) => ({ task: task.title, rows: (await messages(task.threadId)).slice(-4).map((row) => [row.role, row.kind, row.text?.slice(0, 80), row.card?.answered]) })));
    throw new Error(`${error.message}: ${JSON.stringify({ seen, luchs: turns(luchs.id).map((turn) => turn.planKey), biber: turns(biber.id).map((turn) => turn.planKey) })}`);
  });
  return found!;
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-qc", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  writeFileSync(file("room-plan.json"), "{}");
  philipp = (await team.pair(PHILIPP)).token!;
  const create = async (body: Record<string, unknown>) => {
    const created = await team.as(philipp, "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  luchs = await create({ name: "Luchs", reportsTo: PHILIPP.email });
  expect((await team.as(philipp, "PATCH", `/api/bots/${luchs.id}`, { chiefOfStaff: true })).status).toBe(200);
  biber = await create({ name: "Biber", reportsTo: PHILIPP.email });
  const opened = await team.as(philipp, "POST", `/api/bots/${luchs.id}/tasks`, { title: "Philipp und Luchs" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  inbox = opened.body.task.threadId as string;
  frames = listen(philipp);
  await new Promise((resolve) => setTimeout(resolve, 500));
}, hostTimeout(180_000));

afterAll(async () => {
  for (const stream of streams) stream.abort();
  await fx?.close();
});

const brief = (job: string) => `${job}-BRIEF: Setz den Fix für die Sondervariante um, als Branch fix/natural-greenery-custom-case, mit PR nach develop.`;
const handOn = (job: string) => [
  { key: `${job}-L`, match: [`${job}-JOB`], steps: [{ arguments: { bot_ids: [biber.id], message: brief(job) } }], reply: `${job}-L: Biber setzt den Fix um.` },
  { key: `${job}-L-DONE`, match: [SETTLED, `${job}-JOB`], reply: `${job}-L-DONE: Biber ist fertig.` },
];
const askWithCard = (job: string) => ({ key: `${job}-B`, match: [`${job}-BRIEF`], timeoutMs: 120_000,
  steps: [{ server: "ogb", tool: "ask_user", arguments: { question: QUESTION, choices: CHOICES }, capture: { answer: "([\\s\\S]+)" } }],
  reply: `${job}-B: Umgesetzt mit: {{answer}}` });

it("asks Philipp a decision with set answers as a card in Biber's chat and a copy in his inbox, and a tap there answers Biber, who carries on", async () => {
  script(luchs.id, ...handOn("QC1"));
  script(biber.id, askWithCard("QC1"));
  const sinceQC1 = Date.now();
  await say(luchs, inbox, "QC1-JOB: Lass Biber den Fix für die Sondervariante umsetzen.");
  const { work, row } = await cardIn(sinceQC1, (card) => card.subtitle === QUESTION);
  expect(row.card).toMatchObject({ requestType: "question", options: CHOICES });

  await until(async () => (await messages(inbox)).some((line) => line.card?.requestId === row.card!.requestId));
  expect((await bots()).find((bot) => bot.id === luchs.id)!.tasks!.find((task) => task.inbox)?.threadId, "Philipp's chat with Luchs is his inbox").toBe(inbox);
  const copy = (await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)!;
  expect(copy).toMatchObject({ kind: "options", card: { options: CHOICES, requestType: "question" }, inbox: { kind: "ask", from: { name: "Biber" }, origin: { threadId: work } } });
  const listed = (await team.as(philipp, "GET", "/api/inbox")).body as { rows: Array<{ id: string; tab: string; card?: Card }> };
  expect(listed.rows.find((line) => line.id === copy.id)).toMatchObject({ tab: "needs-you", card: { options: CHOICES } });
  await until(() => questionsNotified(inbox).length === 1);
  expect(questionsNotified(inbox)[0]!.notification).toMatchObject({ botId: luchs.id, title: "Biber has a question" });
  expect(frames.filter((frame) => frame.kind === "notify" && frame.notification?.botId === biber.id), "one notification, from the inbox").toEqual([]);
  expect((await messages(inbox)).some((line) => line.tool?.name.startsWith("Waiting on your answer")), "no chip beside the copy").toBe(false);

  const answered = await team.as(philipp, "POST", `/api/threads/${inbox}/respond`, { requestId: row.card!.requestId, behavior: "answer", message: CHOICES[0] });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(async () => (await messages(work)).some((line) => line.role === "bot" && line.text === `QC1-B: Umgesetzt mit: ${CHOICES[0]}`));
  expect(told(biber.id, "QC1-B"), "the envelope offered the card tool for set answers").toContain("ask it with ask_user, not show_widget");
  await until(async () => (await messages(inbox)).some((line) => line.text === "QC1-L-DONE: Biber ist fertig."));
  expect((await messages(work)).find((line) => line.id === row.id)!.card).toMatchObject({ answered: "answer", answeredText: CHOICES[0] });
  expect((await messages(inbox)).find((line) => line.id === copy.id)!.card, "the copy follows").toMatchObject({ answered: "answer" });
  expect(told(luchs.id, "QC1-L-DONE")).toContain(`QC1-B: Umgesetzt mit: ${CHOICES[0]}`);
  expect(turns(luchs.id).map((turn) => turn.planKey), "Luchs is woken once, with the result").toEqual(["QC1-L", "QC1-L-DONE"]);
  expect(await questionsIn(inbox, QUESTION), "the question reaches Philipp once: the card's copy").toHaveLength(1);
  await until(idle);
}, hostTimeout(150_000));

it("takes Philipp's own words in Biber's chat as the answer to the card Biber waits on", async () => {
  script(luchs.id, ...handOn("QC2"));
  script(biber.id, askWithCard("QC2"));
  const sinceQC2 = Date.now();
  await say(luchs, inbox, "QC2-JOB: Lass Biber den Fix für die Sondervariante umsetzen.");
  const { work, row } = await cardIn(sinceQC2, (card) => card.subtitle === QUESTION);
  const sent = await say(biber, work, "Nur den Abschlusstext, bitte");
  expect(sent.message, "his line is kept, under the card it answers").toMatchObject({ role: "user", text: "Nur den Abschlusstext, bitte", replyToId: row.id });
  await until(async () => (await messages(work)).some((line) => line.role === "bot" && line.text === "QC2-B: Umgesetzt mit: Nur den Abschlusstext, bitte"));
  expect((await messages(work)).find((line) => line.id === row.id)!.card).toMatchObject({ answered: "answer", answeredText: "Nur den Abschlusstext, bitte" });
  await until(async () => (await messages(inbox)).some((line) => line.text === "QC2-L-DONE: Biber ist fertig."));
  expect((await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)!.card, "the copy follows").toMatchObject({ answered: "answer" });
  await until(idle);
}, hostTimeout(150_000));

it("turns Biber's NEEDS INPUT question into the same card with a reply field, in its chat and in Philipp's inbox, and his reply there answers Biber", async () => {
  script(luchs.id, ...handOn("QC3"), { key: "QC3-L-ASKED", match: ["stopped on a question for", "[OpenMausBot question from @Biber", "QC3-JOB"], reply: "QC3-L-ASKED" });
  script(biber.id,
    { key: "QC3-B2", match: ["QC3-BRIEF", "The person answered"], reply: "QC3-B2: Erledigt, der neue Abschlusstext steht." },
    { key: "QC3-B", match: ["QC3-BRIEF"], reply: `Geprüft: der Abschlusstext nutzt noch die alte Vorlage.\nNEEDS INPUT: ${OPEN}` });
  const sinceQC3 = Date.now();
  await say(luchs, inbox, "QC3-JOB: Lass Biber den Abschlusstext der Sondervariante prüfen.");
  const { work, row } = await cardIn(sinceQC3, (card) => card.subtitle === OPEN);
  expect(row.card).toMatchObject({ requestType: "question", options: [], requestId: expect.stringMatching(/^needs-input-/) });
  expect((await messages(work)).find((line) => line.role === "bot" && line.text?.startsWith("Geprüft"))!.text, "the line keeps its words, the card asks")
    .toBe("Geprüft: der Abschlusstext nutzt noch die alte Vorlage.");
  await until(async () => (await messages(inbox)).some((line) => line.card?.requestId === row.card!.requestId));
  const copy = (await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)!;
  expect(copy).toMatchObject({ kind: "options", card: { options: [], subtitle: OPEN }, inbox: { kind: "ask", from: { name: "Biber" } } });
  await until(() => turns(luchs.id).some((turn) => turn.planKey === "QC3-L-ASKED"));
  expect(told(luchs.id, "QC3-L-ASKED")).toContain("do not repeat it to them or ask it again");
  expect((await messages(inbox)).some((line) => line.tool?.name.includes("needs your input")), "no chip beside the copy").toBe(false);
  expect((await questionsIn(inbox, OPEN)).filter((line) => line.role === "bot"), "the question reaches Philipp once: the card's copy").toHaveLength(1);

  const answered = await team.as(philipp, "POST", `/api/threads/${inbox}/respond`, { requestId: row.card!.requestId, behavior: "answer", message: "Kurz und freundlich" });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await until(() => turns(biber.id).some((turn) => turn.planKey === "QC3-B2"));
  expect(told(biber.id, "QC3-B2")).toContain('The person answered: \\"Kurz und freundlich\\"');
  await until(async () => (await messages(inbox)).some((line) => line.text === "QC3-L-DONE: Biber ist fertig."));
  expect((await messages(work)).find((line) => line.id === row.id)!.card).toMatchObject({ answered: "answer", answeredText: "Kurz und freundlich" });
  expect((await messages(inbox)).find((line) => line.id === copy.id)!.card, "the copy follows").toMatchObject({ answered: "answer" });
  await until(idle);
}, hostTimeout(150_000));

it("closes the open question as stopped when Philipp stops Biber's work, in its chat and in his inbox", async () => {
  script(luchs.id, ...handOn("QC4"), { key: "QC4-L-ASKED", match: ["stopped on a question for", "[OpenMausBot question from @Biber", "QC4-JOB"], reply: "QC4-L-ASKED" });
  script(biber.id, { key: "QC4-B", match: ["QC4-BRIEF"], reply: `Geprüft.\nNEEDS INPUT: ${OPEN}` });
  const sinceQC4 = Date.now();
  await say(luchs, inbox, "QC4-JOB: Lass Biber den Einladungstext prüfen.");
  const { work, row } = await cardIn(sinceQC4, (card) => card.subtitle === OPEN);
  await until(async () => (await messages(inbox)).some((line) => line.card?.requestId === row.card!.requestId));
  const stopped = await team.as(philipp, "POST", `/api/bots/${biber.id}/interrupt`, { threadId: work });
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  await until(async () => (await messages(work)).find((line) => line.id === row.id)?.card?.stopped === true);
  await until(async () => (await messages(inbox)).find((line) => line.card?.requestId === row.card!.requestId)?.card?.stopped === true);
  await until(idle);
}, hostTimeout(120_000));
