// What failing routines cost in requests to the AI, counted as the turns they start: the routine's own starts and the
// Chief turns their failures start, wired as the host wires them (a failure the owner was already told of reaches no one).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INCIDENT_WINDOW_MS, incidentText } from "../incidents.ts";
import { failureShape } from "../routine-outcomes.ts";
import { RoutineManager, type RoutineRun } from "../routines.ts";
import { createChiefNotices } from "./chief-notices.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-16T08:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A dead tool server as the engine reports it: the same failure, with a new process id and time each run. */
const deadTool = (at: number) => `MCP server "crm" could not start (pid ${4000 + (at / MINUTE) % 997}) at ${new Date(at).toISOString()}; check its command and installation`;
const spawnRefused = (at: number) => `spawn /usr/local/bin/claude EAGAIN (pid ${30000 + Math.floor(at / MINUTE) % 997})`;

function world(botCount: number, failure: (at: number) => string, refuseStart = false) {
  const dir = mkdtempSync(join(tmpdir(), "omb-chief-incident-spend-"));
  dirs.push(dir);
  let now = START, made = 0;
  vi.useFakeTimers({ now, toFake: ["Date"] });
  const bots = [
    { id: "chief", name: "Clive", chiefOfStaff: true, section: "", threadId: "chief-main", tasks: [] as Array<{ threadId: string; title: string }> },
    ...Array.from({ length: botCount }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, section: "", threadId: `bot-${i}-main`, tasks: [] as Array<{ threadId: string; title: string }> })),
  ];
  const lines = new Map<string, Array<Record<string, unknown>>>();
  const store = {
    bots, bot: (id: string) => bots.find((one) => one.id === id),
    tasks: (id: string) => bots.find((one) => one.id === id)?.tasks ?? [],
    taskByThread: (id: string, threadId: string) => bots.find((one) => one.id === id)?.tasks.find((task) => task.threadId === threadId),
    groupByThread: () => undefined,
    createTask: (id: string, title: string) => {
      const task = { threadId: `thread-${++made}`, title };
      bots.find((one) => one.id === id)!.tasks.push(task);
      return task;
    },
    appendMessage: (threadId: string, row: Record<string, unknown>) => {
      const line = { id: `line-${++made}`, ...row, at: now };
      lines.set(threadId, [...(lines.get(threadId) ?? []), line]);
      return line;
    },
    patchMessage: (threadId: string, id: string, patch: Record<string, unknown>) => {
      const list = lines.get(threadId) ?? [], at = list.findIndex((line) => line.id === id);
      if (at < 0) return null;
      list[at] = { ...list[at], ...patch };
      return list[at];
    },
    messagesFor: (threadId: string) => lines.get(threadId) ?? [],
    activePath: (threadId: string) => lines.get(threadId) ?? [],
  };
  const chiefTurns: string[] = [], notified: string[] = [];
  const notices = createChiefNotices({
    store: store as never, notify: (notification) => { if (notification) notified.push(notification.threadId ?? ""); }, threadBusy: () => false, botAtThreadCapacity: () => false, groupTurnActive: () => false,
    startTurn: async (botId, text, opts) => { if (botId === "chief") chiefTurns.push(text); store.appendMessage(opts.threadId, { role: "user", kind: "text", text }); },
    assignerOf: () => undefined, schedule: (run) => run(), now: () => now,
  });
  const routineTurns: string[] = [];
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
    createTask: (botId, title) => store.createTask(botId, title),
    startTurn: async (_botId, threadId, prompt) => {
      routineTurns.push(threadId);
      store.appendMessage(threadId, { role: "user", kind: "text", text: prompt });
      if (refuseStart) throw new Error(failure(now));
    },
    promptSaid: (threadId, prompt) => store.messagesFor(threadId).some((line) => line.role === "user" && line.text === prompt),
    // As the host wires it: a failure the owner was already told of (alert null) reaches neither them nor a Chief.
    onRunFailed: (run, alert) => {
      const bot = store.bot(run.botId);
      if (!bot || alert === null) return;
      const said = alert?.detail ?? run.error;
      notices.reportIncident({ kind: "routine-failed", bot: bot as never, threadId: run.threadId ?? bot.threadId, detail: said ? `${run.routineName}: ${said}` : run.routineName });
    },
  });
  for (const bot of bots.slice(1)) manager.create({ name: `Sync for ${bot.name}`, prompt: "Read new leads from the CRM and file them", botId: bot.id, schedule: { type: "interval", everyMinutes: 5, anchorAt: START } });
  const running = () => manager.listRuns().filter((run: RoutineRun) => run.status === "running");
  return {
    routineTurns, chiefTurns, lines, notified, report: notices.reportIncident, bot: (id: string) => store.bot(id), task: (botId: string, title: string) => store.createTask(botId, title),
    /** A scheduler pass every minute up to `to`; each turn the pass before left running fails. */
    async passTo(to: number) {
      while (now < to) {
        now += MINUTE;
        vi.setSystemTime(now);
        for (const run of running()) manager.failThread(run.threadId!, failure(now));
        await manager.tick();
      }
    },
  };
}

