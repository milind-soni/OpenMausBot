import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { failedTurnTool } from "../shared/failed-turn.ts";
import type { NeedsYouItem } from "../shared/today.ts";
import { TRIAL_CREDIT_REFUSED } from "../shared/trial-credit.ts";
import { SEES_EVERYTHING, VisibleSet, routineVisible } from "./bot-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { todayReport, type TodaySources, type TodayViewer } from "./today.ts";

const MIDNIGHT = new Date(2026, 9, 17).getTime();
const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const at = (hour: number, minute = 0, second = 0) => new Date(2026, 9, 17, hour, minute, second).getTime();
const HOUR = 3_600_000;

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

type Run = ReturnType<NonNullable<TodaySources["routines"]>["listRuns"]>[number];

function world() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const atlas = store.createBot({ name: "Atlas", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  const pepper = store.createBot({ name: "Pepper", modelSelection: { instanceId: "codex", model: "gpt-5.5" } });
  const runs: Run[] = [];
  const routineList: Array<{ botId: string; groupId?: string }> = [];
  const parked: TodaySources["parked"][number][] = [];
  const engines: Array<TodaySources["engines"][number]> = [];
  const sources = (): TodaySources => ({
    bots: store.bots, groups: store.groups, engines, parked,
    routines: { listRoutines: () => routineList, listRuns: () => runs },
  });
  const say = (threadId: string, message: Omit<Message, "id" | "at"> & { at: number }) => store.appendMessage(threadId, message);
  const tool = (threadId: string, time: number, name: string, ok: boolean | undefined, extra: Partial<NonNullable<Message["tool"]>> & { turnId?: string; from?: Message["from"] } = {}) => {
    const { turnId, from, ...rest } = extra;
    return say(threadId, { role: "bot", kind: "activity", at: time, tool: { name, ok, ...rest }, ...(turnId ? { turnId } : {}), ...(from ? { from } : {}) });
  };
  const digest = (threadId: string, botId: string, time: number, turnId: string, reply: string, succeeded: boolean, requestMessageId?: string) =>
    say(threadId, {
      role: "bot", kind: "digest", at: time, turnId, turnSucceeded: succeeded, ...(requestMessageId ? { requestMessageId } : {}),
      digest: { turnId, botId, threadId, at: time, durationMs: 1_000, tools: [], memory: [], reply, hookCoverage: "none" },
    });
  const fail = (threadId: string, time: number, cause: string, flags: Parameters<typeof failedTurnTool>[1] = {}, turnId?: string) =>
    say(threadId, { role: "bot", kind: "activity", at: time, tool: failedTurnTool(cause, flags), ...(turnId ? { turnId } : {}) });
  return { store, atlas, pepper, runs, routineList, parked, engines, sources, say, tool, digest, fail };
}

const ADMIN: TodayViewer = { admin: true, thread: () => true, routine: () => true };

function seededDay() {
  const w = world();
  const briefing = w.store.createTask(w.atlas.id, "Morning briefing · Oct 17", false)!;
  w.tool(briefing.threadId, at(9, 0, 10), "mcp__composio__GMAIL_FETCH_EMAILS", true, { turnId: "t1" });
  w.tool(briefing.threadId, at(9, 0, 40), "mcp__composio__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", true, { turnId: "t1" });
  w.tool(briefing.threadId, at(9, 1), "mcp__composio__GMAIL_CREATE_EMAIL_DRAFT", true, { turnId: "t1" });
  w.digest(briefing.threadId, w.atlas.id, at(9, 2), "t1", "Here is your morning briefing for Oct 17.", true);
  w.runs.push({ id: "run-brief", routineId: "r-brief", routineName: "Morning briefing", botId: w.atlas.id, status: "completed", manual: false,
    triggerSource: "schedule", threadId: briefing.threadId, scheduledFor: at(9), startedAt: at(9), finishedAt: at(9, 2, 30) });

  const asked = w.say(w.atlas.threadId, { role: "user", kind: "text", text: "Reply to Sam about the refund", at: at(10) });
  w.tool(w.atlas.threadId, at(10, 1), "mcp__composio__GMAIL_SEND_EMAIL", true, { turnId: "t2" });
  w.tool(w.atlas.threadId, at(10, 1, 10), "Bash", true, { turnId: "t2" });
  w.tool(w.atlas.threadId, at(10, 1, 20), "mcp__composio__GMAIL_SEND_EMAIL", false, { turnId: "t2", output: "Error: invalid recipient" });
  w.digest(w.atlas.threadId, w.atlas.id, at(10, 2), "t2", "**Sent** the refund reply to Sam. It went out at 10:01.", true, asked.id);

  const sweep = w.store.createTask(w.pepper.id, "Lead list", false)!;
  const peer = w.say(sweep.threadId, { role: "user", kind: "text", text: "Post the lead list", at: at(11), peerAsk: { botId: w.atlas.id, name: "Atlas" } });
  w.tool(sweep.threadId, at(11, 2), "COMPOSIO_MULTI_EXECUTE_TOOL", true, { turnId: "t3",
    input: JSON.stringify({ tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: {} }, { tool_slug: "HUBSPOT_CREATE_CONTACT", arguments: {} }] }) });
  w.digest(sweep.threadId, w.pepper.id, at(11, 5), "t3", "Posted the lead list to #sales.", true, peer.id);

  const api = w.say(w.pepper.threadId, { role: "user", kind: "text", text: "Refresh the orders sheet", at: at(12), via: "api" });
  w.fail(w.pepper.threadId, at(12, 20), "no activity for 20 minutes — the turn was stopped", {}, "t4");
  w.digest(w.pepper.threadId, w.pepper.id, at(12, 20, 5), "t4", "", false, api.id);
  w.fail(w.pepper.threadId, at(13), "turn interrupted — OpenMausBot restarted");

  const digestTask = w.store.createTask(w.pepper.id, "Inbox digest", false)!;
  w.runs.push({ id: "run-digest", routineId: "r-digest", routineName: "Inbox digest", botId: w.pepper.id, status: "completed", manual: true,
    triggerSource: "manual", threadId: digestTask.threadId, scheduledFor: at(14), startedAt: at(14), finishedAt: at(14, 0, 30) });
  w.runs.push({ id: "run-leads", routineId: "r-leads", routineName: "Lead sweep", botId: w.pepper.id, status: "failed", manual: false,
    triggerSource: "webhook", scheduledFor: at(8), finishedAt: at(8), error: "Could not create a task for this run" });
  w.runs.push({ id: "run-kpi", routineId: "r-kpi", routineName: "Weekly KPI report", botId: w.atlas.id, status: "missed", manual: false,
    triggerSource: "schedule", scheduledFor: at(6), error: "OpenMausBot was not running at 06:00" });
  w.runs.push({ id: "run-stopped", routineId: "r-brief", routineName: "Morning briefing", botId: w.atlas.id, status: "cancelled", manual: true, scheduledFor: at(7), finishedAt: at(7, 5) });
  w.runs.push({ id: "run-live", routineId: "r-brief", routineName: "Morning briefing", botId: w.atlas.id, status: "running", manual: true, scheduledFor: at(14, 50), startedAt: at(14, 50) });
  w.routineList.push({ botId: w.atlas.id }, { botId: w.pepper.id });

  const yesterday = MIDNIGHT - 8 * HOUR;
  w.tool(w.atlas.threadId, yesterday, "mcp__composio__NOTION_CREATE_PAGE", true, { turnId: "t0" });
  w.digest(w.atlas.threadId, w.atlas.id, yesterday + 60_000, "t0", "Filed the weekly notes in Notion.", true);
  return { ...w, briefing, sweep, digestTask };
}

