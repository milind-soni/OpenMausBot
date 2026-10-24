import { describe, expect, it } from "vitest";

import { jobView, type ConversationState, type JobInput } from "./job-view.ts";
import type { Assignment, OfficeAttempt } from "./runtime/types.ts";

const base: Assignment = {
  id: "root", rootId: "root", depth: 0,
  origin: { kind: "person", source: "chat", ref: "lead-chat" },
  requester: { kind: "person", threadId: "lead-chat", botId: "lead" },
  assignee: { botId: "lead", destination: { kind: "standing_thread", threadId: "lead-chat" } },
  mode: "work", reply: "resume", brief: "Rehearse the launch", status: "running", level: "full", levelSource: "own",
  executions: 1, restarts: 0, createdAt: 1_000, lastActivityAt: 1_000, result: "", rework: false, version: 1,
};
const root = (patch: Partial<Assignment> = {}): Assignment => ({ ...base, ...patch });
const child = (id: string, botId: string, patch: Partial<Assignment> = {}): Assignment => ({
  ...base, id, parentId: "root", depth: 1, requester: { kind: "bot_turn", botId: "lead", threadId: "lead-chat" },
  assignee: { botId, destination: { kind: "work_thread", threadId: `${botId}-work` } }, status: "queued", executions: 0,
  createdAt: 2_000, ...patch,
});
const idle: ConversationState = { kind: "bot", busy: false, activity: "idle", queued: 0 };
const names: Record<string, string> = { lead: "Room Lead", priya: "Priya", marcus: "Marcus", kenji: "Kenji" };
const attempt = (patch: Partial<OfficeAttempt> = {}): OfficeAttempt => ({
  version: 1, attemptId: "office-attempt", assignmentId: "root", rootId: "root", botId: "lead", threadId: "lead-chat",
  generation: "office-generation", workerId: "hel1", instanceId: "codex", driverKind: "codex", profileId: "lead",
  assignmentDigest: "assignment", profileDigest: "profile", cwd: "/fixture", rootDeadline: 60_000, startBefore: 2_000,
  kind: "work", digest: "attempt", capabilityHash: "capability", state: "consumed", preparedAt: 1_000,
  consumedAt: 1_001, ...patch,
});

const view = (rows: Assignment[], patch: Partial<JobInput> = {}) => jobView({
  threadId: "lead-chat", scope: "job", since: 500, now: 9_000, scopes: rows.filter((row) => !row.parentId).map((row) => row.id), rows,
  conversation: idle, activityOf: () => undefined, nameOf: (botId) => names[botId], titleOf: () => undefined, visible: () => true,
  ...patch,
});