describe("a failure's words, without what changes from run to run", () => {
  it("read the same for two runs that fail for one reason, and differently for another reason", () => {
    expect(failureShape(deadTool(START))).toBe(failureShape(deadTool(START + 5 * MINUTE)));
    expect(failureShape(spawnRefused(START))).toBe(failureShape(spawnRefused(START + 5 * MINUTE)));
    expect(failureShape("Request req_011CUa7xYz9 to /v1/messages failed: 529 overloaded")).toBe(failureShape("Request req_022ABb1qWe3 to /v1/messages failed: 529 overloaded"));
    expect(failureShape("Error in /home/omb/data/bots/7f3e9c2a-1b4d-4e8f-9a6b-2c1d3e4f5a6b/run.log line 12")).toBe(failureShape("Error in /home/omb/data/bots/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/run.log line 12"));
    expect(failureShape(deadTool(START))).not.toBe(failureShape("Claude is overloaded right now. Wait a minute, then run it again."));
  });

  it("keep exit codes, HTTP statuses and models apart", () => {
    expect(failureShape("claude exited 1 before result")).not.toBe(failureShape("claude exited 137 before result"));
    expect(failureShape("API Error: 503 Service Unavailable")).not.toBe(failureShape("API Error: 401 Unauthorized"));
    expect(failureShape("model not found: claude-sonnet-4-5-20250929")).not.toBe(failureShape("model not found: claude-opus-4-1-20250805"));
    expect(failureShape("model not found: gpt-5.1")).not.toBe(failureShape("model not found: gpt-5.2"));
  });
});

describe("a Chief told of a failure a retry cannot fix", () => {
  it("is told not to retry it, and why", () => {
    const text = incidentText({ kind: "routine-failed", bot: { id: "bot-0", name: "Bot 0" }, threadId: "t", detail: `Sync: ${deadTool(START)}` }, { count: 1, mayRetry: true, muted: false });
    expect(text).toContain("A retry cannot fix this: one of its tool servers is not running or not signed in");
    expect(text).toContain("Do not call retry_thread");
    expect(text).not.toContain("call retry_thread with");
  });

  it("is never told so by a routine's name", () => {
    const text = incidentText({ kind: "routine-failed", bot: { id: "bot-0", name: "Bot 0" }, threadId: "t", detail: "Rebalance my 401(k): The AI stopped before it answered",
      failure: { text: "The AI stopped before it answered" } }, { count: 1, mayRetry: true, muted: false });
    expect(text).not.toContain("A retry cannot fix this");
    expect(text).toContain('call retry_thread with bot_id "bot-0"');
  });

  it("is still told how to retry one a retry may fix", () => {
    const text = incidentText({ kind: "failed", bot: { id: "bot-0", name: "Bot 0" }, threadId: "t", detail: "Claude is overloaded right now (HTTP 529)." }, { count: 1, mayRetry: true, muted: false });
    expect(text).toContain('call retry_thread with bot_id "bot-0"');
  });
});