describe("today's report", () => {
  it("counts finished outcomes once, routines OK and failed, and the minutes they stand for", () => {
    const w = seededDay();
    const report = todayReport(w.sources(), ADMIN, MIDNIGHT, NOW);
    expect(report.tiles).toEqual([
      { category: "emailRead", count: 2 }, { category: "draft", count: 1 }, { category: "emailSent", count: 1 },
      { category: "message", count: 1 }, { category: "report", count: 2 }, { category: "lead", count: 1 },
    ]);
    expect(report.routines).toEqual({ ok: 2, failed: 2 });
    expect(report.minutesSaved).toBe(2 * 2 + 5 + 4 + 2 + 2 * 15 + 3);
    expect(report.routineCount).toBe(2);
    expect(report.since).toBe(MIDNIGHT);
    expect(report.until).toBe(NOW);
  });

  it("lists each finished piece of work once, newest first, with who started it and what it produced", () => {
    const w = seededDay();
    const { lines, moreLines } = todayReport(w.sources(), ADMIN, MIDNIGHT, NOW);
    expect(lines.map(({ id: _id, ...line }) => line)).toEqual([
      { at: at(14, 0, 30), botId: w.pepper.id, threadId: w.digestTask.threadId, routineId: "r-digest", title: "Inbox digest", ok: true, startedBy: "manual", outcomes: { report: 1 } },
      { at: at(13), botId: w.pepper.id, threadId: w.pepper.threadId, title: "", ok: false, error: "turn interrupted — OpenMausBot restarted", outcomes: {} },
      { at: at(12, 20, 5), botId: w.pepper.id, threadId: w.pepper.threadId, title: "", ok: false, error: "no activity for 20 minutes — the turn was stopped", outcomes: {}, startedBy: "api" },
      { at: at(11, 5), botId: w.pepper.id, threadId: w.sweep.threadId, title: "Posted the lead list to #sales.", ok: true, outcomes: { message: 1, lead: 1 }, startedBy: "bot" },
      { at: at(10, 2), botId: w.atlas.id, threadId: w.atlas.threadId, title: "Sent the refund reply to Sam. It went out at 10:01.", ok: true, outcomes: { emailSent: 1 }, startedBy: "person" },
      { at: at(9, 2, 30), botId: w.atlas.id, threadId: w.briefing.threadId, routineId: "r-brief", title: "Morning briefing", ok: true, startedBy: "schedule", outcomes: { emailRead: 2, draft: 1, report: 1 } },
      { at: at(8), botId: w.pepper.id, routineId: "r-leads", title: "Lead sweep", ok: false, error: "Could not create a task for this run", startedBy: "webhook", outcomes: {} },
      { at: at(6), botId: w.atlas.id, routineId: "r-kpi", title: "Weekly KPI report", ok: false, error: "OpenMausBot was not running at 06:00", startedBy: "schedule", outcomes: {} },
    ]);
    expect(moreLines).toBe(0);
  });

  it("opens a run where it reported, and lists no run that found nothing new", () => {
    const w = seededDay();
    const brief = w.runs.find((run) => run.id === "run-brief")!;
    brief.report = { state: "posted", threadId: w.atlas.threadId, messageId: "report-line" };
    w.runs.find((run) => run.id === "run-digest")!.report = { state: "quiet" };
    const report = todayReport(w.sources(), ADMIN, MIDNIGHT, NOW);
    expect(report.lines.find((line) => line.id === "run-brief")).toMatchObject({ threadId: w.atlas.threadId, title: "Morning briefing" });
    expect(report.lines.some((line) => line.id === "run-digest")).toBe(false);
    expect(report.routines).toEqual({ ok: 2, failed: 2 });
  });

  it("reads a longer window back to its start, and never further than eight days", () => {
    const w = seededDay();
    const week = todayReport(w.sources(), ADMIN, MIDNIGHT - 6 * 24 * HOUR, NOW);
    expect(week.tiles).toContainEqual({ category: "doc", count: 1 });
    expect(week.lines.at(-1)).toMatchObject({ title: "Filed the weekly notes in Notion.", outcomes: { doc: 1 } });
    expect(todayReport(w.sources(), ADMIN, 0, NOW).since).toBe(NOW - 8 * 24 * HOUR);
    expect(todayReport(w.sources(), ADMIN, NOW + HOUR, NOW).since).toBe(NOW);
  });

  it("shows a member only the bots they can see", () => {
    const w = seededDay();
    w.store.patchBot(w.pepper.id, { visibility: "admins" });
    const visible = new VisibleSet(w.store.bots, w.store.groups, { kind: "member", email: "ada@example.test" });
    const member: TodayViewer = { admin: false, thread: (id) => visible.thread(id), routine: (run) => routineVisible(run, visible) };
    const report = todayReport(w.sources(), member, MIDNIGHT, NOW);
    expect(new Set(report.lines.map((line) => line.botId))).toEqual(new Set([w.atlas.id]));
    expect(report.tiles.map((tile) => tile.category)).toEqual(["emailRead", "draft", "emailSent", "report"]);
    expect(report.routines).toEqual({ ok: 1, failed: 1 });
    expect(report.routineCount).toBe(1);
    const everyone = new VisibleSet(w.store.bots, w.store.groups, SEES_EVERYTHING);
    expect(todayReport(w.sources(), { ...member, thread: (id) => everyone.thread(id), routine: (run) => routineVisible(run, everyone) }, MIDNIGHT, NOW).lines).toHaveLength(8);
  });

  it("caps the lines it returns and says how many more there were", () => {
    const w = world();
    for (let i = 0; i < 305; i++) w.digest(w.atlas.threadId, w.atlas.id, at(10) + i * 1_000, `turn-${i}`, `Answer ${i}.`, true);
    const report = todayReport(w.sources(), ADMIN, MIDNIGHT, NOW);
    expect(report.lines).toHaveLength(300);
    expect(report.lines[0]!.title).toBe("Answer 304.");
    expect(report.moreLines).toBe(5);
  });
});

