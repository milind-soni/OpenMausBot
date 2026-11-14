// What a Chief sends a teammate that already has its work goes into that work, on one server of the person's own with the
// scripted fake engine (docs/runtime-contract.md §2 and §9). Clive, a Chief of Staff, hands Mira work. A question Mira ends
// on comes back to Clive, and Clive's reply to her thread, in any later turn and without naming the question, answers it:
// a NEEDS INPUT question and the card her ask tool waits on alike. A correction Clive sends while Mira works reaches her
// running turn, and Clive can send a follow-up to one particular thread he opened on her. Each time Mira's one result
// still comes back once, and no second job starts. A question Mira asks the person in their own chat with her Clive may
// answer for them there, as her Chief; a bot that is not her Chief may not. It proves where things land, not a model's
// judgement.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

const SETTLED = "Your downstream room requests have settled.";
const REPORT_FROM_MIRA = "[OpenMausBot report from @Mira";
const QUESTION_FROM_MIRA = "[OpenMausBot question from @Mira";

type Row = Record<string, any>;
const jsonl = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

function assignments(dataDir: string): Row[] {
  const path = join(dataDir, "runtime.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all() as Array<{ json: string }>).map((row) => JSON.parse(row.json) as Row);
  } finally {
    db.close();
  }
}

async function scenario(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      const raw = await response.text();
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch {}
      return { status: response.status, body: parsed };
    };
    const bot = async (name: string, section: string) => ((await runControlOmb(["new-bot", "--name", name, "--section", section, "--url", url])) as any).bot;
    const clive = await bot("Clive", "Leadership");
    const mira = await bot("Mira", "Engineering");
    expect((await api("PATCH", `/api/bots/${clive.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true })).status).toBe(200);
    const planPath = join(dataDir, "room-plan.json");
    const plan: Record<string, { script: unknown[] }> = { [clive.id]: { script: [] }, [mira.id]: { script: [] } };
    const script = (botId: string, ...entries: unknown[]) => {
      plan[botId]!.script.push(...entries);
      writeFileSync(planPath, JSON.stringify(plan));
    };
    writeFileSync(planPath, JSON.stringify(plan));
    const askMeFirst = async () => {
      for (const id of [clive.id, mira.id]) expect((await api("PATCH", `/api/bots/${id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
    };
    const say = async (botId: string, threadId: string, text: string) => {
      const sent = await api("POST", `/api/bots/${botId}/messages`, { text, threadId });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    };
    const roots = () => assignments(dataDir).filter((row) => !row.parentId && row.assignee?.botId === clive.id);
    const children = () => assignments(dataDir).filter((row) => row.parentId);
    const turns = (botId: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => turn.botId === botId);
    const keys = (botId: string) => turns(botId).map((turn) => turn.planKey);
    const turn = (key: string) => jsonl(`${planPath}.evidence.jsonl`).find((candidate) => candidate.planKey === key);
    const told = (key: string): string => { const record = turn(key); return `${record?.system ?? ""}\n${ownTurnText(record?.prompt)}`; };
    /** All a turn was given, its launch instructions and notes included. */
    const given = (key: string): string => { const record = turn(key); return `${record?.system ?? ""}\n${JSON.stringify(record?.prompt ?? "")}`; };
    /** What each coordinate_bots step of a turn got back: its receipts, or a refusal's words. */
    const replies = (key: string): any[] => (turn(key)?.evidence ?? []).filter((entry: any) => entry?.step && !entry.step.tool)
      .map((entry: any) => { const text = String(entry.response.result.content[0].text); return entry.response.result.isError ? text : JSON.parse(text); });
    const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).body.messages ?? [];
    const said = async (threadId: string, text: string) => (await messages(threadId))
      .filter((message) => message.role === "bot" && message.kind === "text" && String(message.text).includes(text)).length;
    const tasks = async (botId: string): Promise<any[]> => ((await api("GET", "/api/bots?messages=0")).body.bots as any[]).find((one) => one.id === botId)?.tasks ?? [];
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    try {
      await test({ api, clive, mira, job: clive.activeTaskId as string, script, askMeFirst, say, roots, children, turns, keys, turn, told, given, replies,
        messages, said, tasks, gate, open, ready });
    } catch (error) {
      const names: Record<string, string> = { [clive.id]: "Clive", [mira.id]: "Mira" };
      console.error(`teammate follow-ups fixture state:\n${JSON.stringify({
        turns: jsonl(`${planPath}.evidence.jsonl`).map((record) => ({ bot: names[record.botId] ?? record.botId, planKey: record.planKey, unplanned: record.unplanned,
          threadId: record.threadId, own: ownTurnText(record.prompt).slice(0, 500) })),
        assignments: assignments(dataDir).map(({ id, parentId, status, outcome, executions, result, question, assignee }) =>
          ({ id, parentId, status, outcome, executions, result, question, threadId: assignee?.destination?.threadId })),
      }, null, 1)}`);
      throw error;
    }
    expect(turns(clive.id).concat(turns(mira.id)).filter((record) => record.unplanned).map((record) => ownTurnText(record.prompt).slice(0, 300))).toEqual([]);
  } finally {
    await session.close();
  }
}