describe("a routine every 5 minutes whose tool server is dead, for a day", () => {
  it("starts 9 routine turns and 2 Chief turns: the first failure, and the one that spaces it out", async () => {
    const w = world(1, deadTool);
    await w.passTo(START + 24 * HOUR);
    console.log(`requests in 24 hours: ${w.routineTurns.length} routine turns + ${w.chiefTurns.length} Chief turns`);
    expect(w.routineTurns).toHaveLength(9);
    expect(w.chiefTurns).toHaveLength(2);
    expect(w.chiefTurns.every((text) => text.includes("A retry cannot fix this"))).toBe(true);
  });
});

describe("a routine every 5 minutes on a server whose engines cannot start, for a day", () => {
  // 9 runs, each started once more 30 s later while it waits for room; nothing reaches the AI until one starts.
  it("tries 18 starts in 9 runs and starts 2 Chief turns", async () => {
    const w = world(1, spawnRefused, true);
    await w.passTo(START + 24 * HOUR);
    console.log(`requests in 24 hours: ${w.routineTurns.length} routine starts tried + ${w.chiefTurns.length} Chief turns`);
    expect(w.routineTurns).toHaveLength(18);
    expect(new Set(w.routineTurns).size).toBe(9);
    expect(w.chiefTurns).toHaveLength(2);
  });
});

describe("twenty bots under one Chief whose routines all fail at once", () => {
  it("start no more Chief turns in an hour than OMB_CHIEF_INCIDENT_TURNS_PER_HOUR, and count the rest on one line", async () => {
    vi.stubEnv("OMB_CHIEF_INCIDENT_TURNS_PER_HOUR", "6");
    try {
      const w = world(20, (at) => `The AI stopped before it answered (${at})`);
      await w.passTo(START + INCIDENT_WINDOW_MS - MINUTE);
      console.log(`Chief turns in the first hour with 20 failing routines: ${w.chiefTurns.length}`);
      expect(w.chiefTurns).toHaveLength(6);
      const folded = [...w.lines.values()].flat().filter((row) => (row.tool as { name?: string } | undefined)?.name?.startsWith("Clive is asked about only so many"));
      expect(folded).toHaveLength(1);
      expect((folded[0]!.tool as { name: string }).name).toMatch(/^Clive is asked about only so many problems an hour, so \d+ more this hour were not sent to it\. From: Bot \d+ · Sync for Bot \d+/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("eight teammates' runs that stall within the hour, past a Chief's share of 6", () => {
  it("tell the person of the 2 the Chief is not started for, and list and link them on its one line", () => {
    vi.stubEnv("OMB_CHIEF_INCIDENT_TURNS_PER_HOUR", "6");
    try {
      const w = world(8, () => "");
      for (let i = 0; i < 8; i++) {
        const { threadId } = w.task(`bot-${i}`, `Job ${i}`);
        w.report({ kind: "stalled", bot: w.bot(`bot-${i}`) as never, threadId, detail: "no activity for 20 minutes" });
      }
      expect(w.chiefTurns).toHaveLength(6);
      expect(w.notified).toHaveLength(2);
      const [line] = [...w.lines.values()].flat().filter((row) => (row.tool as { name?: string } | undefined)?.name?.startsWith("Clive is asked about only so many"));
      expect((line!.tool as { name: string }).name).toBe("Clive is asked about only so many problems an hour, so 2 more this hour were not sent to it. From: Bot 6 · Job 6; Bot 7 · Job 7");
      expect(line!.threadRef).toMatchObject({ botId: "bot-7", title: "Job 7" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
