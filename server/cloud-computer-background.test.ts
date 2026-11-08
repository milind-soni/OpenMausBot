// One loopback stub plays Boat (/boat/api/v1, sandboxes) and the Admin's included-Boat relay (/relay/api/box/v1, boxes).
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

const BOX = "bx_23456789", OTHER_BOX = "bx_3456789a";
const OWN_KEY = "boat_own-synthetic-key", INCLUDED = "box_omb_included-synthetic-token";
type Process = { polls: number; runningFor: number; exitCode: number | null; stdout: string; stderr: string; lost?: boolean };
let server: Server;
let base = "";
let tools: typeof import("./cloud-computer-tools.ts");
let background: typeof import("./cloud-computer-background.ts");
let journal: typeof import("./boat-delete-journal.ts");
const processes = new Map<string, Process>();
const calls: Array<{ method: string; path: string; query: string; body: any; authorization?: string }> = [];
let nextProcessId = 41;
let hold = false;
let holdStatusAfterFirst = false;
let syncReply: Record<string, unknown> = { exitCode: 0, stdout: "done", stderr: "" };
let startReply: { status: number; body: unknown } | undefined;
let statusReply: { status: number; body: unknown } | undefined;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const url = new URL(req.url ?? "/", "http://boat.test");
    calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null, authorization: req.headers.authorization });
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const route = /^(?:\/boat\/api\/v1\/sandboxes|\/relay\/api\/box\/v1\/boxes)\/(bx_[a-z0-9]{8})\/commands(?:\/(\d+))?$/.exec(url.pathname);
    if (!route) return send(404, { ok: false, code: "not_found", message: `unexpected ${req.method} ${url.pathname}` });
    const [, box, pid] = route;
    if (req.method === "POST" && !pid) {
      if (hold) return;
      if (startReply && JSON.parse(raw).detached) return send(startReply.status, startReply.body);
      if (!JSON.parse(raw).detached) return send(200, syncReply);
      const processId = nextProcessId++;
      processes.set(`${box}:${processId}`, { polls: 0, runningFor: 1, exitCode: 0, stdout: "", stderr: "" });
      return send(200, { ok: true, type: "command.started", success: true, processId, pid: 9000 + processId, command: "fixture", startedAt: new Date().toISOString() });
    }
    if (req.method === "GET" && pid) {
      if (hold) return;
      if (statusReply) return send(statusReply.status, statusReply.body);
      const process = processes.get(`${box}:${pid}`);
      if (!process) return send(404, { ok: false, code: "not_found", message: "No such process." });
      if (holdStatusAfterFirst && process.polls > 0) return;
      const running = process.polls++ < process.runningFor;
      return send(200, {
        ok: true, type: "command.status", success: true, processId: Number(pid), status: running ? "running" : process.lost ? "lost" : "exited", running,
        exitCode: running ? null : process.exitCode, signal: null, stdout: process.stdout, stderr: process.stderr,
      });
    }
    send(405, { ok: false });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  tools = await import("./cloud-computer-tools.ts");
  background = await import("./cloud-computer-background.ts");
  journal = await import("./boat-delete-journal.ts");
});
afterAll(async () => { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  calls.length = 0; processes.clear(); hold = false; holdStatusAfterFirst = false; startReply = undefined; statusReply = undefined;
  syncReply = { exitCode: 0, stdout: "done", stderr: "" };
});

type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
const json = (result: unknown) => JSON.parse((result as Result).content[0].text);

