import { describe, expect, it } from "vitest";

import { jobView, type ConversationState, type JobInput } from "./job-view.ts";
import type { Assignment } from "./runtime/types.ts";

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

const view = (rows: Assignment[], patch: Partial<JobInput> = {}) => jobView({
  threadId: "lead-chat", scope: "job", since: 500, now: 9_000, scopes: rows.filter((row) => !row.parentId).map((row) => row.id), rows,
  conversation: idle, activityOf: () => undefined, nameOf: (botId) => names[botId], titleOf: () => undefined, visible: () => true,
  ...patch,
});

describe("the job of a conversation", () => {
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
    expect(job).toMatchObject({ state: "completed", reason: "Room Lead finished; 1 teammate task did not complete (Marcus)" });
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
    expect(view(stopped)).toMatchObject({ state: "failed", reason: "Room Lead's work ended because it was stopped", needsInput: [] });
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
    expect(view(rows, { scope: "turn" })).toMatchObject({ state: "completed", reason: "Room Lead finished" });
    expect(view(rows, { scope: "turn" }).nodes[1]).toMatchObject({ awaited: false });
    expect(view([root({ status: "resume" })], { scope: "turn" })).toMatchObject({ state: "running" });
  });

  it("changes its version exactly when something a waiter reports changes", () => {
    const rows = [root({ status: "waiting" }), child("a1", "priya", { status: "running" })];
    const before = view(rows).version;
    expect(view(rows, { now: 99_000 }).version).toBe(before);
    expect(view([rows[0]!, { ...rows[1]!, status: "completed" }]).version).not.toBe(before);
    expect(view(rows, { conversation: { ...idle, queued: 1 } }).version).not.toBe(before);
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
    expect(failed.reason).toBe("Room Lead finished; 1 teammate task did not complete (a teammate)");
  });
});
