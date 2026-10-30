// A cloud computer turns itself off after use. One stub plays the Admin's Boat relay and records every call, and the
// server's idle window is cut from ten minutes to IDLE_MS, so each journey can say exactly when a computer went to sleep.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");
const INCLUDED = `box_omb_${randomUUID()}`;
const IDLE_MS = 1_500;
const FRAME = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
// A logged, always-failing docker stands in for a VPS; the fixture is a POSIX shell script.
const FAKE_DOCKER = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"\nexit 1\n`;

type Row = { id: string; name?: string; state: string };
type Call = { method: string; path: string; at: number };

describe("a cloud computer goes to sleep after use and wakes on the next", () => {
  let home = "";
  let data = "";
  let gate = "";
  let usesGate = "";
  let dockerLog = "";
  let base = "";
  let child: ChildProcess | null = null;
  let output = "";
  let relay: Server;
  const rows: Row[] = [];
  const calls: Call[] = [];
  const boxId = (n: number) => `bx_${"23456789abcdefgh"[n]}3456789`;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${JSON.stringify(calls.slice(-30))}\n${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const stopsOf = (id: string) => calls.filter(call => call.method === "POST" && call.path === `/boxes/${id}/stop`);
  const resumesOf = (id: string) => calls.filter(call => call.method === "POST" && call.path === `/boxes/${id}/resume`);
  const rowOf = (name: string | undefined) => rows.find(row => row.name === name)!;
  const task = async (botId: string) => (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId);
  const idle = (botId: string) => until(() => task(botId), bot => bot?.busy === false);
  const busy = (botId: string) => until(() => task(botId), bot => bot?.busy === true);
  const send = (botId: string, text: string) => apiOk("POST", `/api/bots/${botId}/messages`, { text });
  const newBot = async (name: string, patch: Record<string, unknown>) => {
    const { bot } = await apiOk("POST", "/api/bots", { name });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { browser: false, ...patch });
    return bot as { id: string; name: string; threadId: string };
  };
  const model = (instanceId: string) => ({ modelSelection: { instanceId, model: "claude-sonnet-5" } });

  async function launch() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const relayBase = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_BOAT_API: `${relayBase}/own-key-must-not-be-used`,
        OMB_CLOUD_BOAT_URL: `${relayBase}/relay/api/box/v1`,
        OMB_CLOUD_BOAT_TOKEN: INCLUDED,
        OMB_CLOUD_COMPUTER_IDLE_MS: String(IDLE_MS),
        ...(process.platform === "win32" ? {} : { OMB_EXTRA_PATH: join(home, "bin"), FAKE_DOCKER_LOG: dockerLog }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (child!.exitCode !== null) throw new Error(`the server exited:\n${output}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, Boolean, 30_000);
  }

  beforeAll(async () => {
    relay = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://relay.test");
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const path = url.pathname.replace(/^\/relay\/api\/box\/v1/, "");
        calls.push({ method: req.method ?? "GET", path, at: Date.now() });
        if (req.headers.authorization !== `Bearer ${INCLUDED}` || !url.pathname.startsWith("/relay/api/box/v1")) {
          return send(401, { ok: false, code: "unauthorized", message: "Unauthorized" });
        }
        const body = raw ? JSON.parse(raw) : {};
        if (path === "/boxes" && req.method === "GET") return send(200, { ok: true, boxes: rows, pageInfo: { nextCursor: null } });
        if (path === "/boxes" && req.method === "POST") {
          const row = { id: boxId(rows.length), state: "provisioning" };
          rows.push(row);
          return send(201, { ok: true, box: row });
        }
        const [, id = "", verb = ""] = /^\/boxes\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
        const row = rows.find(candidate => candidate.id === id);
        if (!row) return send(404, { ok: false, code: "not_found", message: "Not found" });
        if (!verb && req.method === "PATCH") {
          row.name = body.name;
          return send(200, { ok: true, box: row });
        }
        if (!verb && req.method === "GET") {
          const seen = { ...row };
          if (row.state === "provisioning" || row.state === "resuming") row.state = "ready";
          return send(200, { ok: true, box: seen });
        }
        if (verb === "resume" && req.method === "POST") {
          row.state = "resuming";
          return send(200, { ok: true, box: row });
        }
        if (verb === "stop" && req.method === "POST") {
          row.state = "archived";
          return send(200, { ok: true, box: row });
        }
        if (verb === "desktop" && req.method === "POST") return send(200, { desktopUrl: `https://desktop.invalid/${row.id}` });
        if (verb === "commands" && req.method === "POST") return send(200, { exitCode: 0, stdout: "captured", stderr: "" });
        if (verb === "artifacts" && req.method === "GET") {
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(FRAME.length) });
          return res.end(FRAME);
        }
        send(404, { ok: false, code: "not_found", message: "Not found" });
      });
    });
    await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));

    home = mkdtempSync(join(tmpdir(), "omb-cloud-sleep-"));
    data = join(home, "data");
    gate = join(home, "finish");
    usesGate = join(home, "finish-uses");
    dockerLog = join(home, "docker.log");
    mkdirSync(data, { recursive: true });
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "docker"), FAKE_DOCKER);
    chmodSync(join(home, "bin", "docker"), 0o755);
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
      // Every turn first takes one screenshot through the cloud computer's tools, as a model's first computer call does.
      uses: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" } },
      // Works until the gate file exists, touching no computer.
      slow: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate } },
      // One screenshot, then works until its own gate file exists.
      usesSlow: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE }, environment: {
        FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1", FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: usesGate,
      } },
    } }));
    await launch();
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (relay) await new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); });
    if (home) await removeTempDir(home);
  });

  let worker: { id: string; name: string; threadId: string };
  let workerBox = "";

  it("a bot's computer sleeps one idle window after its turn ends, and the next turn wakes it", async () => {
    worker = await newBot("Worker", { ...model("uses"), computer: "cloud" });
    await send(worker.id, "Take a screenshot of your desktop");
    await idle(worker.id);
    const turnEnded = Date.now();
    expect(rows).toHaveLength(1);
    workerBox = rows[0]!.id;
    expect(stopsOf(workerBox)).toEqual([]);

    const [stop] = await until(() => stopsOf(workerBox), found => found.length === 1);
    expect(stop!.at - turnEnded).toBeGreaterThanOrEqual(IDLE_MS - 500);
    expect(rows[0]!.state).toBe("archived");
    // Chrome is asked to exit before the stop, so its profile is saved.
    const quiesce = calls.findLastIndex(call => call.path === `/boxes/${workerBox}/commands` && call.at <= stop!.at);
    expect(quiesce).toBeGreaterThan(-1);

    await send(worker.id, "Look again");
    await idle(worker.id);
    expect(resumesOf(workerBox)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    await until(() => stopsOf(workerBox), found => found.length === 2);
  }, 90_000);

  it("a turn shorter than the window on a computer already on: the window starts when the turn ends", async () => {
    await apiOk("POST", `/api/bots/${worker.id}/computer/provision`, {});
    await apiOk("PATCH", `/api/bots/${worker.id}`, model("usesSlow"));
    const before = stopsOf(workerBox).length;
    rmSync(usesGate, { force: true });
    const asked = calls.length;
    await send(worker.id, "Check the desktop, then keep working");
    await until(() => calls.slice(asked).some(call => call.path === `/boxes/${workerBox}/artifacts`), Boolean);
    await pause(IDLE_MS * 0.8);
    writeFileSync(usesGate, "finish");
    await idle(worker.id);
    const turnEnded = Date.now();
    const stops = await until(() => stopsOf(workerBox), found => found.length === before + 1);
    // Timed from when the turn began, it would sleep under IDLE_MS * 0.2 after the end.
    expect(stops.at(-1)!.at - turnEnded).toBeGreaterThanOrEqual(IDLE_MS - 500);
    await apiOk("PATCH", `/api/bots/${worker.id}`, model("uses"));
  }, 60_000);

  it("a person watching its live screen keeps it on; it sleeps once they stop", async () => {
    await apiOk("POST", `/api/bots/${worker.id}/computer/provision`, {});
    const before = stopsOf(workerBox).length;
    const watchUntil = Date.now() + IDLE_MS * 3;
    let lastFrame = 0;
    while (Date.now() < watchUntil) {
      const frame = await api("POST", `/api/bots/${worker.id}/computer/screenshot?threadId=${worker.threadId}`, {});
      expect(frame.status, JSON.stringify(frame.body)).toBe(200);
      lastFrame = Date.now();
      await pause(300);
    }
    expect(stopsOf(workerBox)).toHaveLength(before);
    const stops = await until(() => stopsOf(workerBox), found => found.length === before + 1);
    expect(stops.at(-1)!.at - lastFrame).toBeGreaterThanOrEqual(IDLE_MS - 500);
  }, 60_000);

  it("a person holding its desktop keeps it on, however briefly; handing it back starts the window", async () => {
    await apiOk("POST", `/api/bots/${worker.id}/computer/provision`, {});
    const before = stopsOf(workerBox).length;
    const control = (action: "take" | "release") => apiOk("POST", `/api/bots/${worker.id}/computer/control`, { action });
    expect((await control("take")).held).toBe(true);
    await pause(IDLE_MS * 3);
    expect(stopsOf(workerBox)).toHaveLength(before);
    expect(rowOf(rows[0]!.name).state).toBe("ready");
    expect((await control("release")).held).toBe(false);
    await pause(IDLE_MS * 0.2);
    expect((await control("take")).held).toBe(true);
    await pause(IDLE_MS * 0.5);
    expect((await control("release")).held).toBe(false);
    const released = Date.now();
    const stops = await until(() => stopsOf(workerBox), found => found.length === before + 1);
    expect(stops.at(-1)!.at - released).toBeGreaterThanOrEqual(IDLE_MS - 250);
  }, 60_000);

  let teamBox = "";
  let ada: { id: string; name: string; threadId: string };
  let ben: { id: string; name: string; threadId: string };

  it("a team's shared computer sleeps only once every bot on the team is idle", async () => {
    const requestId = randomUUID();
    await apiOk("POST", "/api/team-computers", { requestId, name: "Ops desktop", acknowledgeCost: true });
    teamBox = rows.at(-1)!.id;
    ada = await newBot("Ada", { ...model("uses"), section: "Ops" });
    ben = await newBot("Ben", { ...model("slow"), section: "Ops", computer: "off" });
    await apiOk("PATCH", `/api/team-computers/${requestId}`, { section: "Ops", acknowledgeSharedAccess: true });

    rmSync(gate, { force: true });
    await send(ben.id, "Draft the quarterly plan");
    await busy(ben.id);
    await send(ada.id, "Take a screenshot of the team desktop");
    await idle(ada.id);
    const quietFrom = stopsOf(teamBox).length;
    expect(rows.find(row => row.id === teamBox)!.state).toBe("ready");

    await pause(IDLE_MS * 3);
    expect(stopsOf(teamBox)).toHaveLength(quietFrom);

    writeFileSync(gate, "finish");
    await idle(ben.id);
    const teamIdle = Date.now();
    const stops = await until(() => stopsOf(teamBox), found => found.length === quietFrom + 1);
    expect(stops.at(-1)!.at - teamIdle).toBeGreaterThanOrEqual(IDLE_MS - 500);
  }, 90_000);

  it("after a restart, every computer this installation left on gets the same idle window", async () => {
    await waitForExit(child!, { signal: "SIGTERM" });
    child = null;
    for (const id of [workerBox, teamBox]) rows.find(row => row.id === id)!.state = "ready";
    const before = { worker: stopsOf(workerBox).length, team: stopsOf(teamBox).length };
    const started = Date.now();
    await launch();
    await until(() => [stopsOf(workerBox).length, stopsOf(teamBox).length], ([w, t]) => w === before.worker + 1 && t === before.team + 1);
    expect(stopsOf(workerBox).at(-1)!.at - started).toBeGreaterThanOrEqual(IDLE_MS);
    expect(rows.every(row => row.state === "archived")).toBe(true);
  }, 90_000);

  // A routine due within 30 minutes keeps the computer it will use on: waking it again would spend one start from the
  // Boat account's shared pool. These routines are scheduled minutes ahead and never run during the journey.
  const routineAt = (botId: string, inMs: number) => apiOk("POST", "/api/routines", {
    name: "Inbox sweep", prompt: "Sweep the inbox", botId, schedule: { type: "once", at: Date.now() + inMs },
  }).then(body => body.routine as { id: string; nextRunAt: number });

  it("a routine due within 30 minutes keeps its bot's computer on; paused, two hours away, or with the computer off, it does not", async () => {
    await apiOk("POST", `/api/bots/${worker.id}/computer/provision`, {});
    const before = stopsOf(workerBox).length;
    const routine = await routineAt(worker.id, 20 * 60_000);
    await pause(IDLE_MS * 3);
    expect(stopsOf(workerBox)).toHaveLength(before);

    await apiOk("PATCH", `/api/routines/${routine.id}`, { enabled: false });
    const paused = Date.now();
    const stops = await until(() => stopsOf(workerBox), found => found.length === before + 1);
    expect(stops.at(-1)!.at - paused).toBeGreaterThanOrEqual(IDLE_MS - 500);

    await apiOk("PATCH", `/api/routines/${routine.id}`, { enabled: true, schedule: { type: "once", at: Date.now() + 2 * 60 * 60_000 } });
    await apiOk("POST", `/api/bots/${worker.id}/computer/provision`, {});
    const on = Date.now();
    const later = await until(() => stopsOf(workerBox), found => found.length === before + 2);
    expect(later.at(-1)!.at - on).toBeLessThan(IDLE_MS * 3);

    // Switched to Off, the bot's routine no longer uses that computer, so it does not hold it either.
    await apiOk("PATCH", `/api/routines/${routine.id}`, { schedule: { type: "once", at: Date.now() + 20 * 60_000 } });
    await apiOk("POST", `/api/bots/${worker.id}/computer/provision`, {});
    await apiOk("PATCH", `/api/bots/${worker.id}`, { computer: "off" });
    const off = Date.now();
    const offStops = await until(() => stopsOf(workerBox), found => found.length === before + 3);
    expect(offStops.at(-1)!.at - off).toBeLessThan(IDLE_MS * 3);
    await apiOk("PATCH", `/api/bots/${worker.id}`, { computer: "cloud" });
    await apiOk("DELETE", `/api/routines/${routine.id}`);
  }, 60_000);

  it("a teammate's routine keeps the team's shared computer on; one for a teammate whose computer is off does not", async () => {
    const cy = await newBot("Cy", { ...model("uses"), section: "Ops" });
    const teammate = await routineAt(cy.id, 20 * 60_000);
    const offline = await routineAt(ben.id, 20 * 60_000);
    await send(ada.id, "Take a screenshot of the team desktop");
    await idle(ada.id);
    const before = stopsOf(teamBox).length;
    expect(rows.find(row => row.id === teamBox)!.state).toBe("ready");
    await pause(IDLE_MS * 3);
    expect(stopsOf(teamBox)).toHaveLength(before);

    await apiOk("DELETE", `/api/routines/${teammate.id}`);
    await until(() => stopsOf(teamBox), found => found.length === before + 1);
    await apiOk("DELETE", `/api/routines/${offline.id}`);
  }, 60_000);

  it.skipIf(process.platform === "win32")("never touches a VPS: its activity starts no idle stop of any kind", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps" } })).status).toBe(200);
    const vee = await newBot("Vee", { ...model("uses"), computer: "cloud", cloudBackend: "vps" });
    const before = calls.length;
    await api("POST", `/api/bots/${vee.id}/computer/screenshot?threadId=${vee.threadId}`, {});
    await apiOk("POST", `/api/bots/${vee.id}/computer/control`, { action: "take" });
    await apiOk("POST", `/api/bots/${vee.id}/computer/control`, { action: "release" });
    await pause(IDLE_MS * 3);
    expect(calls.slice(before)).toEqual([]);
    const docker = existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "";
    expect(docker.split("\n").filter(line => /\b(stop|rm|kill|pause)\b/.test(line))).toEqual([]);
  }, 60_000);
});
