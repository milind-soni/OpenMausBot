import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { ENVELOPE_MARK } from "./runtime/envelope.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETTLED = "Your downstream room requests have settled.";
const REPORT_FROM_MIRA = "[OpenMausBot report from @Mira";
const RERUN_NOTE = "OpenMausBot restarted while your previous turn here was running";
const TEAMMATES_CUT = "A restart cut these teammates' turns";

const jsonl = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

type Row = Record<string, any>;
interface RuntimeDb {
  assignments: Row[];
  events: Array<{ assignmentId: string; kind: string; detail?: string }>;
}

function readRuntimeDb(dataDir: string): RuntimeDb {
  const path = join(dataDir, "runtime.db");
  if (!existsSync(path)) return { assignments: [], events: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const assignments = (db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all() as Array<{ json: string }>)
      .map((row) => JSON.parse(row.json) as Row);
    const events = (db.prepare("SELECT assignment_id, kind, detail FROM assignment_events ORDER BY id").all() as Array<{ assignment_id: string; kind: string; detail: string | null }>)
      .map((row) => ({ assignmentId: row.assignment_id, kind: row.kind, ...(row.detail == null ? {} : { detail: row.detail }) }));
    return { assignments, events };
  } finally {
    db.close();
  }
}

const chipText = (message: any): string => [message.tool?.name, message.tool?.output, message.text].filter(Boolean).join("\n");