it("Q1 takes Clive's later reply to Mira's thread as the answer to the question her work waits on, not as new work", () => scenario(async (f) => {
  await f.askMeFirst();
  f.script(f.clive.id,
    { key: "C0", match: ["Q1-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Q1-BRIEF: tag the release and report the tag." } }], reply: "C0: Mira is tagging it." },
    { key: "C-ASKED", match: [QUESTION_FROM_MIRA, "which repository?"], reply: "C-ASKED: Mira asks which repository; I asked you." },
    { key: "C-REPLY", match: ["Q1-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "the main one" } }], reply: "C-REPLY: passed on." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA], reply: "Q1-FINAL: the release is tagged." });
  f.script(f.mira.id,
    { key: "M2", match: ["Q1-BRIEF", "@Clive answered"], reply: "Q1-RESULT: tagged v1.2.0 in the main repository." },
    { key: "M1", match: ["Q1-BRIEF"], reply: "I can tag it once I know where.\nNEEDS INPUT: which repository?" });
  await f.say(f.clive.id, f.job, "Q1-JOB: have Mira tag the release.");
  await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("needs_input");
  await expect.poll(async () => await f.said(f.job, "C-ASKED") === 1 && f.roots()[0]?.status === "waiting", { timeout: 30_000 }).toBe(true);
  const work = f.children()[0].assignee.destination.threadId as string;

  await f.say(f.clive.id, f.job, "Q1-SAG: tell Mira it is the main one.");
  await expect.poll(() => f.keys(f.mira.id), { timeout: 30_000 }).toEqual(["M1", "M2"]);
  expect(f.told("M2")).toContain('@Clive answered: "the main one".');
  expect(f.turns(f.mira.id).map((record: any) => record.threadId)).toEqual([work, work]);
  const [sent] = f.replies("C-REPLY");
  expect(sent.receipts).toEqual([expect.objectContaining({ outcome: "injected", threadId: work, requestId: f.children()[0].id,
    detail: expect.stringContaining('answered its question "which repository?"') })]);
  await expect.poll(async () => await f.said(f.job, "Q1-FINAL"), { timeout: 30_000 }).toBe(1);
  expect(f.children(), "the reply started no second job").toHaveLength(1);
  expect(f.children()[0]).toMatchObject({ status: "completed", executions: 2, result: "Q1-RESULT: tagged v1.2.0 in the main repository." });
  expect(f.keys(f.clive.id)).toEqual(["C0", "C-ASKED", "C-REPLY", "C1"]);
  const card = (await f.messages(work)).find((message: any) => message.card?.requestId?.startsWith("needs-input-"))?.card;
  expect(card).toMatchObject({ answered: "answer", answeredText: "the main one", answeredBy: { kind: "bot", name: "Clive" } });
  expect((await f.messages(f.job)).filter((message: any) => message.tool?.name === "Answered Mira's question")).toHaveLength(1);
}), hostTimeout(90_000));

it("Q2 takes Clive's reply to Mira's thread as the answer to the card her ask tool waits on, and her turn carries on with it", () => scenario(async (f) => {
  await f.askMeFirst();
  const question = "Should the fix cover only the footer text?";
  f.script(f.clive.id,
    { key: "C0", match: ["Q2-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Q2-BRIEF: apply the fix to the pricing page." } }], reply: "C0: Mira is on it." },
    { key: "C-REPLY", match: ["Q2-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Only the footer text" } }], reply: "C-REPLY: passed on." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA], reply: "Q2-FINAL: the fix is in." });
  f.script(f.mira.id, { key: "M1", match: ["Q2-BRIEF"], timeoutMs: 90_000,
    steps: [{ server: "ogb", tool: "ask_user", arguments: { question, choices: ["Only the footer text", "The footer and the welcome text"] }, capture: { answer: "([\\s\\S]+)" } }],
    reply: "Q2-RESULT: done with {{answer}}" });
  await f.say(f.clive.id, f.job, "Q2-JOB: have Mira apply the fix.");
  await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("running");
  const work = f.children()[0].assignee.destination.threadId as string;
  await expect.poll(async () => (await f.messages(work)).some((message: any) => message.card?.subtitle === question && !message.card.answered), { timeout: 30_000 }).toBe(true);

  await f.say(f.clive.id, f.job, "Q2-SAG: tell Mira only the footer text.");
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C0", "C-REPLY"]);
  expect(f.given("C-REPLY"), "Clive's next turn hears what Mira asks").toContain("stopped on its question in that teammate's thread");
  expect(f.given("C-REPLY")).toContain(question);
  await expect.poll(async () => (await f.messages(work)).some((message: any) => message.role === "bot" && String(message.text).startsWith("Q2-RESULT")), { timeout: 30_000 }).toBe(true);
  expect((await f.messages(work)).find((message: any) => String(message.text).startsWith("Q2-RESULT")).text).toContain("Only the footer text");
  const [sent] = f.replies("C-REPLY");
  expect(sent.receipts).toEqual([expect.objectContaining({ outcome: "injected", threadId: work, detail: expect.stringContaining(`answered its question "${question}"`) })]);
  expect((await f.messages(work)).find((message: any) => message.card?.subtitle === question).card).toMatchObject({ answered: "answer", answeredBy: { kind: "bot", name: "Clive" } });
  await expect.poll(async () => await f.said(f.job, "Q2-FINAL"), { timeout: 30_000 }).toBe(1);
  expect(f.children(), "the reply started no second job").toHaveLength(1);
  expect(f.children()[0]).toMatchObject({ status: "completed", executions: 1 });
}), hostTimeout(120_000));