describe("needs you", () => {
  const kinds = (items: NeedsYouItem[]) => items.map((item) => [item.kind, "instanceId" in item ? item.instanceId : "app" in item ? item.app : "place" in item ? item.place.state : "credit" in item ? item.credit : item.text]);

  function blocked() {
    const w = world();
    const rex = w.store.createBot({ name: "Rex", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const zed = w.store.createBot({ name: "Zed", modelSelection: { instanceId: "grok", model: "grok-5" } });
    const lou = w.store.createBot({ name: "Lou", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const kai = w.store.createBot({ name: "Kai", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    w.fail(w.atlas.threadId, at(9), "Invalid API key · Please run /login", { setup: true });
    w.fail(lou.threadId, at(8), "401 Unauthorized: OAuth token has expired");
    w.fail(kai.threadId, at(8, 30), TRIAL_CREDIT_REFUSED.paused);
    w.fail(w.pepper.threadId, at(9, 30), "You've hit your usage limit. Try again at 3pm.");
    w.fail(rex.threadId, at(10), TRIAL_CREDIT_REFUSED.used_up);
    w.fail(rex.threadId, at(10, 5), "This month's cloud desktop hours are used up.", { place: { state: "cc-no-hours", params: { bot: "Rex" }, source: "works-on" } });
    w.fail(zed.threadId, at(10, 6), "Cloud computers can't start right now.", { place: { state: "cc-unavailable", params: { bot: "Zed" }, source: "works-on" } });
    w.fail(zed.threadId, at(10, 7), "turn interrupted — OpenMausBot restarted");
    w.tool(w.atlas.threadId, at(11), "mcp__composio__GMAIL_SEND_EMAIL", false, { output: "Error: 401 Unauthorized. The connected account's token has expired; reconnect Gmail." });
    w.tool(w.atlas.threadId, at(11, 1), "mcp__composio__SLACK_SEND_MESSAGE", false, { output: "channel_not_found" });
    const zedTask = w.store.createTask(zed.id, "Newsletter", false)!;
    w.say(zedTask.threadId, { role: "bot", kind: "options", at: at(12), card: { title: "Which list should I send the newsletter to?", subtitle: "", options: ["Customers", "Everyone"], requestType: "question", requestId: "q1" } });
    w.say(w.atlas.threadId, { role: "bot", kind: "options", at: at(12, 1), card: { title: "Run a command?", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestType: "permission", requestId: "p1", tool: "Bash" } });
    w.say(w.atlas.threadId, { role: "bot", kind: "options", at: at(12, 2), card: { title: "Send now or tomorrow?", subtitle: "", options: ["Now", "Tomorrow"], requestType: "question", requestId: "q2", answered: "Now" } });
    w.say(w.pepper.threadId, { role: "bot", kind: "options", at: at(12, 5), card: { title: "Switch to Claude?", subtitle: "Codex reached its limit", options: ["Switch", "Wait"], quotaSwitch: { engines: [{ instanceId: "claude", name: "Claude" }] } } });
    const drafts = w.store.createTask(rex.id, "Drafts", false)!;
    w.say(drafts.threadId, { role: "bot", kind: "options", at: at(12, 6), card: { title: "Which draft should go out?", subtitle: "Two drafts are ready", options: ["Short", "Long"] } });
    const parkedTask = w.store.createTask(w.pepper.id, "Outreach", false)!;
    w.parked.push({ id: "a1", botId: w.pepper.id, threadId: parkedTask.threadId, question: "Should I email the whole list or only last month's buyers?", createdAt: at(13) });
    w.engines.push({ instanceId: "grok", snapshot: { state: "available", authenticated: false } }, { instanceId: "claude", snapshot: { state: "available" } });
    return { ...w, rex, zed, lou, zedTask, parkedTask };
  }

  it("lists only what the person can fix, each once, most blocking first", () => {
    const w = blocked();
    const { needsYou } = todayReport(w.sources(), ADMIN, MIDNIGHT, NOW);
    expect(kinds(needsYou)).toEqual([
      ["signed-out", "grok"],
      ["signed-out", "claude"],
      ["out-of-credit", "used_up"],
      ["usage-limit", "codex"],
      ["connection", "Gmail"],
      ["place", "cc-no-hours"],
      ["question", "Should I email the whole list or only last month's buyers?"],
      ["question", "Which draft should go out?"],
      ["question", "Which list should I send the newsletter to?"],
    ]);
    expect(needsYou.find((item) => item.kind === "signed-out" && item.instanceId === "grok")).toMatchObject({ botIds: [w.zed.id] });
    expect(needsYou.find((item) => item.kind === "signed-out" && item.instanceId === "claude")).toMatchObject({ botIds: [w.lou.id, w.atlas.id], threadId: w.atlas.threadId });
    expect(needsYou.find((item) => item.kind === "question" && item.threadId === w.zedTask.threadId)).toMatchObject({ botId: w.zed.id });
  });

  it("drops a failure once the bot finished a turn after it, an engine signed back in, or the app worked again", () => {
    const w = blocked();
    w.digest(w.pepper.threadId, w.pepper.id, at(14), "after", "Done.", true);
    w.digest(w.rex.threadId, w.rex.id, at(14), "after-rex", "Done.", true);
    w.engines.splice(0, 2, { instanceId: "grok", snapshot: { state: "available", authenticated: true } }, { instanceId: "claude", snapshot: { state: "available", authenticated: true } });
    w.tool(w.atlas.threadId, at(14, 1), "mcp__composio__GMAIL_FETCH_EMAILS", true);
    expect(kinds(todayReport(w.sources(), ADMIN, MIDNIGHT, NOW).needsYou)).toEqual([
      ["question", "Should I email the whole list or only last month's buyers?"],
      ["question", "Which draft should go out?"],
      ["question", "Which list should I send the newsletter to?"],
    ]);
  });

  it("keeps a question nobody answered after its turn ends, until the person answers it, within the week", () => {
    const w = world();
    const mia = w.store.createBot({ name: "Mia" });
    const card = { title: "Which price?", subtitle: "", options: ["$10", "$20"], requestType: "question" as const, requestId: "q3" };
    const asked = w.say(mia.threadId, { role: "bot", kind: "options", at: at(12, 3), card });
    w.digest(mia.threadId, mia.id, at(12, 18), "rt", "Nobody answered, so I went with $20.", true);
    w.digest(mia.threadId, mia.id, at(13), "next", "Done.", true);
    expect(todayReport(w.sources(), ADMIN, MIDNIGHT, NOW).needsYou).toEqual([
      { kind: "question", id: asked.id, at: at(12, 3), botId: mia.id, threadId: mia.threadId, text: "Which price?" },
    ]);
    expect(todayReport(w.sources(), ADMIN, MIDNIGHT, NOW + 8 * 24 * HOUR).needsYou).toEqual([]);

    w.store.patchMessage(mia.threadId, asked.id, { card: { ...card, answered: "answer", answeredText: "$10", dismissed: false } });
    expect(todayReport(w.sources(), ADMIN, MIDNIGHT, NOW).needsYou).toEqual([]);
  });

  it("drops a question the person closed, and lists a request asked again only where it was asked last", () => {
    const w = world();
    const mia = w.store.createBot({ name: "Mia" });
    const card = { title: "Which price?", subtitle: "", options: ["$10", "$20"], requestType: "question" as const, requestId: "q3" };
    w.say(mia.threadId, { role: "bot", kind: "options", at: at(12, 3), card: { ...card, dismissed: true } });
    w.say(w.atlas.threadId, { role: "bot", kind: "options", at: at(12, 4), card: { ...card, requestId: "q4" } });
    const task = w.store.createTask(w.atlas.id, "Pricing", false)!;
    const again = w.say(task.threadId, { role: "bot", kind: "options", at: at(12, 5), card: { ...card, requestId: "q4" } });
    w.digest(task.threadId, w.atlas.id, at(12, 20), "rt", "Went with $20.", true);
    expect(todayReport(w.sources(), ADMIN, MIDNIGHT, NOW).needsYou).toEqual([
      { kind: "question", id: again.id, at: at(12, 5), botId: w.atlas.id, threadId: task.threadId, text: "Which price?" },
    ]);
  });

  it("lists a run's question once, where its copy can be answered, not in the run's own conversation too", () => {
    const w = blocked();
    const card = { title: "Which list should I send the newsletter to?", subtitle: "", options: ["Customers", "Everyone"], requestType: "question" as const, requestId: "q1" };
    w.say(w.zed.threadId, { role: "bot", kind: "options", at: at(12, 0, 1), card, automation: { routineId: "r", runId: "run", name: "Newsletter", trigger: "schedule", executionThreadId: w.zedTask.threadId, scheduledFor: at(12), needsYou: true } });
    const questions = todayReport(w.sources(), ADMIN, MIDNIGHT, NOW).needsYou.filter((item) => item.kind === "question" && item.text === card.title);
    expect(questions).toEqual([expect.objectContaining({ threadId: w.zed.threadId })]);
  });

  it("looks a week back whatever the window, and gives someone who is not an admin only their bots' questions", () => {
    const w = blocked();
    w.fail(w.zed.threadId, NOW - 6 * 24 * HOUR, "Invalid API key · Please run /login", { setup: true });
    const member = todayReport(w.sources(), { ...ADMIN, admin: false }, NOW - HOUR, NOW);
    expect(member.needsYou.map((item) => item.kind)).toEqual(["question", "question", "question"]);
    w.fail(w.atlas.threadId, NOW - 8 * 24 * HOUR, TRIAL_CREDIT_REFUSED.ended);
    expect(kinds(todayReport(w.sources(), ADMIN, NOW - HOUR, NOW).needsYou)).toContainEqual(["out-of-credit", "used_up"]);
  });
});
