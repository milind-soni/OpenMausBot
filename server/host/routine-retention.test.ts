import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineRun } from "../routines.ts";
import type { BotRecord, Message, Store, TaskRecord } from "../store.ts";
import { createRoutineRetention, sweepRoutineExecutions } from "./routine-retention.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15);
const old = NOW - 20 * DAY;
const makeRun = (id: string, extra: Partial<RoutineRun> = {}): RoutineRun => ({
  id, routineId: "r", routineName: "Routine", botId: "b", target: "bot", runOn: "maus",
  scheduledFor: old, createdAt: old, finishedAt: old, status: "completed", manual: false,
  triggerSource: "schedule", resultsThreadId: "result", threadId: `t-${id}`,
  report: { state: "quiet" }, prompt: "long prompt", output: "result", ...extra,
});

describe("scheduled execution retention", () => {
  it("contains sweep failures when cleanup is requested by a config change", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sweep = createRoutineRetention({
        retentionDays: () => 7,
        routines: () => { throw new Error("fixture disk failure"); },
        store: {} as Store,
        botWaits: { all: () => [] },
        neededByChecks: () => false,
        threadBusy: () => false,
        settlingTurns: new Set(),
        coordinator: { activeDirect: () => false, awaitingAnswer: () => false, awaitingTeammateThreads: () => new Set() },
        phoneSecretSubmissions: { hasThread: () => false },
        hasQueuedSteeredMessages: () => false,
        openPersonCard: () => null,
        deleteTasks: () => ({ deleted: [] }),
      });
      expect(sweep).not.toThrow();
      expect(warn).toHaveBeenCalledWith("routine retention sweep failed: fixture disk failure");
    } finally { warn.mockRestore(); }
  });

  it("deletes only old, detached, settled executions whose results remain available", () => {
    const latest = Array.from({ length: 5 }, (_, n) => makeRun(`new-${n}`, { scheduledFor: NOW - n, finishedAt: NOW - n }));
    const cases = [
      makeRun("safe"), makeRun("missing"), makeRun("pinned"), makeRun("busy"), makeRun("referenced"),
      makeRun("needs-input", { output: "NEEDS INPUT: Approve this?" }), makeRun("needs-check"),
      makeRun("output-file", { output: "Saved /tmp/report.md" }), makeRun("attachment"), makeRun("published"),
      makeRun("pending", { report: { state: "pending" } }), makeRun("failed", { status: "failed" }),
      makeRun("brief", { deliver: "brief" }), makeRun("webhook", { triggerSource: "webhook", sameConversation: true }),
      makeRun("question", { report: { state: "posted", threadId: "result", messageId: "question" } }),
      makeRun("file", { report: { state: "posted", threadId: "result", messageId: "file" } }),
      makeRun("plain-file", { report: { state: "posted", threadId: "result", messageId: "plain-file" } }),
      makeRun("card"), makeRun("promoted"), makeRun("shared"), makeRun("asked"), makeRun("custom-link"),
      makeRun("missing-result", { resultsThreadId: "gone" }),
    ];
    const tasks = new Map<string, TaskRecord>([["result", { threadId: "result", createdAt: old } as TaskRecord]]);
    for (const run of cases) if (run.id !== "missing") tasks.set(run.threadId!, {
      threadId: run.threadId!, routineRunId: run.id, createdAt: old, updatedAt: old,
      ...(run.id === "pinned" ? { pinned: true } : {}), ...(run.id === "promoted" ? { routineRunId: undefined } : {}),
      ...(run.id === "shared" ? { shared: true } : {}), ...(run.id === "asked" ? { askedAt: old } : {}),
      ...(run.id === "custom-link" ? { link: "https://example.com" } : {}),
    } as TaskRecord);
    for (const id of ["orphan-safe", "orphan-webhook", "orphan-file", "orphan-recent"]) tasks.set(`t-${id}`, {
      threadId: `t-${id}`, routineRunId: id, createdAt: old, updatedAt: old,
    } as TaskRecord);
    const bot = { id: "b", threadId: "result", tasks: [...tasks.values()] } as BotRecord;
    const lines = [
      { id: "question", text: "Please answer", automation: { runId: "question", needsYou: true } },
      { id: "file", text: "[Report](report.md)", automation: { runId: "file" } },
      { id: "plain-file", text: "See /tmp/report.md", automation: { runId: "plain-file" } },
      ...["orphan-safe", "orphan-webhook", "orphan-file", "orphan-recent"].map((id) => ({
        id, role: "bot", kind: "text", at: id === "orphan-recent" ? NOW : old, text: id === "orphan-file" ? "[file](out.md)" : "Result",
        automation: { runId: id, trigger: id === "orphan-webhook" ? "webhook" : "schedule", executionThreadId: `t-${id}` },
      })),
    ] as Message[];
    const store = {
      bots: [bot],
      bot: (id: string) => id === "b" ? bot : null,
      botByThread: (thread: string) => tasks.has(thread) ? bot : null,
      taskByThread: (_bot: string, thread: string) => tasks.get(thread) ?? null,
      messagesFor: (thread: string) => thread === "result" ? lines : thread === "t-card"
        ? [{ kind: "options", card: { requestId: "ask", options: [], title: "Continue?" } }]
        : thread === "t-attachment" ? [{ attachments: [{ kind: "file", path: "/attachments/report.pdf" }] }]
        : thread === "t-published" ? [{ publishedPage: { state: "live", url: "https://example.com/page" } }] : [],
    } as unknown as Store;
    const compactScheduledRuns = vi.fn(() => 2);
    const deleteTasks = vi.fn((_bot: string, ids: string[]) => ({ deleted: ids }));
    const result = sweepRoutineExecutions({ retentionDays: 7, now: NOW, store,
      routines: { attachmentPaths: () => [], listRuns: () => [...latest, ...cases], listRoutines: () => [], compactScheduledRuns },
      referencedThreads: new Set(["t-referenced"]), neededByChecks: (run) => run.id === "needs-check", busy: (_bot, thread) => thread === "t-busy", deleteTasks });
    expect(deleteTasks).toHaveBeenCalledOnce();
    expect(deleteTasks).toHaveBeenCalledWith("b", ["t-safe", "t-orphan-safe"]);
    expect(compactScheduledRuns).toHaveBeenCalledWith(new Set(["safe", "missing"]), new Set(["t-safe", "t-missing"]));
    expect(result).toEqual({ deleted: 2, compacted: 2 });
    const unreadable = sweepRoutineExecutions({ retentionDays: 7, now: NOW, store,
      routines: { attachmentPaths: () => null, listRuns: () => [], listRoutines: () => [], compactScheduledRuns },
      referencedThreads: new Set(), neededByChecks: () => false, busy: () => false, deleteTasks });
    expect(unreadable).toEqual({ deleted: 0, compacted: 0 });
    expect(deleteTasks).toHaveBeenCalledOnce();
  });

  it("keeps recent runs and the latest output for each continuity context across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-retention-"));
    try {
      const file = join(dir, "routines.json");
      const runs = Array.from({ length: 8 }, (_, n) => makeRun(`run-${n}`, {
        scheduledFor: old - n, finishedAt: old - n, createdAt: old - n, runOn: n < 6 ? "maus" : "cloud",
      }));
      // The continuity owner breaks equal finish times by stored order, not schedule order.
      runs[7]!.finishedAt = runs[6]!.finishedAt;
      [runs[6], runs[7]] = [runs[7]!, runs[6]!];
      writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs, frozenResultsCleared: true }));
      const frames: Record<string, unknown>[] = [];
      const options = { file, botState: () => "ready" as const, createTask: () => null, startTurn: async () => {}, emit: (frame: Record<string, unknown>) => frames.push(frame) };
      const manager = new RoutineManager(options);
      expect(manager.compactScheduledRuns(new Set(runs.map((run) => run.id)), new Set(runs.map((run) => run.threadId!)))).toBe(3);
      const restored = new RoutineManager(options).listRuns();
      expect(restored[4]).toMatchObject({ id: "run-4", prompt: "long prompt", output: "result", threadId: "t-run-4" });
      expect(restored[5]).toMatchObject({ id: "run-5", status: "completed" });
      expect(restored[5]).not.toHaveProperty("prompt");
      expect(restored[5]).not.toHaveProperty("output");
      expect(restored[5]).not.toHaveProperty("threadId");
      expect(restored[6]).toMatchObject({ id: "run-6" });
      expect(restored[6]).not.toHaveProperty("output");
      expect(restored[7]).toMatchObject({ id: "run-7", output: "result" });
      expect(JSON.parse(readFileSync(file, "utf8")).runs).toHaveLength(8);
      expect(frames).toHaveLength(3);
      expect(frames).toEqual(expect.arrayContaining(["run-5", "run-6", "run-7"].map((id) =>
        expect.objectContaining({ kind: "routine.run", run: expect.objectContaining({ id }) }))));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
