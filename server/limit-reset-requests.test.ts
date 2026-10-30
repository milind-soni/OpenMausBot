// A limit-reset automation from chat: the bot's create_trigger, the request service's card and Undo, and the stopped
// turn's "Continue when your limit resets" route, which creates it in that same conversation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { callTool, type ToolCallContext } from "./drivers/agents-call.ts";
import { LimitResetClock } from "./limit-resets.ts";
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestOptionCard, type RoutineRequestStore } from "./routine-requests.ts";
import { RoutineManager } from "./routines.ts";
import { continueInstructions, createLimitResetRoutes } from "./routes/limit-resets.ts";
import { PASS, type RouteContext } from "./routes/table.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class MemoryStore implements RoutineRequestStore {
  readonly threads = new Map<string, RoutineRequestMessage[]>();
  private sequence = 0;
  messagesFor(threadId: string) { return this.threads.get(threadId) ?? []; }
  appendMessage(threadId: string, message: { card: RoutineRequestOptionCard }) {
    const stored = { id: `message-${++this.sequence}`, card: message.card };
    this.threads.set(threadId, [...this.messagesFor(threadId), stored]);
    return stored;
  }
  patchMessage(threadId: string, messageId: string, patch: { card: RoutineRequestOptionCard }) {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (message) message.card = patch.card;
    return message ?? null;
  }
}

function harness(reset: number | null = NOW + 2 * HOUR) {
  const dir = mkdtempSync(join(tmpdir(), "omb-limit-requests-"));
  dirs.push(dir);
  const clock = new LimitResetClock({ accounts: () => [], now: () => NOW });
  if (reset !== null) clock.noteRefusal("claude", reset);
  const routines = new RoutineManager({
    file: join(dir, "routines.json"), now: () => NOW, botState: () => "ready", createTask: () => null, startTurn: async () => {},
    limitResetAt: (engine) => clock.resetAt(engine),
  });
  const store = new MemoryStore();
  const service = new RoutineRequestService({
    store, routines, now: () => NOW, timeZone: () => "UTC",
    engines: { name: (engine) => engine === "claude" ? "Claude" : engine, resetAt: (engine) => clock.resetAt(engine), botEngine: () => "claude" },
  });
  return { clock, routines, store, service };
}