it("F1 hands Clive's correction to the turn Mira is running for him, and her one result carries it", () => scenario(async (f) => {
  f.script(f.clive.id,
    { key: "C0", match: ["F1-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "F1-BRIEF: export the invoices to CSV." } }], reply: "C0: Mira is exporting." },
    { key: "C-MORE", match: ["F1-MORE"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "F1-ADD: also include the tax column." } }], reply: "C-MORE: told Mira." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA], reply: "F1-FINAL: exported with the tax column." });
  f.script(f.mira.id, { key: "M1", match: ["F1-BRIEF"], readyFile: f.ready("mira"), gateFile: f.gate("mira"), echoSteered: true, reply: "F1-RESULT: exported 42 rows." });
  try {
    await f.say(f.clive.id, f.job, "F1-JOB: have Mira export the invoices.");
    await expect.poll(() => existsSync(f.ready("mira")), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("waiting");
    const work = f.children()[0].assignee.destination.threadId as string;

    await f.say(f.clive.id, f.job, "F1-MORE: tell Mira to include the tax column too.");
    await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C0", "C-MORE"]);
    const [sent] = f.replies("C-MORE");
    expect(sent.receipts).toEqual([expect.objectContaining({ outcome: "injected", threadId: work, requestId: f.children()[0].id })]);
    expect(f.children(), "the correction started no second job").toHaveLength(1);
    expect((await f.messages(work)).filter((message: any) => message.peerAsk?.name === "Clive" && message.text === "F1-ADD: also include the tax column.")).toHaveLength(1);

    f.open("mira");
    await expect.poll(async () => await f.said(f.job, "F1-FINAL"), { timeout: 30_000 }).toBe(1);
    expect(f.keys(f.mira.id)).toEqual(["M1"]);
    expect(f.children()[0]).toMatchObject({ status: "completed", executions: 1, result: expect.stringContaining("F1-ADD: also include the tax column.") });
    expect(f.told("C1")).toContain("F1-ADD");
  } finally {
    f.open("mira");
  }
}), hostTimeout(90_000));

