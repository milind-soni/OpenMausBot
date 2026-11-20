// A scheduled run and a cloud computer that is reported ready but does not answer, through the real scheduler, run gate,
// recovery, health check, readiness wait and Boat client, against a loopback stand-in for the Cloud's relay. The clock is
// the test's own; no server process and no AI engine is started, and nothing leaves this machine.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RUN_COMPUTER_LINES } from "../shared/cloud-computer-recovery.ts";
import type { AppConfig } from "./config.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

/** The fields are the provider's own, as seen on a silent computer. */
type Box = { id: string; name: string; state: string; health: string; hydrated?: boolean; lastSnapshotStatus?: string };

const BOX_ID = "bx_23456789";
const BOT = "bugfix-bot";
const cfg = {} as AppConfig;

let server: Server;
let box: Box;
/** Whether the machine behind the provider's "ready" answers commands, and whether a stop and resume fixes it. */
let answers = true;
let resumeFixes = false;
let requests: string[] = [];

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://relay.test").pathname.replace(/^\/relay\/api\/box\/v1/, "");
      requests.push(`${req.method} ${path}`);
      if (path === "/boxes") return send(res, 200, { ok: true, boxes: [box], pageInfo: { nextCursor: null } });
      const [, id, action] = /^\/boxes\/([^/]+)(?:\/(stop|resume|commands))?$/.exec(path) ?? [];
      if (id !== box.id) return send(res, 404, { ok: false, code: "not_found" });
      if (!action) return send(res, 200, { ok: true, box });
      if (action === "stop") { box.state = "archived"; return send(res, 200, { ok: true, box }); }
      if (action === "resume") {
        box.state = "idle";
        if (resumeFixes) { answers = true; box.hydrated = true; box.lastSnapshotStatus = "completed"; }
        return send(res, 200, { ok: true, box });
      }
      // The provider keeps saying idle and ok; only the command gets the relay's 502.
      if (!answers || box.state !== "idle") return send(res, 502, { ok: false, code: "upstream_unavailable", message: "Cloud computers could not be reached." });
      return send(res, 200, { exitCode: 0, stdout: "", stderr: "" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}/relay/api/box/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", "box_omb_synthetic");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const dirs: string[] = [];
let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { answers = true; resumeFixes = false; requests = []; });

