// A loopback Boat with the provider's two real limits, scaled down a hundred times: a synchronous command is stopped at
// 30 s and answered 200 with `timedOut`, exit code 143 and SIGTERM; and the gateway answers 502 after 40 s when the
// computer is too slow to answer at all. No network, no real computer.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";

/** The provider's 30 s, as 300 ms, and its gateway's 40 s, as 400 ms. */
const WALL_MS = 300;
const GATEWAY_MS = 400;
const BOX = "bx_23456789";
const cfg = { box: { token: "synthetic-box-key" } } as AppConfig;

type Process = { id: number; command: string; startedAt: number; endsAt: number; exitCode: number; stdout: string };
let server: Server;
let processes: Process[] = [];
let requests: Array<{ method: string; path: string; detached: boolean; command?: string; tail?: number }> = [];
/** Status reads the gateway fails before it answers again; `forgetsDetached`: a relay that drops the flag; `gone`: the computer restarted. */
let failReads = 0;
let forgetsDetached = false;
let gone = false;
let truncates = false;
/** The computer is too slow to answer, so the gateway gives up on every synchronous command. */
let tooSlow = false;
/** The status read answers 200 with `known: false`, as the provider does for a process it has no record of. */
let unknownProcess = false;

/** `sleep <ms>; exit <code>` in the fake's own words: `ms:<n>` and `exit:<n>` anywhere in the command. */
const spec = (command: string) => ({ ms: Number(/ms:(\d+)/.exec(command)?.[1] ?? 5), exitCode: Number(/exit:(\d+)/.exec(command)?.[1] ?? 0) });
const running = (process: Process) => Date.now() < process.endsAt;
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(body)); };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const url = new URL(req.url ?? "/", "http://boat.test");
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method ?? "GET", path: url.pathname, detached: body.detached === true, ...(typeof body.command === "string" ? { command: body.command } : {}), ...(url.searchParams.has("tailBytes") ? { tail: Number(url.searchParams.get("tailBytes")) } : {}) });
    const read = /\/commands\/(\d+)$/.exec(url.pathname);
    if (read && req.method === "GET") {
      if (failReads > 0) { failReads--; return send(res, 502, { ok: false }); }
      const found = processes.find((process) => process.id === Number(read[1]));
      if (!found || gone) return send(res, 404, { ok: false, code: "not_found" });
      if (unknownProcess) return send(res, 200, { known: false, running: false, status: "unknown", exitCode: null, stdout: "", stderr: "" });
      const live = running(found);
      return send(res, 200, { running: live, status: live ? "running" : "exited", exitCode: live ? null : found.exitCode, stdout: live ? "partial" : found.stdout, stderr: "", ...(truncates ? { stdoutTruncated: true } : {}) });
    }
    if (!url.pathname.endsWith("/commands") || req.method !== "POST") return send(res, 404, { ok: false });
    const { ms, exitCode } = spec(String(body.command));
    const started: Process = { id: processes.length + 1, command: String(body.command), startedAt: Date.now(), endsAt: Date.now() + ms, exitCode, stdout: `ran ${ms}` };
    processes.push(started);
    if (body.detached === true && !forgetsDetached) return send(res, 200, { processId: started.id });
    if (tooSlow) { started.endsAt = started.startedAt; return void setTimeout(() => send(res, 502, { ok: false, code: "upstream_unavailable" }), GATEWAY_MS); }
    // Synchronous: the answer waits for the command, and at the limit the provider stops the process and says so.
    if (ms > WALL_MS) {
      started.endsAt = started.startedAt + WALL_MS;
      return void setTimeout(() => send(res, 200, { exitCode: 143, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }), WALL_MS);
    }
    setTimeout(() => send(res, 200, { exitCode, stdout: started.stdout, stderr: "" }), ms);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
});
afterAll(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

let boat: typeof import("./boat.ts");
let command: typeof import("./boat-command.ts");
let health: typeof import("./boat-health.ts");
beforeEach(async () => {
  processes = []; requests = []; failReads = 0; forgetsDetached = false; gone = false; truncates = false; tooSlow = false; unknownProcess = false;
  vi.resetModules();
  boat = await import("./boat.ts");
  command = await import("./boat-command.ts");
  health = await import("./boat-health.ts");
});
const posts = () => requests.filter((request) => request.method === "POST");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the provider's limits on a synchronous command", () => {
  it("stops a command at 30 s and says so: the result is marked as the provider's limit, not the command's own failure", async () => {
    const out = await boat.runCommand(cfg, BOX, `build ms:${WALL_MS * 2}`, { timeoutMs: command.COMMAND_WALL.syncSafeMs });
    expect(out).toMatchObject({ ok: false, exitCode: 143, timedOut: true, providerLimit: true });
    expect(posts()).toEqual([expect.objectContaining({ detached: false })]);
    await sleep(20);
    expect(running(processes[0]!)).toBe(false);
  });

  it("is never reached by a command sent the synchronous way: its caller gives up five seconds earlier", () => {
    expect(command.COMMAND_WALL.syncSafeMs).toBeLessThanOrEqual(25_000);
  });

  it("a gateway that gives up on a slow computer does not make it count as not responding: only a short probe that fails does", async () => {
    const silent: string[] = [];
    health.boatHealth.onNotResponding((boxId) => silent.push(boxId));
    tooSlow = true;
    for (let builds = 0; builds < 3; builds++) {
      expect(await boat.runCommand(cfg, BOX, "ls ms:5", { timeoutMs: command.COMMAND_WALL.syncSafeMs })).toMatchObject({ ok: false, exitCode: null, unanswered: true });
    }
    tooSlow = false;
    await vi.waitFor(() => expect(processes.some((process) => process.command === "true")).toBe(true), { timeout: 30_000 });
    expect(silent).toEqual([]);
    expect(health.boatHealth.notRespondingSince(BOX)).toBeNull();
  });
});

