import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import type { RoutineRunReport } from "../shared/routines.ts";
import { automationContextText, createAutomationReports, newestAutomationLines, readRunReply, recoveredText } from "./automation-reports.ts";
import { DATA_DIR } from "./config.ts";
import type { RoutineRun } from "./routines.ts";
import { Store, type BotRecord, type Message } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("readRunReply", () => {
  it.each(["NOTHING NEW", "Nothing new.", "**NOTHING NEW**", "Checked 14 emails.\n\nNOTHING NEW", "  nothing new  "])("keeps %j quiet", (text) => {
    expect(readRunReply(text)).toEqual({ quiet: true });
  });

  it("reports anything else, including a sentence that only mentions nothing new", () => {
    expect(readRunReply("Acme replied about the order.")).toEqual({ quiet: false, text: "Acme replied about the order." });
    expect(readRunReply("There is nothing new from Acme, but Bob wrote twice.")).toMatchObject({ quiet: false });
  });

  it("is quiet when a run said nothing at all, unless it attached something", () => {
    expect(readRunReply("  ")).toEqual({ quiet: true });
    expect(readRunReply("", true)).toEqual({ quiet: false, text: "" });
  });

  it("turns a NEEDS INPUT line into the question the person answers", () => {
    expect(readRunReply("I drafted a reply to Acme.\nNEEDS INPUT: Should I send it?")).toEqual({
      quiet: false, text: "I drafted a reply to Acme.\nShould I send it?", question: "Should I send it?",
    });
  });
});

describe("what the chat's own session reads", () => {
  it("names and dates each line as the automation's own", () => {
    const line = { routineId: "r1", runId: "run", name: "Inbox brief", trigger: "schedule" as const, executionThreadId: "x", scheduledFor: 0 };
    expect(automationContextText(line, Date.UTC(2026, 9, 21, 9, 0), "Acme replied.")).toMatch(/^\[Your automation "Inbox brief" reported at 2026-10-21 \d\d:\d\d:\]\nAcme replied\.$/);
    expect(automationContextText({ ...line, needsYou: true }, 0, "Send it?")).toContain('"Inbox brief" asked at');
    expect(automationContextText({ ...line, failed: true }, 0, "Signed out.")).toContain('"Inbox brief" could not finish at');
    expect(automationContextText({ ...line, recovered: true }, 0, "Recovered.")).toContain('"Inbox brief" recovered at');
  });

  it("always carries the newest line of each automation", () => {
    const line = (id: string, routineId: string) => ({ id, automation: { routineId, runId: id, name: routineId, trigger: "schedule" as const, executionThreadId: "x", scheduledFor: 0 } });
    expect([...newestAutomationLines([line("a1", "a"), { id: "talk" }, line("b1", "b"), line("a2", "a")])].sort()).toEqual(["a2", "b1"]);
  });
});