it("F2 sends Clive's follow-up to the one thread he names, among those he opened on Mira, and its result comes back to him", () => scenario(async (f) => {
  f.script(f.clive.id,
    { key: "C0", match: ["F2-JOB"], steps: [
      { arguments: { bot_ids: [f.mira.id], message: "F2-A-BRIEF: draft report A.", thread: "new", title: "Report A" } },
      { arguments: { bot_ids: [f.mira.id], message: "F2-B-BRIEF: draft report B.", thread: "new", title: "Report B" } }], reply: "C0: two reports under way." },
    { key: "C1", match: [SETTLED, "F2-JOB"], reply: "F2-DRAFTS: both reports are drafted." });
  f.script(f.mira.id,
    { key: "MA", match: ["F2-A-BRIEF"], reply: "F2-A-RESULT: report A drafted." },
    { key: "MB", match: ["F2-B-BRIEF"], reply: "F2-B-RESULT: report B drafted." });
  await f.say(f.clive.id, f.job, "F2-JOB: have Mira draft reports A and B.");
  await expect.poll(async () => await f.said(f.job, "F2-DRAFTS"), { timeout: 30_000 }).toBe(1);
  const threadA = (await f.tasks(f.mira.id)).find((task: any) => task.title === "Report A")!.threadId as string;
  const before = (await f.tasks(f.mira.id)).length;

  f.script(f.clive.id,
    { key: "C-MORE", match: ["F2-MORE"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "F2-A-MORE: add a chart to report A.", thread: threadA } }], reply: "C-MORE: sent." },
    { key: "C2", match: [SETTLED, "F2-MORE"], reply: "F2-FINAL: report A has its chart." });
  f.script(f.mira.id, { key: "MA2", match: ["F2-A-MORE"], reply: "F2-A-MORE-RESULT: chart added to report A." });
  await f.say(f.clive.id, f.job, "F2-MORE: have Mira add a chart to report A.");
  await expect.poll(async () => await f.said(f.job, "F2-FINAL"), { timeout: 30_000 }).toBe(1);
  expect(f.turn("MA2").threadId, "the follow-up ran in the thread Clive named").toBe(threadA);
  expect((await f.tasks(f.mira.id)).length, "no thread was opened for it").toBe(before);
  const [sent] = f.replies("C-MORE");
  expect(sent.receipts).toEqual([expect.objectContaining({ outcome: "queued", threadId: threadA })]);
  expect(f.told("C2")).toContain("F2-A-MORE-RESULT: chart added to report A.");
}), hostTimeout(90_000));

it("F4 keeps a second assignment Clive hands Mira in the same turn its own job, though the first is already running", () => scenario(async (f) => {
  f.script(f.clive.id,
    { key: "C0", match: ["F4-JOB"], steps: [
      { arguments: { bot_ids: [f.mira.id], message: "F4-A-BRIEF: export the invoices." } },
      { delayMs: 2_000, arguments: { bot_ids: [f.mira.id], message: "F4-B-BRIEF: export the receipts." } }], reply: "C0: two exports under way." },
    { key: "C1", match: [SETTLED, "F4-JOB"], reply: "F4-FINAL: both are exported." });
  f.script(f.mira.id,
    { key: "MA", match: ["F4-A-BRIEF"], readyFile: f.ready("mira"), gateFile: f.gate("mira"), reply: "F4-A-RESULT: invoices exported." },
    { key: "MB", match: ["F4-B-BRIEF"], reply: "F4-B-RESULT: receipts exported." });
  try {
    await f.say(f.clive.id, f.job, "F4-JOB: have Mira export the invoices and the receipts.");
    await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C0"]);
    expect(existsSync(f.ready("mira")), "the first was running when the second was sent").toBe(true);
    expect(f.replies("C0").map((sent: any) => sent.receipts[0].outcome)).toEqual(["queued", "queued"]);
    expect(f.children().map((row: any) => [row.brief, row.status])).toEqual([["F4-A-BRIEF: export the invoices.", "running"], ["F4-B-BRIEF: export the receipts.", "queued"]]);
    f.open("mira");
    await expect.poll(async () => await f.said(f.job, "F4-FINAL"), { timeout: 30_000 }).toBe(1);
    expect(f.keys(f.mira.id)).toEqual(["MA", "MB"]);
  } finally {
    f.open("mira");
  }
}), hostTimeout(90_000));

const PERSON_QUESTION = "Keep the old pricing page as a backup?";
const askThePerson = (f: any, key: string) => f.script(f.mira.id, { key: "M1", match: [key], timeoutMs: 90_000,
  steps: [{ server: "ogb", tool: "ask_user", arguments: { question: PERSON_QUESTION, choices: ["Keep it", "Delete it"] }, capture: { answer: "([\\s\\S]+)" } }],
  reply: `${key}-RESULT: done with {{answer}}` });
const asking = async (f: any, chat: string) => (await f.messages(chat)).find((message: any) => message.card?.subtitle === PERSON_QUESTION)?.card;