async function scenario(test: (f: any) => Promise<void>) {
  const parentEnv: NodeJS.ProcessEnv = { ...process.env };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined, { scripted: true });
  const url = session.info.url;
  const dataDir = session.info.dataDir;
  let server: ChildProcess = session.child;
  let restarted = false;
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      const raw = await response.text();
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch {}
      return { status: response.status, body: parsed };
    };
    const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    const bot = async (name: string, section: string) => (await cli("new-bot", "--name", name, "--section", section)).bot;
    const clive = await bot("Clive", "Leadership");
    const mira = await bot("Mira", "Engineering");
    expect((await api("PATCH", `/api/bots/${clive.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true })).status).toBe(200);
    const planPath = join(dataDir, "room-plan.json");
    const plan: Record<string, { script: unknown[] }> = { [clive.id]: { script: [] }, [mira.id]: { script: [] } };
    const script = (botId: string, ...entries: unknown[]) => {
      (plan[botId] ??= { script: [] }).script.push(...entries);
      writeFileSync(planPath, JSON.stringify(plan));
    };
    writeFileSync(planPath, JSON.stringify(plan));

    const say = async (botId: string, threadId: string, text: string) => {
      const sent = await api("POST", `/api/bots/${botId}/messages`, { text, threadId });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      return sent.body;
    };
    const db = () => readRuntimeDb(dataDir);
    const roots = () => db().assignments.filter((row) => !row.parentId && row.assignee?.botId === clive.id);
    const children = () => db().assignments.filter((row) => row.parentId);
    const eventsOf = (id: string) => db().events.filter((event) => event.assignmentId === id);
    const turns = (botId?: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => !botId || turn.botId === botId);
    const turn = (key: string) => turns().find((candidate) => candidate.planKey === key);
    const own = (record: any): string => ownTurnText(record?.prompt);
    const body = (record: any): string => own(record).replace(/^\s*Current time when this message was sent:[^\n]*\n+/, "");
    const told = (record: any): string => `${record?.system ?? ""}\n${JSON.stringify(record?.prompt ?? "")}`;
    const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).body.messages ?? [];
    const chips = async (threadId: string, text: string) => (await messages(threadId)).filter((message) => chipText(message).includes(text));
    const said = async (threadId: string, text: string) => (await messages(threadId))
      .filter((message) => message.role === "bot" && message.kind === "text" && String(message.text).includes(text)).length;
    const final = async (threadId: string, text: string, timeout = 30_000) => {
      const ended = () => roots().find((row) => row.status === "failed" || row.status === "cancelled");
      await expect.poll(async () => (await said(threadId, text)) === 1 || ended() !== undefined, { timeout }).toBe(true);
      const root = ended();
      expect(await said(threadId, text), root ? `root ${root.status} (${root.outcome}): ${root.result}` : "").toBe(1);
    };
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const restart = async (signal: NodeJS.Signals) => {
      await waitForExit(server, { signal });
      const env = verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port));
      const log = openSync(session.info.logPath, "a", 0o600);
      server = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
      restarted = true;
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 30_000 }).toBe(true);
    };
    try {
      await test({ api, clive, mira, dataDir, script, say, db, roots, children, eventsOf, turns, turn, own, body, told, messages, chips, said, final,
        gate, open, ready, settle, restart });
    } catch (error) {
      // What the fakes were told and what the chats hold, for a failure that only says a poll never matched.
      const names: Record<string, string> = { [clive.id]: "Clive", [mira.id]: "Mira" };
      const summary = {
        turns: turns().map((record) => ({ bot: names[record.botId] ?? record.botId, planKey: record.planKey, unplanned: record.unplanned,
          resumed: record.resumed, threadId: record.threadId, own: own(record).slice(0, 700) })),
        assignments: db().assignments.map(({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, reportedAt }) =>
          ({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, reported: reportedAt !== undefined })),
        events: db().events,
        chief: (await messages(clive.activeTaskId).catch(() => [])).map((message) => ({ role: message.role, kind: message.kind, text: message.text, tool: message.tool?.name })),
      };
      console.error(`runtime coordination fixture state:\n${JSON.stringify(summary, null, 1)}`);
      throw error;
    }
    expect(turns().filter((record) => record.unplanned).map((record) => own(record).slice(0, 300))).toEqual([]);
  } finally {
    if (restarted) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("S1 assigns a teammate under the envelope and resumes the Chief once with the report", () => scenario(async (f) => {
  const request = "S1-JOB: have Mira export the invoices to CSV and own the result.";
  const brief = "S1-BRIEF: export the invoices to CSV and report the row count.";
  f.script(f.clive.id,
    { key: "C0", match: ["S1-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: brief } }], reply: "C0: Mira is on it." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA], reply: "S1-FINAL: Mira exported the invoices." });
  f.script(f.mira.id, { key: "M1", match: ["S1-BRIEF"], reply: "S1-RESULT: exported 42 rows to invoices.csv." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, request);

  await expect.poll(() => f.turns(f.mira.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["M1"]);
  const assignment = f.own(f.turn("M1"));
  expect(assignment).toContain(ENVELOPE_MARK);
  expect(assignment).toContain("Clive");
  expect(assignment).toContain(brief);
  await expect.poll(async () => (await f.messages(job)).filter((message: any) => message.tool?.name === "Mira replied").length, { timeout: 30_000 }).toBe(1);
  await f.final(job, "S1-FINAL", 45_000);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.turns(f.mira.id).map((record: any) => record.planKey)).toEqual(["M1"]);
  expect(f.turns(f.clive.id).map((record: any) => [record.planKey, record.resumed])).toEqual([["C0", false], ["C1", true]]);
  const resume = f.told(f.turn("C1"));
  expect(resume).toContain(SETTLED);
  expect(resume).toContain(REPORT_FROM_MIRA);
  expect(resume).toContain("S1-RESULT: exported 42 rows");
  expect((await f.messages(job)).filter((message: any) => message.tool?.name === "Mira replied")).toHaveLength(1);
  expect(existsSync(join(f.dataDir, "runtime.db"))).toBe(true);
  const { assignments } = f.db();
  expect(assignments).toHaveLength(2);
  const root = f.roots()[0];
  const child = f.children()[0];
  expect(root).toMatchObject({ status: "completed", outcome: "done", depth: 0, assignee: { botId: f.clive.id } });
  expect(child).toMatchObject({ status: "completed", outcome: "done", depth: 1, parentId: root.id, rootId: root.id,
    assignee: { botId: f.mira.id }, requester: { botId: f.clive.id, threadId: job }, brief, result: "S1-RESULT: exported 42 rows to invoices.csv." });
  expect(child.reportedAt).toEqual(expect.any(Number));
  expect(f.eventsOf(root.id).map((event: any) => event.kind)).toEqual(expect.arrayContaining(["enqueued", "settled"]));
  expect(f.eventsOf(child.id).map((event: any) => event.kind)).toEqual(expect.arrayContaining(["enqueued", "started", "settled", "reported"]));
}), hostTimeout(60_000));

it("S2 parks a teammate on NEEDS INPUT, passes her question to the Chief once, carries the person's answer into her next turn, and resumes the Chief with the result", () => scenario(async (f) => {
  const brief = "S2-BRIEF: tag the release in the repository and report the tag.";
  f.script(f.clive.id,
    { key: "C0", match: ["S2-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: brief } }], reply: "C0: Mira is tagging it." },
    { key: "C-ASKED", match: ["stopped on a question for", "[OpenMausBot question from @Mira", "which repository?"], reply: "C-ASKED: Mira needs the repository." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA], reply: "S2-FINAL: the release is tagged." });
  f.script(f.mira.id,
    { key: "M2", match: ["S2-BRIEF", "The person answered"], reply: "S2-RESULT: tagged v1.2.0 in the main repository." },
    { key: "M1", match: ["S2-BRIEF"], reply: "I can tag it once I know where.\nNEEDS INPUT: which repository?" });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "S2-JOB: have Mira tag the release and own the result.");

  await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("needs_input");
  const parked = f.children()[0];
  expect(parked).toMatchObject({ status: "needs_input", question: expect.stringContaining("which repository?") });
  expect(parked.outcome).toBeUndefined();
  const work = parked.assignee.destination.threadId as string;
  expect(work).not.toBe(f.mira.activeTaskId);
  await expect.poll(async () => (await f.chips(job, "needs your input")).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  expect((await f.chips(job, "needs your input")).some((message: any) => chipText(message).includes("which repository?"))).toBe(true);
  await expect.poll(async () => await f.said(job, "C-ASKED: Mira needs the repository.") === 1 && f.roots()[0]?.status === "waiting", { timeout: 30_000 }).toBe(true);
  const chiefTurns = () => (f.turns(f.clive.id) as Array<{ planKey?: string; resumed?: boolean }>).map((record) => [record.planKey, record.resumed]);
  expect(chiefTurns()).toEqual([["C0", false], ["C-ASKED", false]]);

  await f.say(f.mira.id, work, "the main one");
  await expect.poll(() => f.turns(f.mira.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["M1", "M2"]);
  expect(f.turns(f.mira.id).map((record: any) => record.threadId)).toEqual([work, work]);
  const answered = f.own(f.turn("M2"));
  expect(answered).toContain(ENVELOPE_MARK);
  expect(answered).toContain('The person answered: "the main one"');
  await f.final(job, "S2-FINAL", 45_000);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.turns(f.mira.id).map((record: any) => record.planKey)).toEqual(["M1", "M2"]);
  expect(chiefTurns()).toEqual([["C0", false], ["C-ASKED", false], ["C1", true]]);
  expect(f.told(f.turn("C1"))).not.toContain("[OpenMausBot question from @Mira");
  expect(f.told(f.turn("C1"))).toContain(REPORT_FROM_MIRA);
  expect(f.told(f.turn("C1"))).toContain("S2-RESULT: tagged v1.2.0");
  expect(f.children()[0]).toMatchObject({ status: "completed", outcome: "done", executions: 2 });
  expect(f.children()[0].answer).toBeUndefined();
  expect(f.children()[0].question).toBeUndefined();
  expect(f.eventsOf(parked.id).map((event: any) => event.kind)).toEqual(expect.arrayContaining(["parked", "answered", "settled", "reported"]));
  expect((await f.messages(job)).filter((message: any) => message.tool?.name === "Mira replied")).toHaveLength(1);
}), hostTimeout(60_000));

it("S2b resumes the Chief once with a parked question, keeps one question chip across a restart and names the parked thread as waiting on the person", () => scenario(async (f) => {
  const brief = "S2B-BRIEF: tag the release in the repository and report the tag.";
  f.script(f.clive.id,
    { key: "C0", match: ["S2B-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: brief } }], reply: "C0: Mira is tagging it." },
    { key: "C-ASKED", match: ["stopped on a question for", "[OpenMausBot question from @Mira", "which repository?"], reply: "C-ASKED: Mira needs the repository." });
  f.script(f.mira.id, { key: "M1", match: ["S2B-BRIEF"], reply: "I can tag it once I know where.\nNEEDS INPUT: which repository?" });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "S2B-JOB: have Mira tag the release and own the result.");
  await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("needs_input");
  const parked = f.children()[0];
  const work = parked.assignee.destination.threadId as string;
  await expect.poll(async () => (await f.chips(job, "needs your input")).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => await f.said(job, "C-ASKED: Mira needs the repository.") === 1 && f.roots()[0]?.status === "waiting", { timeout: 30_000 }).toBe(true);

  const unread = async (botId: string, threadId: string) => ((await f.api("GET", "/api/bots?messages=0")).body.bots as any[])
    .find((bot) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId)?.unread === true;
  expect((await f.api("POST", `/api/bots/${f.clive.id}/read`, { threadId: job })).status).toBe(200);
  expect((await f.api("POST", `/api/bots/${f.mira.id}/read`, { threadId: work })).status).toBe(200);
  await f.restart("SIGTERM");
  await expect.poll(() => f.eventsOf(parked.id).some((event: any) => event.kind === "restart_reconciled"), { timeout: 15_000 }).toBe(true);
  await f.settle(500);
  expect(f.children()[0]).toMatchObject({ status: "needs_input", question: expect.stringContaining("which repository?") });
  expect((f.turns(f.clive.id) as Array<{ planKey?: string }>).filter((record) => record.planKey === "C-ASKED")).toHaveLength(1);
  const resumes = (f.eventsOf(f.roots()[0].id) as Array<{ kind: string; detail?: string }>).filter((event) => event.kind === "resume_due");
  expect(resumes.map((event) => event.detail)).toEqual(["resume: a teammate asks"]);
  expect(await f.chips(job, "needs your input")).toHaveLength(1);
  expect(await unread(f.clive.id, job)).toBe(false);
  expect(await unread(f.mira.id, work)).toBe(false);

  const check = (await f.api("POST", `/api/bots/${f.clive.id}/tasks`, { title: "Check on Mira" })).body.task.threadId as string;
  f.script(f.clive.id, { key: "C1", match: ["S2B-CHECK"], reply: "C1: checked.", steps: [
    { tool: "list_threads", arguments: {} },
    { tool: "close_thread", arguments: { thread_id: work }, expectError: true },
  ] });
  await f.say(f.clive.id, check, "S2B-CHECK: how is Mira's tagging going?");
  await expect.poll(() => f.turn("C1")?.evidence?.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const [listed, refused] = f.turn("C1").evidence.slice(-2).map((entry: any) => entry.response.result.content[0].text as string);
  expect(listed).toMatch(new RegExp(`\\(on @Mira, waiting on the person\\) \\[thread id: ${work}\\]`));
  expect(refused).toContain("waiting on the person's answer");
}), hostTimeout(90_000));

it("S3 runs a cut teammate turn again once after a restart and resumes the Chief with the report", () => scenario(async (f) => {
  const brief = "S3-BRIEF: run the migration and report.";
  f.script(f.clive.id,
    { key: "C0", match: ["S3-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: brief } }], reply: "C0: Mira is migrating." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA], reply: "S3-FINAL: migrated after the restart." });
  // The rerun is the more specific entry and sits first, so the cut turn (which may leave no evidence) never swallows it.
  f.script(f.mira.id,
    { key: "M-RERUN", match: ["S3-BRIEF", RERUN_NOTE], reply: "S3-RESULT: migration applied once." },
    { key: "M-CUT", match: ["S3-BRIEF"], readyFile: f.ready("mira"), gateFile: f.gate("mira"), reply: "never" });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "S3-JOB: have Mira run the migration and own the result.");
  await expect.poll(() => existsSync(f.ready("mira")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => f.children()[0]?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("waiting");
  const cut = f.children()[0];

  await f.restart("SIGTERM");
  f.open("mira");

  await expect.poll(() => f.turns(f.mira.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["M-RERUN"]);
  const rerun = f.body(f.turn("M-RERUN")).trimStart();
  expect(rerun.startsWith(RERUN_NOTE), rerun.slice(0, 300)).toBe(true);
  expect(rerun.indexOf(RERUN_NOTE)).toBeLessThan(rerun.indexOf(ENVELOPE_MARK));
  await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("completed");
  const child = f.children()[0];
  expect(child.id).toBe(cut.id);
  expect(child).toMatchObject({ status: "completed", outcome: "done", restarts: 1, executions: 2, result: "S3-RESULT: migration applied once." });
  expect(f.eventsOf(child.id).some((event: any) => event.kind === "restart_reconciled")).toBe(true);
  await f.final(job, "S3-FINAL", 45_000);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  await f.settle(500);
  expect(f.turns(f.mira.id).map((record: any) => record.planKey)).toEqual(["M-RERUN"]);
  expect(f.turns(f.clive.id).map((record: any) => [record.planKey, record.resumed])).toEqual([["C0", false], ["C1", true]]);
  const resume = f.told(f.turn("C1"));
  expect(resume).toContain(REPORT_FROM_MIRA);
  expect(resume).toContain("S3-RESULT: migration applied once.");
  const root = f.roots()[0];
  const rootHeard = resume.includes(TEAMMATES_CUT)
    || f.eventsOf(root.id).some((event: any) => event.kind === "restart_reconciled" && /teammates/.test(event.detail ?? ""));
  expect(rootHeard, `resume prompt: ${resume.slice(0, 400)}; root events: ${JSON.stringify(f.eventsOf(root.id))}`).toBe(true);
  expect(root).toMatchObject({ status: "completed", outcome: "done" });
  expect((await f.messages(job)).filter((message: any) => message.tool?.name === "Mira replied")).toHaveLength(1);
}), hostTimeout(90_000));

it("S4 cancels queued work and the Chief's record when the person stops the conversation, and resumes nothing", () => scenario(async (f) => {
  expect((await f.api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
  f.script(f.clive.id,
    { key: "C0", match: ["S4-JOB"], steps: [{ arguments: { bot_ids: [f.mira.id], message: "S4-BRIEF: audit the dependencies and report." } }], reply: "C0: Mira will audit." },
    { key: "C1", match: [SETTLED], reply: "S4-FINAL: never" });
  f.script(f.mira.id,
    { key: "M-HOLD", match: ["S4-HOLD"], readyFile: f.ready("hold"), gateFile: f.gate("hold"), reply: "S4-HELD: released." },
    { key: "M-AUDIT", match: ["S4-BRIEF"], reply: "S4-RESULT: never" });
  // Mira's standing conversation holds her one slot.
  await f.say(f.mira.id, f.mira.activeTaskId, "S4-HOLD: keep working on this until released.");
  await expect.poll(() => existsSync(f.ready("hold")), { timeout: 30_000 }).toBe(true);
  try {
    const job = f.clive.activeTaskId;
    await f.say(f.clive.id, job, "S4-JOB: have Mira audit the dependencies and own the result.");
    await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("queued");
    await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("waiting");
    await f.settle(500);
    expect(f.children()[0]).toMatchObject({ status: "queued", executions: 0 });

    expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
    await expect.poll(() => f.children()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
    expect(f.children()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 0 });
    await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
    expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(f.eventsOf(f.children()[0].id).map((event: any) => event.kind)).toContain("cancelled");

    f.open("hold");
    await expect.poll(() => f.turns(f.mira.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["M-HOLD"]);
    await f.settle(1_500);
    expect(f.turns(f.mira.id).map((record: any) => record.planKey)).toEqual(["M-HOLD"]);
    expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
    expect(await f.said(job, "S4-FINAL")).toBe(0);
    expect((await f.messages(job)).filter((message: any) => message.tool?.name === "Mira replied")).toHaveLength(0);
    expect(f.children()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 0 });
    expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped" });
  } finally {
    f.open("hold");
  }
}), hostTimeout(60_000));