/** A real Store; the routine runs live in a stand-in for the RoutineManager, which keeps their report states. */
function fixture() {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Pepper" });
  const main = bot.threadId;
  const runs = new Map<string, RoutineRun>();
  const busy = new Set<string>();
  const notified: Array<{ kind: string; threadId: string; detail: string }> = [];
  const wrote: string[] = [];
  const routines = {
    listRuns: () => [...runs.values()].map((run) => ({ ...run })).reverse(),
    noteReport: (id: string, report: RoutineRunReport | undefined) => {
      const run = runs.get(id);
      if (!run) return null;
      if (report) run.report = report;
      else delete run.report;
      return { ...run };
    },
    runForThread: (threadId: string) => {
      const run = [...runs.values()].findLast((candidate) => candidate.threadId === threadId);
      return run ? { ...run } : null;
    },
  };
  let manager: typeof routines | null = routines;
  const create = () => createAutomationReports({
    store, routines: () => manager, busy: (_botId, threadId) => busy.has(threadId),
    wrote: (_bot: BotRecord, threadId) => wrote.push(threadId),
    notify: (kind, _bot, threadId, detail) => notified.push({ kind, threadId, detail }),
  });
  const reports = create();
  let serial = 0;
  /** One run of an automation, finished in its own hidden conversation with `said` as its last reply. */
  const finished = (said: string | null, name = "Inbox brief", extra: Partial<RoutineRun> = {}) => {
    const id = `run-${++serial}`;
    const threadId = store.createTask(bot.id, `${name} run`, false)!.threadId;
    store.patchTask(bot.id, threadId, { routineRunId: id });
    if (said !== null) store.appendMessage(threadId, { role: "bot", kind: "text", text: said, turnId: `turn-${id}`, turnTerminal: true });
    const run: RoutineRun = {
      id, routineId: `routine-${name}`, routineName: name, target: "bot", botId: bot.id, runOn: "maus", scheduledFor: Date.now(),
      status: "completed", manual: false, triggerSource: "schedule", threadId, resultsThreadId: main, createdAt: Date.now(), ...extra,
    };
    runs.set(id, run);
    return run;
  };
  const lines = () => store.messagesFor(main).filter((message) => message.automation);
  const greeting = new Set(store.messagesFor(main).map((message) => message.id));
  /** Everything written into the chat since the bot said hello. */
  const added = () => store.messagesFor(main).filter((message) => !greeting.has(message.id));
  return {
    store, bot, main, runs, busy, notified, wrote, reports, finished, lines, added, create,
    offline: () => { manager = null; },
    online: () => { manager = routines; },
  };
}