describe.each([
  ["your own Boat key", { box: { token: OWN_KEY } } as AppConfig, "/boat/api/v1/sandboxes", `Bearer ${OWN_KEY}`],
  ["the included Boat's relay", {} as AppConfig, "/relay/api/box/v1/boxes", `Bearer ${INCLUDED}`],
])("background commands with %s", (_label, cfg, root, authorization) => {
  beforeEach(() => {
    vi.stubEnv("BOX_TOKEN", undefined);
    vi.stubEnv("OMB_BOAT_API", `${base}/boat/api/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_URL", `${base}/relay/api/box/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", INCLUDED);
  });

  const call = (name: string, args: unknown, boxId = BOX, budgetMs?: number) => {
    let gated = 0, checks = 0;
    const done = tools.cloudComputerRpc({ method: "tools/call", params: { name, arguments: args } }, {
      cfg, boxId: () => boxId, signal: new AbortController().signal, ...(budgetMs ? { budgetMs } : {}),
      gate: async () => { gated++; return { held: false }; }, assertActive: () => { checks++; },
    }) as Promise<Result>;
    return { done, gated: () => gated, checks: () => checks };
  };
  const start = async (boxId = BOX) => json(await call("exec", { command: "python3 job.py > out.csv", background: true }, boxId).done).processId as string;

  it("starts a command detached, through the gate, and answers at once with a process id", async () => {
    const started = call("exec", { command: "python3 job.py > out.csv", background: true });
    const result = await started.done;
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ processId: expect.stringMatching(new RegExp(background.PROCESS_ID_PATTERN)), status: "running" });
    expect(json(result).next).toContain("completion will not automatically resume this turn or notify a delegator");
    expect(json(result).next).toContain("use exec_status with wait_seconds in this turn");
    expect(json(result).next).toContain("check its exit code and output");
    expect(json(result).next).toContain("report it as unfinished with the process_id");
    expect([started.gated(), started.checks()]).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: `${root}/${BOX}/commands`, authorization, body: { detached: true } });
    expect(Object.keys(calls[0].body).sort()).toEqual(["command", "detached"]);
    expect(calls[0].body.command).toContain("exec env -i");
    expect(calls[0].body.command).toContain("python3 job.py > out.csv");
  });

  it("reports a running command, then its exit code and output once it finishes", async () => {
    const processId = await start();
    const process = processes.get(`${BOX}:${processId.split("-")[1]}`)!;
    Object.assign(process, { exitCode: 3, stdout: "rows: 1200\n", stderr: "warning: slow disk\n" });
    expect(json(await call("exec_status", { process_id: processId }).done)).toEqual({ processId, status: "running", exitCode: null, stdout: "rows: 1200\n", stderr: "warning: slow disk\n" });
    const finished = await call("exec_status", { process_id: processId }).done;
    expect(finished.isError).not.toBe(true);
    expect(json(finished)).toEqual({ processId, status: "finished", exitCode: 3, stdout: "rows: 1200\n", stderr: "warning: slow disk\n" });
    const reads = calls.filter(entry => entry.method === "GET");
    expect(reads.map(entry => [entry.path, entry.query, entry.authorization])).toEqual(Array(2).fill([`${root}/${BOX}/commands/${processId.split("-")[1]}`, "?tailBytes=12000", authorization]));
  });

  it.each([0, 3])("keeps one background command through terminal exit %i", async (exitCode) => {
    const processId = await start();
    Object.assign(processes.get(`${BOX}:${processId.split("-")[1]}`)!, { runningFor: 1, exitCode, stdout: "receipt" });
    expect(json(await call("exec_status", { process_id: processId }).done)).toMatchObject({ status: "running", exitCode: null });
    expect(json(await call("exec_status", { process_id: processId, wait_seconds: 1 }).done)).toMatchObject({ status: "finished", exitCode, stdout: "receipt" });
    expect(calls.filter(entry => entry.method === "POST")).toHaveLength(1);
  });

  it("waits for the command to finish when asked, polling the computer rather than the bot", async () => {
    const processId = await start();
    Object.assign(processes.get(`${BOX}:${processId.split("-")[1]}`)!, { runningFor: 2, stdout: "loaded\n" });
    const began = Date.now();
    expect(json(await call("exec_status", { process_id: processId, wait_seconds: 30 }).done)).toMatchObject({ status: "finished", exitCode: 0, stdout: "loaded\n" });
    expect(Date.now() - began).toBeGreaterThanOrEqual(3_500);
    expect(calls.filter(entry => entry.method === "GET")).toHaveLength(3);
  });

  it("stops waiting when the wait is over and says the command is still running", async () => {
    const processId = await start();
    processes.get(`${BOX}:${processId.split("-")[1]}`)!.runningFor = 100;
    expect(json(await call("exec_status", { process_id: processId, wait_seconds: 3 }).done)).toMatchObject({ status: "running", exitCode: null });
    expect(calls.filter(entry => entry.method === "GET")).toHaveLength(3);
  });

  it.each([true, false])("honors a one-second wait and reports whether the command finished: %s", async (finishes) => {
    const processId = await start();
    Object.assign(processes.get(`${BOX}:${processId.split("-")[1]}`)!, { runningFor: finishes ? 1 : 100, exitCode: 3 });
    const began = Date.now();
    const result = json(await call("exec_status", { process_id: processId, wait_seconds: 1 }).done);
    expect(Date.now() - began).toBeGreaterThanOrEqual(700);
    expect(result).toMatchObject({ status: finishes ? "finished" : "running", exitCode: finishes ? 3 : null });
    expect(calls.filter(entry => entry.method === "GET")).toHaveLength(2);
  });

  it("bounds a stalled follow-up status read by the requested wait", async () => {
    const processId = await start();
    holdStatusAfterFirst = true;
    const began = Date.now();
    const result = await call("exec_status", { process_id: processId, wait_seconds: 1 }).done;
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Nothing was changed; call exec_status again") }] });
    expect(calls.filter(entry => entry.method === "GET")).toHaveLength(2);
    server.closeAllConnections();
  });

  it("propagates cancellation during a follow-up status read", async () => {
    const processId = await start();
    holdStatusAfterFirst = true;
    const controller = new AbortController();
    const pending = background.backgroundStatus(cfg, BOX, { process_id: processId, wait_seconds: 1 }, controller.signal);
    await expect.poll(() => calls.filter(entry => entry.method === "GET").length).toBe(2);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    server.closeAllConnections();
  });

  it("returns only the end of long output, and never half a character", async () => {
    const processId = await start();
    // 6,003 UTF-16 units: the last 4,000 begin on the second half of an emoji.
    const stdout = "😀".repeat(3_000) + "END", stderr = "e".repeat(5_000) + "LAST";
    Object.assign(processes.get(`${BOX}:${processId.split("-")[1]}`)!, { runningFor: 0, stdout, stderr });
    const status = json(await call("exec_status", { process_id: processId }).done);
    expect(status.stdout).toBe("😀".repeat(1_998) + "END");
    expect(status.stderr).toBe("e".repeat(background.STDERR_TAIL_CHARS - 4) + "LAST");
    expect(status.outputCut).toMatch(/Only the end of the output/);
  });

  it("refuses a process id from another computer without asking either computer", async () => {
    const theirs = await start(OTHER_BOX);
    calls.length = 0;
    const read = call("exec_status", { process_id: theirs });
    const refused = await read.done;
    expect(refused).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining("not from this cloud computer") }] });
    expect(read.gated()).toBe(1);
    const forged = `bg-${theirs.split("-")[1]}-00000000`;
    expect((await call("exec_status", { process_id: forged }).done).content[0].text).toContain("not from this cloud computer");
    await expect(background.backgroundStatus(cfg, BOX, { process_id: theirs }, new AbortController().signal)).resolves.toMatchObject({ isError: true });
    expect(calls).toEqual([]);
    expect(json(await call("exec_status", { process_id: theirs }, OTHER_BOX).done)).toMatchObject({ processId: theirs, status: "running" });
  });

  it.each([
    ["a bare number", "exec_status", { process_id: "42" }],
    ["a process id with shell syntax", "exec_status", { process_id: "bg-42-0000000a; reboot" }],
    ["a wait past the cap", "exec_status", { process_id: "bg-42-0000000a", wait_seconds: 61 }],
    ["an extra field", "exec_status", { process_id: "bg-42-0000000a", command: "true" }],
    ["a background flag that is not a boolean", "exec", { command: "true", background: "yes" }],
  ])("refuses %s before the gate or the computer", async (_label, name, args) => {
    const refused = call(name, args);
    expect(await refused.done).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/input schema/) }] });
    expect(refused.gated()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("says when the computer no longer knows the process, or lost track of it", async () => {
    expect((await call("exec_status", { process_id: background.processIdOn(BOX, 7) }).done).content[0].text).toContain("no background command with that process_id");
    const processId = await start();
    Object.assign(processes.get(`${BOX}:${processId.split("-")[1]}`)!, { runningFor: 0, lost: true, exitCode: null });
    expect(json(await call("exec_status", { process_id: processId }).done)).toMatchObject({ status: "lost", exitCode: null, note: expect.stringContaining("lost track") });
  });

  it("does not start or read a command on a computer that is being deleted", async () => {
    const processId = await start();
    journal.prepareBoatDeletion({ boxId: BOX, name: "ogb-0123456789ab-bot-abc123", ownerBotId: null });
    try {
      calls.length = 0;
      await expect(call("exec", { command: "true", background: true }).done).rejects.toMatchObject({ status: 409 });
      await expect(call("exec_status", { process_id: processId }).done).rejects.toMatchObject({ status: 409 });
      expect(calls).toEqual([]);
    } finally { journal.retireBoatDeletion(BOX); }
  });

  it("says a start may have happened when the computer failed mid-way, and never retries it", async () => {
    startReply = { status: 502, body: { ok: false, code: "boat_direct_failed", message: "upstream failed" } };
    const result = await call("exec", { command: "make all", background: true }).done;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("may have started");
    startReply = { status: 409, body: { ok: false, code: "sandbox_not_ready", message: "Resume it first." } };
    expect((await call("exec", { command: "make all", background: true }).done).content[0].text).not.toContain("may have started");
    expect(calls.filter(entry => entry.method === "POST")).toHaveLength(2);
  });

  it("reports the result when the computer service ran a background command to the end instead", async () => {
    startReply = { status: 200, body: { exitCode: 2, stdout: "x".repeat(5_000), stderr: "boom" } };
    const result = await call("exec", { command: "make all", background: true }).done;
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ status: "finished", exitCode: 2, stdout: "x".repeat(background.STDOUT_TAIL_CHARS), stderr: "boom", note: expect.stringContaining("to the end") });
    startReply = { status: 200, body: { ok: true } };
    expect((await call("exec", { command: "make all", background: true }).done).content[0].text).toContain("did not say which process it started");
    expect(calls.filter(entry => entry.method === "POST")).toHaveLength(2);
  });

  describe("keeping the computer awake", () => {
    /** Commands earlier tests left behind are gone from the fake, so this first check forgets them. */
    beforeEach(async () => {
      await background.backgroundCommandRunning(cfg, BOX);
      await background.backgroundCommandRunning(cfg, OTHER_BOX);
      calls.length = 0;
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("while a background command runs, and not once it has ended", async () => {
      const processId = await start();
      processes.get(`${BOX}:${processId.split("-")[1]}`)!.runningFor = 2;
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(true);
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(true);
      expect(await background.backgroundCommandRunning(cfg, OTHER_BOX)).toBe(false);
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(false);
      const reads = calls.filter(entry => entry.method === "GET");
      expect(reads.map(entry => [entry.path, entry.query, entry.authorization])).toEqual(Array(3).fill([`${root}/${BOX}/commands/${processId.split("-")[1]}`, "?tailBytes=1", authorization]));
      calls.length = 0;
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(false);
      expect(calls).toEqual([]);
    });

    it("not after exec_status saw the command end", async () => {
      const processId = await start();
      processes.get(`${BOX}:${processId.split("-")[1]}`)!.runningFor = 0;
      expect(json(await call("exec_status", { process_id: processId }).done)).toMatchObject({ status: "finished" });
      calls.length = 0;
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(false);
      expect(calls).toEqual([]);
    });

    it("while the computer cannot say, but never past the cap", async () => {
      await start();
      statusReply = { status: 503, body: { ok: false, message: "unavailable" } };
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(true);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + background.BACKGROUND_KEEPS_AWAKE_MS);
      calls.length = 0;
      expect(await background.backgroundCommandRunning(cfg, BOX)).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  it("tells the bot a plain exec that ran out of time may still be running, and not to repeat it blindly", async () => {
    hold = true;
    const late = await call("exec", { command: "sleep 600" }, BOX, 400).done;
    expect(late).toEqual({ isError: true, content: [{ type: "text", text: background.EXEC_LATE }] });
    expect(background.EXEC_LATE).toMatch(/may still be running.*do not run it again blindly.*background: true.*exec_status/s);
    server.closeAllConnections();
    hold = false;
    syncReply = { exitCode: null, stdout: "", stderr: "", timedOut: true };
    expect(await call("exec", { command: "sleep 600" }).done).toEqual({ isError: true, content: [{ type: "text", text: background.EXEC_LATE }] });
    expect(calls.filter(entry => entry.method === "POST")).toHaveLength(2);
  });

  it("answers a late start or status read with what is safe to do next", async () => {
    hold = true;
    expect((await call("exec", { command: "make all", background: true }, BOX, 300).done).content[0].text).toMatch(/did not confirm the start.*may have started/);
    server.closeAllConnections();
    expect((await call("exec_status", { process_id: background.processIdOn(BOX, 41) }, BOX, 300).done).content[0].text).toMatch(/Nothing was changed; call exec_status again/);
    server.closeAllConnections();
    expect((await call("get_screen_size", {}, BOX, 300).done).content[0].text).toBe(tools.CLOUD_COMPUTER_LATE);
    server.closeAllConnections();
  });
});