describe("create_trigger when=limit_reset", () => {
  function tool() {
    const calls: Array<{ path: string; body?: any }> = [];
    const client = {
      api: async () => ({}),
      apiResponse: async (path: string, init: RequestInit) => {
        calls.push({ path, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, body: { resultId: "r-1", summary: "When Claude's usage limit resets" } };
      },
    };
    return { calls, context: { botId: "scout", threadId: "thread-1", depth: 0, externalRuntime: false, sharedComputers: false, client } as unknown as ToolCallContext };
  }

  it("sends a limit-reset schedule for the bot's own engine unless it names one", async () => {
    const { calls, context } = tool();
    const result = await callTool("create_trigger", { when: "limit_reset", name: "Finish the report", instructions: "Finish the report." }, context);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("for when the limit resets (trigger id r-1). It applied at once");
    expect(calls[0]).toEqual({ path: "/api/internal/trigger-requests", body: {
      fromBotId: "scout", fromThreadId: "thread-1", action: "create", kind: "schedule",
      routine: { name: "Finish the report", instructions: "Finish the report.", schedule: { type: "limit_reset", repeat: "once" } },
    } });
    await callTool("create_trigger", { when: "limit_reset", name: "Each", instructions: "Do it.", engine: "codex", repeat: "every_reset" }, context);
    expect(calls[1]!.body.routine.schedule).toEqual({ type: "limit_reset", engine: "codex", repeat: "every_reset" });
  });

  it("refuses what a limit reset cannot take, and limit fields on other kinds, before anything is sent", async () => {
    const { calls, context } = tool();
    expect((await callTool("create_trigger", { when: "limit_reset", name: "A", instructions: "B", schedule: { type: "daily", time: "09:00" } }, context)).text)
      .toContain("takes no schedule");
    expect((await callTool("create_trigger", { when: "limit_reset", name: "A", instructions: "B", repeat: "hourly" }, context)).text).toContain("repeat must be");
    expect((await callTool("create_trigger", { when: "schedule", name: "A", instructions: "B", engine: "claude", schedule: { type: "daily", time: "09:00" } }, context)).text)
      .toBe("engine applies only to when=limit_reset.");
    expect(calls).toEqual([]);
  });

  it("accepts a limit-reset schedule in manage_trigger's changes", async () => {
    const { calls, context } = tool();
    await callTool("manage_trigger", { trigger_id: "r-1", action: "update", changes: { schedule: { type: "limit_reset", engine: "claude" } } }, context);
    expect(calls[0]!.body.changes).toEqual({ schedule: { type: "limit_reset", engine: "claude", repeat: "once" } });
  });
});

describe("the request service", () => {
  it("applies a limit-reset create on the bot's engine with the derived time, in words on its card", async () => {
    const { routines, store, service } = harness();
    const result = await service.submit({ botId: "scout", threadId: "thread-1", proposal: { action: "create", routine: {
      name: "Finish the report", instructions: "Finish the report.", schedule: { type: "limit_reset" },
    } } });
    const routine = routines.listRoutines()[0]!;
    expect(routine).toMatchObject({ sourceThreadId: "thread-1", nextRunAt: NOW + 2 * HOUR + 60_000, schedule: { type: "limit_reset", engine: "claude", repeat: "once" } });
    expect(result.detail).toContain("Schedule: When Claude's usage limit resets");
    expect(result.detail).toContain("Next run: Oct 19, 2026, 12:01 PM");
    expect(result.detail).toContain("continue in this conversation");
    const card = store.messagesFor("thread-1")[0]!.card!;
    expect(card).toMatchObject({ autoApplied: true, answered: "allow" });
    expect(card.routineRequest!.undo!.schedule).toEqual({ type: "limit_reset", engine: "claude", repeat: "once" });
    expect(service.undo({ botId: "scout", threadId: "thread-1", requestId: card.requestId! })).toMatchObject({ state: "undone" });
    expect(routines.listRoutines()).toEqual([]);
  });

  it("says plainly when the reset time is not known yet", async () => {
    const { service } = harness(null);
    const result = await service.submit({ botId: "scout", threadId: "thread-1", proposal: { action: "create", routine: {
      name: "Later", instructions: "Do the rest.", schedule: { type: "limit_reset", engine: "claude", repeat: "every_reset" },
    } } });
    expect(result.detail).toContain("Schedule: Each time Claude's usage limit resets");
    expect(result.detail).toContain("Next run: When that limit resets (the time is not known yet)");
  });

  it("refuses the same automation twice, and resumes one whose time is not known", async () => {
    const { routines, service } = harness(null);
    const proposal = { action: "create", routine: { name: "A", instructions: "Do it.", schedule: { type: "limit_reset", engine: "claude" } } } as const;
    await service.submit({ botId: "scout", threadId: "thread-1", proposal });
    await expect(service.submit({ botId: "scout", threadId: "thread-1", proposal })).rejects.toThrow(/already exists/);
    const id = routines.listRoutines()[0]!.id;
    await service.submit({ botId: "scout", threadId: "thread-1", proposal: { action: "pause", routineId: id } });
    await expect(service.submit({ botId: "scout", threadId: "thread-1", proposal: { action: "resume", routineId: id } })).resolves.toMatchObject({ state: "applied" });
  });
});

describe("the limit-reset routes", () => {
  function routes(reset: number | null = NOW + 2 * HOUR) {
    const h = harness(reset);
    const created = vi.fn();
    const handler = createLimitResetRoutes({
      clock: h.clock, now: () => NOW, routines: h.routines, requests: h.service, engineName: (engine) => engine === "claude" ? "Claude" : engine,
      threadTitle: (botId, threadId) => botId === "scout" && threadId === "thread-1" ? "Quarterly report" : null,
      threadEngine: () => "claude", created,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      let status = 0, payload: any;
      const ctx = {
        req: {}, res: { setHeader: () => {} }, url: new URL(`http://x${path}`), path: path.split("?")[0], method, auth: { kind: "loopback", scopes: [] },
        json: (_res: unknown, code: number, value: unknown) => { status = code; payload = value; },
        readBody: async () => body ?? null,
      } as unknown as RouteContext;
      const out = await handler(ctx);
      return out === PASS ? null : { status, body: payload };
    };
    return { ...h, call, created };
  }

  it("Continue creates a one-time limit-reset automation in that same conversation, told the turn hit the limit", async () => {
    const { call, routines, store, created } = routes();
    const response = await call("POST", "/api/limit-resets/continue", { botId: "scout", threadId: "thread-1" });
    expect(response!.status).toBe(201);
    const routine = routines.listRoutines()[0]!;
    expect(response!.body.routine.id).toBe(routine.id);
    expect(routine).toMatchObject({
      name: "Continue “Quarterly report”", sourceThreadId: "thread-1", nextRunAt: NOW + 2 * HOUR + 60_000,
      schedule: { type: "limit_reset", engine: "claude", repeat: "once" },
    });
    expect(routine.prompt).toBe(continueInstructions("Quarterly report", "Claude"));
    expect(routine.prompt).toContain("cut off because Claude's usage limit was reached");
    expect(store.messagesFor("thread-1")[0]!.card).toMatchObject({ autoApplied: true });
    expect(created).toHaveBeenCalledWith(routine.id, expect.anything());
    const again = await call("POST", "/api/limit-resets/continue", { botId: "scout", threadId: "thread-1" });
    expect(again).toMatchObject({ status: 200, body: { routine: { id: routine.id } } });
    expect(routines.listRoutines()).toHaveLength(1);
  });

  it("Continue refuses a conversation that is not the bot's", async () => {
    const { call } = routes();
    expect(await call("POST", "/api/limit-resets/continue", { botId: "scout", threadId: "other" })).toMatchObject({ status: 404 });
    expect(await call("POST", "/api/limit-resets/continue", { botId: "scout" })).toMatchObject({ status: 400 });
  });

  it("lists each engine's limit and moves one automation past the reset", async () => {
    const { call, routines } = routes();
    expect((await call("GET", "/api/limit-resets"))!.body.engines).toEqual([expect.objectContaining({ engine: "claude", blocked: true, resetsAt: NOW + 2 * HOUR })]);
    const routine = routines.create({ name: "Brief", prompt: "Brief me.", botId: "scout", schedule: { type: "once", at: NOW + HOUR } });
    const moved = await call("POST", "/api/limit-resets/after-reset", { routineId: routine.id, engine: "claude" });
    expect(moved).toMatchObject({ status: 200, body: { routine: { nextRunAt: NOW + 2 * HOUR + 60_000 } } });
    expect(await call("POST", "/api/limit-resets/after-reset", { routineId: routine.id, engine: "codex" })).toMatchObject({ status: 409 });
    expect(await call("GET", "/api/elsewhere")).toBeNull();
  });
});