it("P1 lets Clive, as Mira's Chief, answer for the person the question she asks them in their own chat, and her turn carries on with it", () => scenario(async (f) => {
  await f.askMeFirst();
  const chat = f.mira.activeTaskId as string;
  askThePerson(f, "P1");
  f.script(f.clive.id, { key: "C-ANSWER", match: ["P1-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Keep it", thread: chat } }], reply: "C-ANSWER: answered Mira for you." });
  await f.say(f.mira.id, chat, "P1: redo the pricing page.");
  await expect.poll(async () => { const card = await asking(f, chat); return Boolean(card) && !card.answered; }, { timeout: 30_000 }).toBe(true);

  await f.say(f.clive.id, f.job, "P1-SAG: tell Mira to keep it.");
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C-ANSWER"]);
  expect(f.given("C-ANSWER"), "Clive's turn lists what Mira waits on the person for").toContain("Teammates you manage wait on the person's answer");
  expect(f.given("C-ANSWER")).toContain(chat);
  expect(f.given("C-ANSWER")).toContain(PERSON_QUESTION);
  const [sent] = f.replies("C-ANSWER");
  expect(sent.receipts).toEqual([expect.objectContaining({ outcome: "injected", threadId: chat, detail: expect.stringContaining(`answered its question "${PERSON_QUESTION}" for the person`) })]);
  await expect.poll(async () => (await f.messages(chat)).some((message: any) => message.role === "bot" && String(message.text).startsWith("P1-RESULT")), { timeout: 30_000 }).toBe(true);
  const result = (await f.messages(chat)).find((message: any) => String(message.text).startsWith("P1-RESULT")).text as string;
  expect(result).toContain("@Clive answered for the person");
  expect(result).toContain("Keep it");
  expect(await asking(f, chat)).toMatchObject({ answered: "answer", answeredText: "Keep it", answeredBy: { kind: "bot", name: "Clive" } });
  expect(f.children(), "no work was handed out").toEqual([]);
  expect(f.keys(f.mira.id)).toEqual(["M1"]);
}), hostTimeout(120_000));

it("P2 refuses the person's chat with Mira to a bot that is not her Chief, and her question stays the person's", () => scenario(async (f) => {
  await f.askMeFirst();
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { chiefOfStaff: false })).status).toBe(200);
  const chat = f.mira.activeTaskId as string;
  askThePerson(f, "P2");
  f.script(f.clive.id, { key: "C0", match: ["P2-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Keep it", thread: chat }, expectError: true }], reply: "C0: refused." });
  await f.say(f.mira.id, chat, "P2: redo the pricing page.");
  await expect.poll(async () => (await asking(f, chat)) !== undefined, { timeout: 30_000 }).toBe(true);

  await f.say(f.clive.id, f.job, "P2-SAG: tell Mira to keep it.");
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C0"]);
  expect(f.given("C0")).not.toContain("Teammates you manage wait on the person's answer");
  expect(f.replies("C0")).toEqual([`"${chat}" is not a thread you opened on Mira: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`]);
  expect((await asking(f, chat))?.answered).toBeUndefined();
  expect(f.children()).toEqual([]);
}), hostTimeout(90_000));

it("P3 lets the person replace Clive's answer: the card shows theirs, and Mira gets it in a new turn", () => scenario(async (f) => {
  await f.askMeFirst();
  const chat = f.mira.activeTaskId as string;
  askThePerson(f, "P3");
  f.script(f.clive.id, { key: "C-ANSWER", match: ["P3-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Keep it", thread: chat } }], reply: "C-ANSWER: answered Mira for you." });
  f.script(f.mira.id, { key: "M2", match: ["Delete it"], reply: "M2: deleted it instead." });
  await f.say(f.mira.id, chat, "P3: redo the pricing page.");
  await expect.poll(async () => { const card = await asking(f, chat); return Boolean(card) && !card.answered; }, { timeout: 30_000 }).toBe(true);
  await f.say(f.clive.id, f.job, "P3-SAG: tell Mira to keep it.");
  await expect.poll(async () => f.said(chat, "P3-RESULT"), { timeout: 30_000 }).toBe(1);

  const { requestId } = await asking(f, chat);
  const changed = await f.api("POST", `/api/threads/${chat}/respond`, { requestId, behavior: "answer", message: "Delete it" });
  expect(changed.status, JSON.stringify(changed.body)).toBeLessThan(300);
  await expect.poll(() => f.keys(f.mira.id), { timeout: 30_000 }).toEqual(["M1", "M2"]);
  await expect.poll(async () => f.said(chat, "M2: deleted it instead."), { timeout: 30_000 }).toBe(1);
  const card = await asking(f, chat);
  expect(card).toMatchObject({ answered: "answer", answeredText: "Delete it" });
  expect(card.answeredBy?.kind).not.toBe("bot");
  expect(f.children(), "no work was handed out").toEqual([]);
}), hostTimeout(120_000));