describe("the job of a conversation", () => {
  it.each([idle, { ...idle, busy: true, activity: "working" }, { ...idle, activity: "dead" }])(
    "keeps the current completed source job independent of earlier cancellations, failures and conversation activity %j", conversation => {
      const old = root({ id: "old", rootId: "old", requestMessageId: "old-request", status: "cancelled", outcome: "stopped" });
      const failed = child("old-child", "priya", { parentId: old.id, rootId: old.id, status: "failed", outcome: "provider_error" });
      const latest = root({ id: "latest", rootId: "latest", requestMessageId: "latest-request", status: "completed", outcome: "done", createdAt: 3_000,
        brief: "Complete the latest request" });
      const job = view([old, failed, latest], { conversation, sourceBotId: "lead", requestMessageIds: new Set(["old-request", "latest-request"]) });
      expect(job.current).toEqual({ rootId: "latest", requestMessageId: "latest-request", status: "completed", outcome: "done",
        state: "completed", reason: "Room Lead finished", legacyTaskOutcome: true, sourceRequest: "Complete the latest request" });
      if (conversation.busy) expect(job.state).toBe("running");
      else if (conversation.activity === "dead") expect(job.state).toBe("failed");
      else expect(job.reason).toBe("Room Lead finished");
    });

  it("binds the current job to active source requests and excludes foreign bot or thread roots", () => {
    const first = root({ id: "first", rootId: "first", requestMessageId: "first-request", status: "completed" });
    const later = root({ id: "later", rootId: "later", requestMessageId: "later-request", createdAt: 3_000, status: "completed" });
    const foreignBot = root({ id: "foreign", rootId: "foreign", requestMessageId: "first-request", createdAt: 4_000,
      assignee: { ...base.assignee, botId: "other-chief" } });
    const foreignThread = root({ id: "foreign-thread", rootId: "foreign-thread", requestMessageId: "first-request", createdAt: 5_000,
      assignee: { botId: "lead", destination: { kind: "standing_thread", threadId: "other-chat" } } });
    const rows = [first, later, foreignBot, foreignThread];
    expect(view(rows, { sourceBotId: "lead", requestMessageIds: new Set(["first-request"]) }).current?.rootId).toBe(first.id);
    expect(view(rows, { sourceBotId: "lead", requestMessageIds: new Set(["later-request"]) }).current?.rootId).toBe(later.id);
    expect(view(rows, { sourceBotId: "lead", requestMessageIds: new Set(["unrelated-request"]) }).current).toBeNull();
    expect(view(rows, { sourceBotId: "lead", requestMessageIds: new Set() }).current).toBeNull();
    expect(view(rows, { sourceBotId: "lead", visible: () => false }).current).toBeNull();
  });

  it("selects the most recent source root before clipping without depending on row order", () => {
    const latest = root({ id: "latest", rootId: "latest", createdAt: 3_000, status: "completed", brief: "Latest root before clipping" });
    const descendants = Array.from({ length: 501 }, (_, i) => child(`recent-${i}`, "priya", {
      parentId: latest.id, rootId: latest.id, createdAt: 4_000 + i, status: "completed",
    }));
    const older = root({ id: "older", rootId: "older", createdAt: 2_000, status: "completed" });
    const job = view([latest, older, ...descendants], { sourceBotId: "lead" });
    expect(job.nodes).toHaveLength(500);
    expect(job.nodes.some(node => node.id === latest.id)).toBe(false);
    expect(job.current).toMatchObject({ rootId: latest.id, state: "completed", sourceRequest: "Latest root before clipping" });
  });

  it("keeps visible older unconfirmed stops separate from the current job and ordinary active attempts", () => {
    const old = root({ id: "old", rootId: "old", status: "cancelled", brief: "Earlier cancellation" });
    const stopped = child("old-child", "priya", { parentId: old.id, rootId: old.id, status: "cancelled",
      office: { rootDeadline: 60_000, attempts: [attempt({ state: "uncertain" })] } });
    const latest = root({ id: "latest", rootId: "latest", createdAt: 3_000, status: "running",
      office: { rootDeadline: 60_000, attempts: [attempt()] } });
    const rows = [old, stopped, latest];
    const before = view(rows, { sourceBotId: "lead" });
    expect(before.current).toMatchObject({ rootId: latest.id, state: "running" });
    expect(before.unconfirmedStops).toEqual([{ rootId: old.id, sourceRequest: "Earlier cancellation" }]);
    expect(view(rows, { sourceBotId: "lead", visible: threadId => threadId !== "priya-work" }).unconfirmedStops)
      .toEqual([{ rootId: old.id, sourceRequest: "Earlier cancellation" }]);
    expect(view(rows, { sourceBotId: "lead", visible: threadId => threadId !== "lead-chat" }).unconfirmedStops).toEqual([]);
    const confirmed = { ...stopped, office: { rootDeadline: 60_000, attempts: [attempt({ state: "cancelled", finishedAt: 5_000 })] } };
    const after = view([old, confirmed, latest], { sourceBotId: "lead" });
    expect(after.unconfirmedStops).toEqual([]);
    expect(after.version).not.toBe(before.version);
    const terminalUnfinished = { ...stopped, office: { rootDeadline: 60_000, attempts: [attempt({ state: "cancelled" })] } };
    expect(view([old, terminalUnfinished, latest], { sourceBotId: "lead" }).unconfirmedStops).toEqual([{ rootId: old.id, sourceRequest: "Earlier cancellation" }]);
  });

  it("changes the view version when active branch selection or current outcome detail changes", () => {
    const rows = [root({ id: "first", rootId: "first", requestMessageId: "first-request", status: "failed", outcomeDetail: "Original interruption" }),
      root({ id: "later", rootId: "later", requestMessageId: "later-request", createdAt: 3_000, status: "completed" })];
    const first = view(rows, { sourceBotId: "lead", requestMessageIds: new Set(["first-request"]) });
    expect(view(rows, { sourceBotId: "lead", requestMessageIds: new Set(["later-request"]) }).version).not.toBe(first.version);
    expect(view([{ ...rows[0]!, outcomeDetail: "Updated interruption" }, rows[1]!],
      { sourceBotId: "lead", requestMessageIds: new Set(["first-request"]) }).version).not.toBe(first.version);
  });

  it("carries a bounded visible source request only on roots for human job actions", () => {
    const request = "Compare\n  the proposals " + "x".repeat(200);
    const job = view([root({ brief: request }), child("a1", "priya", { brief: "Private delegated instructions" })]);
    expect(job.nodes[0]!.sourceRequest).toHaveLength(160);
    expect(job.nodes[0]!.sourceRequest).toMatch(/^Compare the proposals /);
    expect(job.nodes[1]).not.toHaveProperty("sourceRequest");
    expect(JSON.stringify(view([root({ brief: "Hidden source request" })], { visible: () => false }))).not.toContain("Hidden source request");
  });
  it("is idle when nothing ran since the time asked about", () => {
    expect(view([])).toMatchObject({ state: "idle", reason: "Nothing is running in this conversation", nodes: [], roots: [] });
  });

  it("runs while the lead's own turn runs, and says who works", () => {
    expect(view([root()], { conversation: { kind: "bot", busy: true, activity: "working", queued: 0 } }))
      .toMatchObject({ state: "running", reason: "Room Lead is working" });
    expect(view([], { conversation: { ...idle, queued: 1 } })).toMatchObject({ state: "running", reason: "A message is waiting its turn" });
  });

  it("keeps running while the lead waits on teammates, and names them", () => {
    const rows = [root({ status: "waiting" }), child("a1", "priya", { status: "running" }), child("a2", "marcus"), child("a3", "kenji", { status: "completed" })];
    const job = view(rows);
    expect(job).toMatchObject({ state: "running", reason: "Waiting on 2 teammate tasks: Priya, Marcus" });
    expect(job.counts).toMatchObject({ waiting: 1, running: 1, queued: 1, completed: 1 });
    expect(job.nodes.map((node) => [node.botName, node.status, node.awaited])).toEqual([
      ["Room Lead", "waiting", true], ["Priya", "running", true], ["Marcus", "queued", true], ["Kenji", "completed", true],
    ]);
  });

  it("is done once the lead has finished after every teammate settled", () => {
    const rows = [root({ status: "completed", result: "Launch report: [report](report.md)", finishedAt: 8_000 }),
      child("a1", "priya", { status: "completed", result: "Pricing was hard to find" }), child("a2", "marcus", { status: "failed", outcome: "provider_error" })];
    const job = view(rows);
    expect(job).toMatchObject({ state: "failed", reason: "1 teammate task did not complete (Marcus)" });
    expect(job.nodes[0]).toMatchObject({ result: "Launch report: [report](report.md)", finishedAt: 8_000 });
  });

  it("needs the person when a teammate it waits on is parked on a question, and says which", () => {
    const rows = [root({ status: "waiting" }), child("a1", "priya", { status: "needs_input", question: "Which pricing tier should I test?" }),
      child("a2", "marcus", { status: "running" })];
    const job = view(rows);
    expect(job).toMatchObject({ state: "needs-input", reason: "Priya needs you: Which pricing tier should I test?" });
    expect(job.needsInput).toEqual([{ id: "a1", botId: "priya", botName: "Priya", threadId: "priya-work", question: "Which pricing tier should I test?" }]);
  });

  it("needs the person when a teammate's turn waits on an approval card", () => {
    const rows = [root({ status: "waiting" }), child("a1", "priya", { status: "running" })];
    const job = view(rows, { activityOf: (row) => row.id === "a1" ? "waiting-on-you" : undefined });
    expect(job).toMatchObject({ state: "needs-input", reason: "Priya needs you: an approval is waiting in its conversation" });
    expect(view(rows, { conversation: { ...idle, activity: "waiting-on-you" } })).toMatchObject({ state: "needs-input" });
  });

  it("does not wait on a one-way notice, nor on work under a requester that stopped", () => {
    const notice = [root({ status: "completed" }), child("n1", "priya", { status: "running", reply: "none" })];
    expect(view(notice)).toMatchObject({ state: "completed" });
    expect(view(notice).nodes[1]).toMatchObject({ botName: "Priya", awaited: false });
    const beside = view([root({ status: "waiting" }), child("a1", "marcus", { status: "running" }), child("n1", "priya", { status: "running", reply: "none" })]);
    expect(beside).toMatchObject({ state: "running", reason: "Waiting on 1 teammate task: Marcus" });
    expect(beside.nodes.map((node) => [node.botName, node.awaited])).toEqual([["Room Lead", true], ["Marcus", true], ["Priya", false]]);
    const stopped = [root({ status: "cancelled", outcome: "stopped" }), child("a1", "priya", { status: "running" }),
      child("a2", "marcus", { status: "needs_input", question: "Continue?" })];
    expect(view(stopped)).toMatchObject({ state: "cancelled", reason: "Room Lead was stopped", needsInput: [] });
  });

  it("reports how the lead's work ended when it did not finish", () => {
    expect(view([root({ status: "failed", outcome: "stalled", outcomeDetail: "no progress for 4h" })]))
      .toMatchObject({ state: "stalled", reason: "Room Lead's work ended as stalled: no progress for 4h" });
    expect(view([root({ status: "failed", outcome: "provider_error" })])).toMatchObject({ state: "failed", reason: "Room Lead's work ended as provider_error" });
    expect(view([root()], { conversation: { ...idle, activity: "dead" } })).toMatchObject({ state: "failed" });
    expect(view([root()], { conversation: { ...idle, activity: "no-signal" } })).toMatchObject({ state: "stalled" });
  });

  it("reads only the lead's own turn with scope turn", () => {
    const rows = [root({ status: "waiting" }), child("a1", "priya", { status: "running" })];
    expect(view(rows, { scope: "turn" })).toMatchObject({ state: "running", reason: "Room Lead is waiting to continue" });
    expect(view(rows, { scope: "turn" }).nodes[1]).toMatchObject({ awaited: false });
    expect(view([root({ status: "resume" })], { scope: "turn" })).toMatchObject({ state: "running" });
  });

  it("changes its version exactly when something a waiter reports changes", () => {
    const rows = [root({ status: "waiting" }), child("a1", "priya", { status: "running" })];
    const before = view(rows).version;
    expect(view(rows, { now: 99_000 }).version).toBe(before);
    expect(view([rows[0]!, { ...rows[1]!, status: "completed" }]).version).not.toBe(before);
    expect(view(rows, { conversation: { ...idle, queued: 1 } }).version).not.toBe(before);
    expect(view([{ ...rows[0]!, brief: "A different visible source" }, rows[1]!]).version).not.toBe(before);
  });

  it("counts what the reader may not see without listing it, and clips results unless asked for them whole", () => {
    const long = "x".repeat(2_000);
    const rows = [root({ status: "completed", result: long }), child("a1", "priya", { status: "completed", result: "secret room" })];
    const job = view(rows, { visible: (threadId) => threadId !== "priya-work" });
    expect(job).toMatchObject({ state: "completed", hidden: 1 });
    expect(job.nodes.map((node) => node.id)).toEqual(["root"]);
    expect(job.nodes[0]!.result).toHaveLength(281);
    expect(view(rows, { full: true }).nodes[0]!.result).toBe(long);
    expect(view([root({ result: "half" })]).nodes[0]).not.toHaveProperty("result");
  });

  it("lists the newest 500 rows of a long conversation, so its latest job shows whole", () => {
    const earlier = Array.from({ length: 600 }, (_, i) => root({ id: `old-${i}`, rootId: `old-${i}`, status: "completed", createdAt: 100 + i }));
    const latest = [root({ id: "root", status: "completed", createdAt: 5_000 }), child("a1", "priya", { status: "completed", createdAt: 5_001 })];
    const job = view([...earlier, ...latest], { since: 0 });
    expect(job.nodes).toHaveLength(500);
    expect(job.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["root", "a1"]));
    expect(job.nodes.map((node) => node.id)).not.toContain("old-0");
    expect(job.nodes.at(-1)!.id).toBe("a1");
    expect(job.counts.completed).toBe(602);
  });

  it("never names or quotes, in its reason, work in a conversation the reader may not open", () => {
    const hidden = { visible: (threadId: string) => threadId !== "priya-work" };
    const parked = view([root({ status: "waiting" }), child("a1", "priya", { status: "needs_input", question: "Use the card ending 4242?" })], hidden);
    expect(parked).toMatchObject({ state: "needs-input", reason: "A teammate needs an answer in a conversation you cannot open", needsInput: [] });
    expect(JSON.stringify(parked)).not.toMatch(/Priya|4242/);
    const waiting = view([root({ status: "waiting" }), child("a1", "priya", { status: "running" }), child("a2", "marcus", { status: "running" })], hidden);
    expect(waiting.reason).toBe("Waiting on 2 teammate tasks: a teammate, Marcus");
    const failed = view([root({ status: "completed" }), child("a1", "priya", { status: "failed" })], hidden);
    expect(failed.reason).toBe("1 teammate task did not complete (a teammate)");
  });
});