describe("the commands a bot's exec calls left running", () => {
  const start = async (ms: number) => {
    const response = await fetch(`${process.env.OMB_BOAT_API}/sandboxes/${BOX}/commands`, { method: "POST", body: JSON.stringify({ command: `serve ms:${ms}`, detached: true }) });
    return (await response.json() as { processId: number }).processId;
  };

  it("are counted while they run, and forgotten once they end", async () => {
    const server1 = await start(60_000), server2 = await start(60_000);
    command.noteLeftRunning(BOX, server1);
    command.noteLeftRunning(BOX, server2);
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(2);
    processes[0]!.endsAt = Date.now() - 1;
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(1);
    processes[0]!.endsAt = Date.now() + 60_000;
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(1);
  });

  it("are not counted when their status cannot be read, so a failing gateway never holds a bot at the limit", async () => {
    command.noteLeftRunning(BOX, await start(60_000));
    failReads = 1;
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(0);
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(1);
  });

  it("stop counting after two hours, the same time they may keep the computer awake", async () => {
    command.noteLeftRunning(BOX, await start(10 * 60 * 60_000));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + command.COMMAND_WALL.leftRunningMs);
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(0);
    clock.mockRestore();
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(0);
  });
});

describe("a command that may run long", () => {
  it("runs to its end however far past the provider's limit, once, with its own exit code and output", async () => {
    const out = await boat.runCommand(cfg, BOX, `build ms:${WALL_MS * 3} exit:2`);
    expect(out).toEqual({ ok: false, exitCode: 2, stdout: `ran ${WALL_MS * 3}`, stderr: "" });
    expect(requests.filter((request) => request.method === "GET" && request.tail === command.COMMAND_WALL.tailBytes)).toHaveLength(1);
    expect(posts()).toEqual([expect.objectContaining({ detached: true })]);
    expect(processes).toHaveLength(1);
    expect(command.trackedProcesses(BOX).size).toBe(0);
  });

  // A slow runner (a Windows one takes three to five times as long per request) still has to stay well under "seconds":
  // the count of status reads, which no machine's speed changes, is the tight half of this.
  it("keeps a quick command quick: a few status reads and well under two seconds on top of its own time", async () => {
    const took: number[] = [];
    for (let run = 0; run < 5; run++) {
      const before = Date.now();
      expect((await boat.runCommand(cfg, BOX, "pwd ms:200")).ok).toBe(true);
      took.push(Date.now() - before - 200);
    }
    const typical = [...took].sort((a, b) => a - b)[2]!;
    expect(typical).toBeLessThan(1_500);
    expect(requests.filter((request) => request.method === "GET").length).toBeLessThanOrEqual(5 * 4);
    expect(command.COMMAND_WALL.pollMs.slice(0, 3).reduce((sum, ms) => sum + ms, 0)).toBeLessThan(300);
  });

  it("hands back a command still running when the caller's time is up: timed out, with its process id, not stopped", async () => {
    const out = await boat.runCommand(cfg, BOX, "build ms:60000", { timeoutMs: command.COMMAND_WALL.syncSafeMs + 1 });
    expect(out).toMatchObject({ ok: false, exitCode: null, timedOut: true, processId: 1, stdout: "partial" });
    expect(running(processes[0]!)).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(command.trackedProcesses(BOX).has(1)).toBe(true);
    // Whoever only runs a helper command (the console, a meeting) adds nothing to a bot's count.
    expect(await command.commandsLeftRunning(cfg, BOX)).toBe(0);
  }, 45_000);

  it("reads a small tail while the command runs and the whole tail once, when it has ended", async () => {
    await boat.runCommand(cfg, BOX, "build ms:1500");
    const tails = requests.filter((request) => request.method === "GET").map((request) => request.tail);
    expect(tails.length).toBeGreaterThanOrEqual(3);
    expect(tails.at(-1)).toBe(command.COMMAND_WALL.tailBytes);
    expect(tails.slice(0, -1).every((tail) => tail === command.COMMAND_WALL.runningTailBytes)).toBe(true);
    expect(command.COMMAND_WALL.runningTailBytes).toBeLessThanOrEqual(12_000);
  });

  it("reads the status again when the gateway fails a read, without starting the command again", async () => {
    failReads = 3;
    const out = await boat.runCommand(cfg, BOX, "build ms:50");
    expect(out).toMatchObject({ ok: true, exitCode: 0 });
    expect(processes).toHaveLength(1);
  });

  it("says the command was lost when the computer no longer knows it", async () => {
    const pending = boat.runCommand(cfg, BOX, "build ms:2000");
    await sleep(100);
    gone = true;
    await expect(pending).resolves.toMatchObject({ ok: false, exitCode: null, lost: true, stderr: command.COMMAND_LOST });
  });

  it("says when only the end of the output came back", async () => {
    truncates = true;
    await expect(boat.runCommand(cfg, BOX, "cat ms:10")).resolves.toMatchObject({ ok: true, outputCut: true });
  });

  it("takes the result as it comes from a relay that does not forward the detached flag, the provider's limit included", async () => {
    forgetsDetached = true;
    await expect(boat.runCommand(cfg, BOX, "pwd ms:20")).resolves.toEqual({ ok: true, exitCode: 0, stdout: "ran 20", stderr: "" });
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(0);
    await expect(boat.runCommand(cfg, BOX, `build ms:${WALL_MS * 2}`)).resolves.toMatchObject({ ok: false, exitCode: 143, timedOut: true, providerLimit: true });
  });

  it("takes a process the provider says it does not know as lost", async () => {
    const pending = boat.runCommand(cfg, BOX, "build ms:20000");
    await vi.waitFor(() => expect(command.trackedProcesses(BOX).size).toBe(1), { timeout: 30_000 });
    unknownProcess = true;
    await expect(pending).resolves.toMatchObject({ ok: false, lost: true });
  });

  it("stops following, and throws, when the caller gives up", async () => {
    const abort = new AbortController();
    const pending = boat.runCommand(cfg, BOX, "build ms:5000", { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(command.trackedProcesses(BOX).size).toBe(1), { timeout: 30_000 });
    abort.abort();
    await rejected;
    // Nobody follows it any more, so it no longer keeps the computer awake.
    expect(command.trackedProcesses(BOX).size).toBe(0);
  });

  it("is sent the direct way when its caller gives it no more than the sync-safe time, and the probe always is", async () => {
    await boat.runCommand(cfg, BOX, "click ms:5", { timeoutMs: command.COMMAND_WALL.syncSafeMs });
    await boat.probeBoat(cfg, BOX);
    expect(posts().filter((request) => request.command === "click ms:5" || request.command === "true").map((request) => request.detached)).toEqual([false, false]);
  });
});