async function world(watched = false) {
  vi.resetModules();
  const boat = await import("./boat.ts");
  const { createBoatHealth } = await import("./boat-health.ts");
  const { createBoatReadiness } = await import("./boat-ready.ts");
  const { createBoatRecovery } = await import("./boat-recovery.ts");
  const { cloudComputerCounters, createCloudComputerCounters } = await import("./cloud-computer-counters.ts");
  const { createRunComputerGate } = await import("./host/cloud-computer-run-gate.ts");
  const { RoutineManager } = await import("./routines.ts");

  const dir = mkdtempSync(join(tmpdir(), "omb-unattended-"));
  dirs.push(dir);
  box = { id: BOX_ID, name: await boat.boatNameFor(BOT), state: "idle", health: "ok", hydrated: true, lastSnapshotStatus: "completed" };
  let at = new Date(2026, 10, 14, 8, 0, 0).getTime();
  const now = () => at;
  const health = createBoatHealth(now);
  const counters = createCloudComputerCounters(now);
  const readiness = createBoatReadiness({ health, counters, now, 
    // A little real time passes with each wait, so the test's clock cannot run through the run's twenty minutes while
    // the recovery's own steps (real requests, a real pause between two reads of a waking computer) are still under way.
    // A longer wait (the gaps grow after a wake) takes a little longer, so the ratio stays about the same.
    sleep: async (ms) => { at += ms; await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.ceil(ms / 120)))); },
  });
  const told: string[] = [];
  const logged: string[] = [];
  const recovery = createBoatRecovery({
    cfg: () => cfg, tell: (_owner, line) => told.push(line), log: (line) => logged.push(line), file: join(dir, "boat-replacements.json"),
    now, health, pollMs: 5, recheckMs: 20, readiness, autoReplace: () => false, personActive: () => watched,
  });
  let manager: InstanceType<typeof RoutineManager>;
  const gate = createRunComputerGate({
    computerOf: () => BOT, find: (owner) => boat.findBoat(cfg, owner), wake: (owner, budgetMs) => boat.readyBoat(cfg, owner, budgetMs),
    awaitAnswer: (boxId, opts) => readiness.awaitAnswer(cfg, boxId, opts), verdict: (owner, since) => recovery.verdict(owner, since),
    recoveryState: (owner) => recovery.status(owner)?.state ?? null, used: () => {},
    routineOf: (botId, threadId) => { const run = manager.activeRunForBot(botId); return run?.threadId === threadId ? run.routineId : null; },
    log: (line) => logged.push(line), now,
  });
  const started: string[] = [];
  let tasks = 0;
  manager = new RoutineManager({
    file: join(dir, "routines.json"), now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++tasks}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
    prepareRun: (run, signal) => gate.prepare(run, signal), preparing: RUN_COMPUTER_LINES.waking,
  });
  close = () => { recovery.close(); manager.close?.(); };
  const event = (threadId: string, body: Record<string, unknown>) =>
    manager.handleRuntimeEvent({ eventId: `event-${Math.random()}`, provider: "fake", threadId, createdAt: new Date(0).toISOString(), ...body } as RuntimeEvent);
  const routine = manager.create({ name: "Fix bugs", prompt: "Fix the next bug on the cloud computer", botId: BOT, runOn: "cloud", schedule: { type: "interval", everyMinutes: 60, anchorAt: at } });
  const until = async (check: () => boolean, what: string, ms = 80_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 10))) if (check()) return;
    throw new Error(`timed out waiting for ${what}\n${logged.join("\n")}\n${JSON.stringify(manager.listRuns().map(({ status, error, attention }) => ({ status, error, attention })))}`);
  };
  /** The next scheduled occurrence comes due. */
  const occurrence = async () => {
    const before = new Set(manager.listRuns().map((run) => run.id));
    at = manager.listRoutines().find((candidate) => candidate.id === routine.id)!.nextRunAt!;
    await manager.tick();
    return manager.listRuns().find((run) => run.routineId === routine.id && !before.has(run.id))!;
  };
  const run = (id: string) => manager.listRuns().find((candidate) => candidate.id === id)!;
  /** As the turn's computer calls and its end reach the server. */
  const notes: string[] = [];
  const finishTurn = (threadId: string, lastCallAnswered = true) => {
    gate.callSettled(BOT, threadId, lastCallAnswered);
    const note = gate.turnEnded(threadId, true);
    if (note) notes.push(note);
    event(threadId, { type: "item.completed", itemType: "assistant_text", text: "Fixed." });
    event(threadId, { type: "turn.completed", ok: true });
  };
  const routineNow = () => manager.listRoutines().find((candidate) => candidate.id === routine.id)!;
  return { notes, boat, manager, gate, recovery, health, counters, restarts: () => cloudComputerCounters.snapshot(BOX_ID)?.restarts ?? 0, started, told, logged, occurrence, run, finishTurn, until, routineNow, advance: (ms: number) => { at += ms; }, now };
}

/** Each scenario makes a few hundred loopback requests; this leaves room on a busy machine. */
const SCENARIO_MS = 90_000;
const count = (line: string) => requests.filter((request) => request === line).length;