describe("automation reports", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("writes a run's reply into the chat it reports to as one bot line named after the automation", () => {
    const f = fixture();
    const run = f.finished("Acme replied about the order.");
    f.store.patchTask(f.bot.id, f.main, { unread: false });
    f.reports.runSettled(run, `turn-${run.id}`);
    expect(f.store.taskByThread(f.bot.id, f.main)?.unread, "the chat it reports to shows unread").toBe(true);
    expect(f.lines()).toEqual([expect.objectContaining({
      role: "bot", kind: "text", text: "Acme replied about the order.",
      automation: { routineId: "routine-Inbox brief", runId: run.id, name: "Inbox brief", trigger: "schedule", executionThreadId: run.threadId, scheduledFor: run.scheduledFor },
    })]);
    expect(f.runs.get(run.id)!.report).toEqual({ state: "posted", threadId: f.main, messageId: f.lines()[0]!.id });
    expect(f.wrote).toEqual([f.main]);
    expect(f.notified).toEqual([{ kind: "done", threadId: f.main, detail: "Inbox brief: Acme replied about the order." }]);
    expect(f.store.messagesFor(f.main).some((message) => message.kind === "routine.run")).toBe(false);
  });

  it("writes nothing, marks nothing and notifies nobody for a run with nothing new", () => {
    const f = fixture();
    const run = f.finished("Checked 14 emails.\nNOTHING NEW");
    f.store.patchTask(f.bot.id, f.main, { unread: false });
    f.reports.runSettled(run, `turn-${run.id}`);
    expect(f.added()).toEqual([]);
    expect(f.store.taskByThread(f.bot.id, f.main)?.unread).toBe(false);
    expect(f.runs.get(run.id)!.report).toEqual({ state: "quiet" });
    expect(f.wrote).toEqual([]);
    expect(f.notified).toEqual([]);
  });

  it("asks the person in the chat, as a normal line they can answer, when the run needs them", () => {
    const f = fixture();
    const run = f.finished("I drafted a reply to Acme.\nNEEDS INPUT: Should I send it?");
    f.reports.runSettled(run, `turn-${run.id}`);
    expect(f.lines()).toEqual([expect.objectContaining({ kind: "text", text: "I drafted a reply to Acme.\nShould I send it?", automation: expect.objectContaining({ needsYou: true }) })]);
    expect(f.notified).toEqual([{ kind: "question", threadId: f.main, detail: "Inbox brief: Should I send it?" }]);
  });

  it("reports the last reply of the turn that finished the run, not an earlier progress note", () => {
    const f = fixture();
    const run = f.finished("Looking at the inbox now.");
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "text", text: "Two new orders from Acme.", turnId: "final" });
    f.reports.runSettled(run, "final");
    expect(f.lines().map((line) => line.text)).toEqual(["Two new orders from Acme."]);
  });

  it("holds a report while a turn runs in the chat and writes it once, right after that turn", () => {
    const f = fixture();
    f.busy.add(f.main);
    const run = f.finished("Acme replied.");
    f.reports.runSettled(run, `turn-${run.id}`);
    f.reports.flush();
    expect(f.lines()).toEqual([]);
    expect(f.runs.get(run.id)!.report).toEqual({ state: "pending" });
    expect(f.notified).toEqual([]);
    f.busy.delete(f.main);
    f.reports.flush();
    expect(f.lines().map((line) => line.text)).toEqual(["Acme replied."]);
    f.reports.flush();
    f.reports.runSettled(f.runs.get(run.id)!, `turn-${run.id}`);
    expect(f.lines()).toHaveLength(1);
    expect(f.notified).toHaveLength(1);
  });

  it("leaves a run that began before reports existed to the status card it already has", () => {
    const f = fixture();
    const run = f.finished("Acme replied.");
    const card = f.store.appendMessage(f.main, { role: "bot", kind: "routine.run", text: "Routine “Inbox brief” completed", routineRun: { runId: run.id, routineId: run.routineId, routineName: run.routineName, status: "completed" } });
    f.reports.runSettled(run, `turn-${run.id}`);
    expect(f.lines()).toEqual([]);
    expect(f.runs.get(run.id)!.report).toEqual({ state: "posted", threadId: f.main, messageId: card.id });
    expect(f.notified).toEqual([]);
  });

  it("writes reports that waited on the same chat in the order their runs finished", () => {
    const f = fixture();
    f.busy.add(f.main);
    for (const said of ["First result.", "Second result.", "Third result."]) {
      const run = f.finished(said, `Watch ${said.split(" ")[0]}`);
      f.reports.runSettled(run, `turn-${run.id}`);
    }
    f.busy.delete(f.main);
    f.reports.flush();
    expect(f.lines().map((line) => line.text)).toEqual(["First result.", "Second result.", "Third result."]);
  });

  it("writes a report that was still waiting when the server stopped once, after it starts again", () => {
    const f = fixture();
    f.busy.add(f.main);
    const run = f.finished("Acme replied.");
    f.reports.runSettled(run, `turn-${run.id}`);
    f.busy.delete(f.main);
    const restarted = f.create();
    restarted.flush();
    expect(f.lines().map((line) => line.text)).toEqual(["Acme replied."]);
    f.runs.get(run.id)!.report = { state: "pending" };
    f.create().flush();
    expect(f.lines()).toHaveLength(1);
    expect(f.runs.get(run.id)!.report).toMatchObject({ state: "posted", messageId: f.lines()[0]!.id });
  });

  it("says once in the chat that a run failed, and stays out of chats a run does not report to", () => {
    const f = fixture();
    const failed = f.finished(null, "Inbox brief", { status: "failed", error: "Signed out" });
    f.reports.runFailed(failed, "This bot's engine is signed out. Sign in again in Settings → Model providers.");
    expect(f.lines()).toEqual([expect.objectContaining({
      text: "This run didn't finish: This bot's engine is signed out. Sign in again in Settings → Model providers.",
      automation: expect.objectContaining({ failed: true }),
    })]);
    expect(f.notified).toEqual([]);
    f.reports.runFailed(f.runs.get(failed.id)!, "again");
    const joined = f.finished("Picked up where I stopped.", "Continue", { threadId: f.main });
    f.reports.runSettled(joined);
    const nowhere = f.finished("Done.", "Orphan", { resultsThreadId: undefined });
    f.reports.runSettled(nowhere, `turn-${nowhere.id}`);
    const quietly = f.finished("NOTHING NEW", "Orphan", { resultsThreadId: undefined });
    f.reports.runSettled(quietly, `turn-${quietly.id}`);
    expect(f.lines()).toHaveLength(1);
    expect(f.notified.map((entry) => entry.threadId)).toEqual([f.main, nowhere.threadId]);
  });

  it("posts one recovered line when a run with nothing new follows a failed run, and stays quiet after that", () => {
    const f = fixture();
    const failed = f.finished(null, "Inbox brief", { status: "failed", error: "Timed out" });
    f.reports.runFailed(failed, "it ran past its 25-minute limit.");
    const finishedAt = Date.UTC(2026, 9, 26, 2, 40);
    const ok = f.finished("Checked 14 emails.\nNOTHING NEW", "Inbox brief", { finishedAt });
    f.reports.runSettled(ok, `turn-${ok.id}`);
    for (let i = 0; i < 3; i++) {
      const later = f.finished("NOTHING NEW");
      f.reports.runSettled(later, `turn-${later.id}`);
      expect(f.runs.get(later.id)!.report).toEqual({ state: "quiet" });
    }
    expect(f.lines().map((line) => [line.text, line.automation?.runId, line.automation?.failed, line.automation?.recovered])).toEqual([
      ["This run didn't finish: it ran past its 25-minute limit.", failed.id, true, undefined],
      [recoveredText("Inbox brief", finishedAt), ok.id, undefined, true],
    ]);
    expect(f.runs.get(ok.id)!.report).toEqual({ state: "posted", threadId: f.main, messageId: f.lines()[1]!.id });
    expect(f.wrote).toEqual([f.main, f.main]);
    expect(f.notified).toEqual([]);
  });

  it("says when a recovered run finished, in the host's clock", () => {
    expect(recoveredText("PAC flow driver", Date.UTC(2026, 9, 26, 2, 40))).toMatch(/^Recovered: PAC flow driver finished OK at \d{1,2}:\d\d [AP]M \S+$/);
  });

  it("posts no recovered line after another automation's failure, nor for a run with something to say, which posts only its reply", () => {
    const f = fixture();
    const other = f.finished(null, "Ops sweep", { status: "failed" });
    f.reports.runFailed(other, "");
    const quiet = f.finished("NOTHING NEW");
    f.reports.runSettled(quiet, `turn-${quiet.id}`);
    const failed = f.finished(null, "Inbox brief", { status: "failed" });
    f.reports.runFailed(failed, "");
    const spoke = f.finished("Acme replied.");
    f.reports.runSettled(spoke, `turn-${spoke.id}`);
    const after = f.finished("NOTHING NEW");
    f.reports.runSettled(after, `turn-${after.id}`);
    expect(f.lines().map((line) => line.text)).toEqual(["This run didn't finish.", "This run didn't finish.", "Acme replied."]);
    expect(f.lines().some((line) => line.automation?.recovered)).toBe(false);
  });

  it("still recovers when a card a later run copied into the chat came after the failure", () => {
    const f = fixture();
    const failed = f.finished(null, "Inbox brief", { status: "failed" });
    f.reports.runFailed(failed, "");
    const run = f.finished(null, "Inbox brief", { status: "running" });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which?", options: ["A"], requestId: "ask-1", requestType: "question" } });
    f.runs.get(run.id)!.status = "completed";
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "text", text: "NOTHING NEW", turnId: "last", turnTerminal: true });
    f.reports.runSettled(f.runs.get(run.id)!, "last");
    expect(f.lines().map((line) => line.automation?.recovered ?? line.automation?.failed ?? line.automation?.needsYou)).toEqual([true, true, true]);
    expect(f.lines().at(-1)!.text).toMatch(/^Recovered: Inbox brief finished OK at /);
  });

  it("recovers from a failure of an overlapping run queued behind this run's own card copy", () => {
    const f = fixture();
    f.busy.add(f.main);
    const slow = f.finished(null, "Inbox brief", { status: "running" });
    f.store.appendMessage(slow.threadId!, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which?", options: ["A"], requestId: "ask-1", requestType: "question" } });
    const failed = f.finished(null, "Inbox brief", { status: "failed" });
    f.reports.runFailed(failed, "");
    f.runs.get(slow.id)!.status = "completed";
    f.store.appendMessage(slow.threadId!, { role: "bot", kind: "text", text: "NOTHING NEW", turnId: "last", turnTerminal: true });
    f.reports.runSettled(f.runs.get(slow.id)!, "last");
    f.busy.delete(f.main);
    f.reports.flush();
    expect(f.lines().map((line) => [line.automation?.runId, line.kind, line.automation?.failed ?? false, line.automation?.recovered ?? false])).toEqual([
      [slow.id, "options", false, false], [failed.id, "text", true, false], [slow.id, "text", false, true],
    ]);
  });

  it("recovers after a failure that is still waiting on a busy chat, in order, and after a restart", () => {
    const f = fixture();
    f.busy.add(f.main);
    const failed = f.finished(null, "Inbox brief", { status: "failed" });
    f.reports.runFailed(failed, "");
    const ok = f.finished("NOTHING NEW");
    f.reports.runSettled(ok, `turn-${ok.id}`);
    const failedAgain = f.finished(null, "Inbox brief", { status: "failed" });
    f.reports.runFailed(failedAgain, "");
    expect(f.runs.get(ok.id)!.report).toEqual({ state: "pending" });
    f.busy.delete(f.main);
    f.reports.flush();
    expect(f.lines().map((line) => [line.automation?.runId, line.automation?.failed ?? false, line.automation?.recovered ?? false])).toEqual([
      [failed.id, true, false], [ok.id, false, true], [failedAgain.id, true, false],
    ]);
    const quiet = f.finished("NOTHING NEW");
    f.runs.get(quiet.id)!.report = { state: "pending" };
    f.create().flush();
    expect(f.lines().at(-1)).toMatchObject({ automation: { runId: quiet.id, recovered: true } });
    expect(f.lines()).toHaveLength(4);
  });

  it("copies a card the run waits on into the chat, routes the answer to the run, and keeps the copy in step", () => {
    const f = fixture();
    const run = f.finished(null, "Inbox brief", { status: "running" });
    const card = { title: "Your bot has a question", subtitle: "Which account?", options: ["Work", "Home"], requestId: "ask-1", requestType: "question" as const };
    const original = f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card });
    const copy = f.store.messagesFor(f.main).find((message) => message.card?.requestId === "ask-1");
    expect(copy).toMatchObject({ kind: "options", card, automation: expect.objectContaining({ runId: run.id, needsYou: true, executionThreadId: run.threadId }) });
    expect(f.reports.answeredIn(f.main, "ask-1")).toBe(run.threadId);
    expect(f.reports.answeredIn(f.main, "other")).toBe(f.main);
    expect(f.reports.answeredIn(run.threadId!, "ask-1")).toBe(run.threadId);
    f.store.patchMessage(run.threadId!, original.id, { card: { ...card, answered: "answer", answeredText: "Work" } });
    expect(f.store.messagesFor(f.main).find((message) => message.id === copy!.id)?.card).toEqual({ ...card, answered: "answer", answeredText: "Work" });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card: { ...card, requestId: "ask-2", answered: "allow" } });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card: { ...card, requestId: "ask-3", autoApplied: true } });
    expect(f.store.messagesFor(f.main).filter((message) => message.kind === "options")).toHaveLength(1);
  });

  it("names a sign-in, connection or credential card the run waits on, and stops saying it needs the person once that card settles", () => {
    const f = fixture();
    const run = f.finished(null, "Dashboard check", { status: "running" });
    const signIn = f.store.appendMessage(run.threadId!, { role: "bot", kind: "signin", text: "Sign in", signIn: { url: "https://example.com", site: "example.com", place: "browser", reason: "the dashboard is behind a login" } });
    const connect = f.store.appendMessage(run.threadId!, { role: "bot", kind: "connector", connector: { slug: "gmail", label: "Gmail", description: "", status: "required", resumeKey: "resume-key-1" } });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "secret", secret: { target: "xaiApiKey", label: "xAI API key", description: "", placeholder: "", helpUrl: "", requestKey: "secret-1" } });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "signin", text: "Sign in", signIn: { url: "https://done.example", site: "done.example", place: "browser", done: true } });
    expect(f.lines().map((line) => [line.text, line.automation?.needsYou, line.automation?.copyOf])).toEqual([
      ["I need you to sign in to example.com: the dashboard is behind a login.", true, signIn.id],
      ["I need you to connect Gmail.", true, connect.id],
      ["I need your xAI API key.", true, expect.any(String)],
    ]);
    expect(f.wrote).toEqual([f.main, f.main, f.main]);
    f.store.patchMessage(run.threadId!, signIn.id, { signIn: { ...signIn.signIn!, done: true } });
    f.store.patchMessage(run.threadId!, connect.id, { connector: { ...connect.connector!, status: "authorizing" } });
    expect(f.lines().map((line) => line.automation?.needsYou)).toEqual([undefined, true, true]);
    f.store.patchMessage(run.threadId!, connect.id, { connector: { ...connect.connector!, status: "connected" } });
    expect(f.lines().map((line) => line.automation?.needsYou)).toEqual([undefined, undefined, true]);
    f.runs.get(run.id)!.status = "completed";
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "text", text: "The dashboard looks fine.", turnId: "last", turnTerminal: true });
    f.reports.runSettled(f.runs.get(run.id)!, "last");
    expect(f.lines().at(-1)).toMatchObject({ text: "The dashboard looks fine.", automation: { runId: run.id } });
    expect(f.lines().at(-1)?.automation).not.toHaveProperty("copyOf");
  });

  it("copies a card into a busy chat only after its turn, and not at all once it was answered elsewhere", () => {
    const f = fixture();
    const run = f.finished(null, "Inbox brief", { status: "running" });
    f.busy.add(f.main);
    const card = { title: "Approval needed", subtitle: "Send the reply", options: ["Allow", "Deny"], requestId: "ask-1", requestType: "permission" as const, tool: "Gmail" };
    const first = f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card: { ...card, requestId: "ask-2" } });
    expect(f.added()).toEqual([]);
    f.store.patchMessage(run.threadId!, first.id, { card: { ...card, answered: "allow" } });
    f.busy.delete(f.main);
    f.reports.flush();
    expect(f.added().map((message) => message.card?.requestId)).toEqual(["ask-2"]);
  });

  it("does not copy cards from a conversation the person took over", () => {
    const f = fixture();
    const run = f.finished(null, "Inbox brief", { status: "running" });
    f.store.patchTask(f.bot.id, run.threadId!, { routineRunId: undefined });
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which?", options: [], requestId: "ask-1", requestType: "question" } });
    expect(f.added()).toEqual([]);
  });

  it("carries what the run attached with its last reply", () => {
    const f = fixture();
    const run = f.finished(null);
    const attachments = [{ kind: "file" as const, path: "report-1.pdf", mime: "application/pdf", name: "Weekly report.pdf" }];
    f.store.appendMessage(run.threadId!, { role: "bot", kind: "text", text: "Here is this week's report.", attachments, turnId: `turn-${run.id}`, turnTerminal: true });
    f.reports.runSettled(run, `turn-${run.id}`);
    expect(f.lines()).toEqual([expect.objectContaining({ text: "Here is this week's report.", attachments })]);
  });

  it("reads a report still waiting after a restart again, and writes nothing if the run's last reply had nothing new", () => {
    const f = fixture();
    const run = f.finished("Checked again.\nNOTHING NEW");
    f.runs.get(run.id)!.report = { state: "pending" };
    f.create().flush();
    expect(f.added()).toEqual([]);
    expect(f.runs.get(run.id)!.report).toEqual({ state: "quiet" });
  });

  it("never writes into another run's hidden conversation, even when a routine points there", () => {
    const f = fixture();
    const other = f.finished(null, "Other", { status: "running" });
    const run = f.finished("Acme replied.", "Inbox brief", { resultsThreadId: other.threadId });
    f.reports.runSettled(run, `turn-${run.id}`);
    expect(f.store.messagesFor(other.threadId!).some((message) => message.automation)).toBe(false);
    expect(f.notified).toEqual([{ kind: "done", threadId: run.threadId, detail: "Acme replied." }]);
  });

  it("sends the answer to a copied card only to a run of the same bot", () => {
    const f = fixture();
    const sam = f.store.createBot({ name: "Sam" });
    const samsRun = f.store.createTask(sam.id, "Sam's run", false)!.threadId;
    f.store.appendMessage(f.main, {
      role: "bot", kind: "options", card: { title: "Q", subtitle: "Which?", options: [], requestId: "ask-9", requestType: "question" },
      automation: { routineId: "r", runId: "x", name: "Inbox brief", trigger: "schedule", executionThreadId: samsRun, scheduledFor: 0, needsYou: true },
    });
    expect(f.reports.answeredIn(f.main, "ask-9")).toBe(f.main);
  });

  it("leaves a missed run, or one failed before it had a conversation, to its card, since no line can say so", () => {
    const f = fixture();
    const missed = f.finished(null, "Inbox brief", { status: "missed", threadId: undefined, error: "This computer was offline" });
    const missedAfterRequeue = f.finished(null, "Inbox brief", { status: "missed", error: "The routine ended before this run could start" });
    const unstarted = f.finished(null, "Inbox brief", { status: "failed", threadId: undefined, error: "Could not create a task for this run" });
    const queued = f.finished(null, "Inbox brief", { status: "queued", threadId: undefined });
    const failed = f.finished(null, "Inbox brief", { status: "failed", error: "Signed out" });
    expect([missed, missedAfterRequeue, unstarted, queued, failed].map((run) => f.reports.speaksFor(run))).toEqual([false, false, false, true, true]);
  });

  it("leaves a missed run of a routine that delivers to the brief to the brief, with no card in the chat", () => {
    const f = fixture();
    const missed = f.finished(null, "Watch", { status: "missed", threadId: undefined, deliver: "brief", error: "This computer was offline" });
    const unstarted = f.finished(null, "Watch", { status: "failed", threadId: undefined, deliver: "brief", error: "Could not create a task for this run" });
    expect([missed, unstarted].map((run) => f.reports.speaksFor(run))).toEqual([true, true]);
  });

  it("knows which conversations are a run's own whose last reply goes to another chat", () => {
    const f = fixture();
    const own = f.finished(null, "Inbox brief", { status: "running" });
    const joined = f.finished(null, "Continue", { status: "running", threadId: f.main });
    const gone = f.finished(null, "Orphan", { status: "running", resultsThreadId: "deleted-thread" });
    expect(f.reports.reportsElsewhere(own.threadId!)).toBe(true);
    expect(f.reports.reportsElsewhere(f.main)).toBe(false);
    expect(f.reports.reportsElsewhere(gone.threadId!)).toBe(false);
    expect(f.reports.reportsElsewhere("no-run-here")).toBe(false);
    expect(joined.threadId).toBe(f.main);
  });

  it("starts working through what was waiting once the routines are loaded", () => {
    const f = fixture();
    f.offline();
    const run = f.finished("Acme replied.");
    f.runs.get(run.id)!.report = { state: "pending" };
    const reports = f.create();
    reports.flush();
    expect(f.lines()).toEqual([]);
    f.online();
    reports.flush();
    expect(f.lines().map((line: Message) => line.text)).toEqual(["Acme replied."]);
  });
});