it("P4 keeps Mira's question from a Clive turn a webhook started: it is not listed, the thread is refused, and it stays the person's", () => scenario(async (f) => {
  await f.askMeFirst();
  const chat = f.mira.activeTaskId as string;
  askThePerson(f, "P4");
  f.script(f.clive.id, { key: "C-HOOK", match: ["P4-HOOK"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Keep it", thread: chat }, expectError: true }], reply: "C-HOOK: refused." });
  await f.say(f.mira.id, chat, "P4: redo the pricing page.");
  await expect.poll(async () => (await asking(f, chat)) !== undefined, { timeout: 30_000 }).toBe(true);

  const hook = await f.api("POST", "/api/webhooks", { name: "P4", prompt: "P4-HOOK: tell Mira to keep it.", botId: f.clive.id, runOn: "maus" });
  expect(hook.status, JSON.stringify(hook.body)).toBe(201);
  const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(delivered.status).toBe(202);
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C-HOOK"]);
  expect(f.given("C-HOOK")).not.toContain("Teammates you manage wait on the person's answer");
  expect(f.replies("C-HOOK")).toEqual([`"${chat}" is not a thread you opened on Mira: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`]);
  expect((await asking(f, chat))?.answered).toBeUndefined();
  expect(f.children()).toEqual([]);
}), hostTimeout(90_000));

it("P5 does not take a message that names other work as the answer to Mira's question to the person", () => scenario(async (f) => {
  await f.askMeFirst();
  const chat = f.mira.activeTaskId as string;
  askThePerson(f, "P5");
  f.script(f.clive.id, { key: "C-ANSWERS", match: ["P5-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Keep it", thread: chat, answers: "no-such-work" }, expectError: true }], reply: "C-ANSWERS: refused." });
  await f.say(f.mira.id, chat, "P5: redo the pricing page.");
  await expect.poll(async () => (await asking(f, chat)) !== undefined, { timeout: 30_000 }).toBe(true);

  await f.say(f.clive.id, f.job, "P5-SAG: answer the other job.");
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C-ANSWERS"]);
  expect(f.replies("C-ANSWERS")).toEqual([`"${chat}" is not a thread you opened on Mira: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`]);
  expect((await asking(f, chat))?.answered).toBeUndefined();
}), hostTimeout(90_000));

it("P6 does not take a one-way notice as the answer to Mira's question to the person", () => scenario(async (f) => {
  await f.askMeFirst();
  const chat = f.mira.activeTaskId as string;
  askThePerson(f, "P6");
  f.script(f.clive.id, { key: "C-NOTICE", match: ["P6-SAG"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "Keep it", thread: chat, reply: "none" }, expectError: true }], reply: "C-NOTICE: refused." });
  await f.say(f.mira.id, chat, "P6: redo the pricing page.");
  await expect.poll(async () => (await asking(f, chat)) !== undefined, { timeout: 30_000 }).toBe(true);

  await f.say(f.clive.id, f.job, "P6-SAG: let Mira know.");
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C-NOTICE"]);
  expect((await asking(f, chat))?.answered).toBeUndefined();
}), hostTimeout(90_000));

it("F3 refuses a thread Clive did not open on Mira, saying where thread ids come from", () => scenario(async (f) => {
  f.script(f.clive.id, { key: "C0", match: ["F3-JOB"], steps: [
    { arguments: { bot_ids: [f.mira.id], message: "F3-BRIEF: look at this.", thread: f.mira.activeTaskId }, expectError: true }], reply: "C0: refused." });
  await f.say(f.clive.id, f.job, "F3-JOB: have Mira look at this in her own chat.");
  await expect.poll(() => f.keys(f.clive.id), { timeout: 30_000 }).toEqual(["C0"]);
  const [refused] = f.replies("C0");
  expect(refused).toBe(`"${f.mira.activeTaskId}" is not a thread you opened on Mira: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`);
  expect(f.children()).toEqual([]);
}), hostTimeout(60_000));