describe("requested-task disposition regressions", () => {
  it("returns cancelled for a cancelled current job", () => {
    expect(view([root({ status: "cancelled", outcome: "stopped" })]).current?.state).toBe("cancelled");
  });
  it("does not complete a parent that still owes continuation", () => {
    expect(view([root({ status: "waiting" })]).current?.state).toBe("running");
  });
  it("selects delegated cancellation in its own visible thread", () => {
    const delegated = child("delegated", "priya", { status: "cancelled", outcome: "stopped" });
    expect(view([root(), delegated], { threadId: "priya-work", sourceBotId: "priya", scopes: [delegated.id], requestMessageIds: new Set() }).current?.state).toBe("cancelled");
  });
  it("keeps completed turn lifecycle separate from blocked work", () => {
    const row = root({ status: "completed", disposition: { state: "blocked", reason: "GitHub tool unavailable" } });
    expect(view([row]).current).toMatchObject({ state: "blocked", reason: "GitHub tool unavailable" });
  });
  it("ignores failed rows belonging to old jobs in completion reason", () => {
    expect(view([root({ status: "completed" }), child("past", "priya", { rootId: "past-root", status: "failed" })]).reason).toBe("Room Lead finished");
  });
});

it("does not paint a completed parent green while its current handoff is blocked", () => {
 expect(view([root({ status: "completed" }), child("blocked", "priya", { status: "completed", disposition: { state: "blocked", reason: "Missing GitHub tool" } })]).current).toMatchObject({ state: "blocked", reason: "Missing GitHub tool" });
});
it("a successful explicit rework supersedes that task's earlier failure and blocked result", () => {
 const original = child("failed", "priya", { status: "failed", outcome: "provider_error" });
 const blocked = child("blocked", "priya", { status: "completed", createdAt: 3000, rework: true, disposition: { state: "blocked", reason: "Missing GitHub tool" } });
 const retried = child("retry", "priya", { status: "completed", createdAt: 4000, rework: true });
 expect(view([retried, root({ status: "completed" }), blocked, original]).current).toMatchObject({ state: "completed", reason: "Room Lead finished" });
});

it("uses selected transcript request order when job creation events arrive out of order", () => {
 const latestRequest = root({ id: "new", rootId: "new", requestMessageId: "new-request", createdAt: 1000, status: "completed" });
 const delayedOldRequest = root({ id: "old", rootId: "old", requestMessageId: "old-request", createdAt: 3000, status: "cancelled" });
 expect(view([latestRequest, delayedOldRequest], { requestMessageIds: new Set(["old-request", "new-request"]) }).current?.rootId).toBe("new");
});

it("keeps the delegated selected subtree's blocker and native uncertainty visible", () => {
 const delegated = child("delegated", "priya", { status: "completed" });
 const nested = child("nested", "marcus", { parentId: delegated.id, status: "completed", disposition: { state: "blocked", reason: "Missing delegated dependency" }, office: { rootDeadline: 60000, attempts: [attempt({ assignmentId: "nested", state: "uncertain" })] } });
 const job = view([delegated, nested], { threadId: "priya-work", sourceBotId: "priya", scopes: [delegated.id], requestMessageIds: new Set() });
 expect(job.current).toMatchObject({ rootId: delegated.id, state: "blocked", reason: "Missing delegated dependency" });
 expect(job.unconfirmedStops).toEqual([{ rootId: delegated.id }]);
});