describe("a scheduled run whose cloud computer says ready but does not answer", () => {
  it("is held, the computer is restarted once, and the run then starts and completes", async () => {
    const w = await world();
    const first = await w.occurrence();
    expect(w.run(first.id).status).toBe("running");
    w.finishTurn(first.threadId!);
    expect(w.run(first.id).status).toBe("completed");

    answers = false;
    resumeFixes = true;
    const second = await w.occurrence();
    expect(w.run(second.id)).toMatchObject({ status: "queued", attention: RUN_COMPUTER_LINES.waking });
    expect(w.started).toHaveLength(1);
    await w.until(() => w.run(second.id).status === "running", "the held run to start");
    expect(count(`POST /boxes/${BOX_ID}/stop`)).toBe(1);
    expect(count(`POST /boxes/${BOX_ID}/resume`)).toBe(1);
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
    expect(w.started).toHaveLength(2);
    await w.until(() => w.recovery.status(BOT)?.state === "restarted", "the restart to be judged");
    expect(w.restarts()).toBe(1);
    expect(w.told).toEqual(["restarted"]);
    w.finishTurn(second.threadId ?? w.run(second.id).threadId!);
    expect(w.run(second.id).status).toBe("completed");
    expect(w.routineNow().enabled).toBe(true);
  }, SCENARIO_MS);

  it("ends with the reason when a restart does not help, deletes nothing, and the next occurrence runs normally", async () => {
    const w = await world();
    const first = await w.occurrence();
    w.finishTurn(first.threadId!);

    answers = false;
    const second = await w.occurrence();
    await w.until(() => w.run(second.id).status === "failed", "the held run to fail");
    expect(w.run(second.id).error).toBe(RUN_COMPUTER_LINES.afterRestart);
    expect(w.started).toHaveLength(1);
    expect(count(`POST /boxes/${BOX_ID}/stop`)).toBe(1);
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
    expect(w.routineNow()).toMatchObject({ enabled: true });
    expect(w.routineNow().nextRunAt).toBeGreaterThan(w.now());

    answers = true;
    const third = await w.occurrence();
    await w.until(() => w.run(third.id).status === "running", "the next occurrence to start");
    w.finishTurn(w.run(third.id).threadId!);
    expect(w.run(third.id).status).toBe("completed");
    expect(count(`POST /boxes/${BOX_ID}/stop`)).toBe(1);
  }, SCENARIO_MS);

  it("waits out a disk restore the provider reports, without a restart, when the computer answers inside ten minutes", async () => {
    const w = await world();
    const first = await w.occurrence();
    w.finishTurn(first.threadId!);

    answers = false;
    box.hydrated = false;
    box.lastSnapshotStatus = "in_progress";
    const second = await w.occurrence();
    const heldAt = w.now();
    await w.until(() => w.recovery.status(BOT)?.state === "restoring", "the recovery to see the restore");
    expect(w.recovery.refusal(BOX_ID, "before")).toMatch(/restoring its disk/);
    answers = true;
    await w.until(() => w.run(second.id).status === "running", "the held run to start");
    expect(w.now() - heldAt).toBeLessThan(10 * 60_000);
    expect(count(`POST /boxes/${BOX_ID}/stop`)).toBe(0);
  }, SCENARIO_MS);

  it("is not restarted under a person who is using it: the run says why and the schedule goes on", async () => {
    const w = await world(true);
    const first = await w.occurrence();
    w.finishTurn(first.threadId!);

    answers = false;
    const second = await w.occurrence();
    await w.until(() => w.run(second.id).status === "failed", "the held run to fail");
    expect(w.run(second.id).error).toBe(RUN_COMPUTER_LINES.personBusy);
    expect(count(`POST /boxes/${BOX_ID}/stop`)).toBe(0);
    expect(w.routineNow().enabled).toBe(true);
  }, SCENARIO_MS);

  it("leaves a run that finished as finished, with a note, when its last computer call got no answer: nothing is done twice", async () => {
    const w = await world();
    const first = await w.occurrence();
    w.finishTurn(first.threadId!);

    const second = await w.occurrence();
    await w.until(() => w.run(second.id).status === "running", "the run to start");
    w.finishTurn(w.run(second.id).threadId!, false);
    expect(w.run(second.id).status).toBe("completed");
    expect(w.run(second.id).retried).toBeUndefined();
    expect(w.notes).toEqual([RUN_COMPUTER_LINES.lastCallUnanswered]);
    expect(w.started).toHaveLength(2);
  }, SCENARIO_MS);

  it("starts a run a person asked for at once, without waiting on a silent computer", async () => {
    const w = await world();
    const first = await w.occurrence();
    w.finishTurn(first.threadId!);

    answers = false;
    const manual = w.manager.runNow(w.routineNow().id)!;
    await w.manager.tick();
    expect(w.run(manual.id)).toMatchObject({ status: "running", threadId: expect.any(String) });
    expect(w.started).toHaveLength(2);
  }, SCENARIO_MS);
});
