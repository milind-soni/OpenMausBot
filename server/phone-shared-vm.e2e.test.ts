// The real server with the Local VM's container boundary replaced (group-local-vm-hooks.mjs) and a stub Boat: a person
// takes the one shared Local VM from a phone or the desktop, and every bot working on it waits until they hand it back.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { CONTROL_HANDED_BACK } from "./control-client.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Stands in for the 60 s grace, so an unbeaten phone hold lapses within a test. */
const GRACE_MS = 4_000;
const CALL_WAIT_MS = 3_000;
/** Stands in for the viewer proxy's 5 s re-check, so it beats inside the grace. */
const RECHECK_MS = 500;
const READY = { containers: ["shared"] };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lease = () => randomUUID().replaceAll("-", "");

describe("a person's hold on the shared Local VM", () => {
  let home = "";
  let base = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let boatServer: Server;
  let boatRow: { id: string; name: string; state: string } | null = null;
  let holdBoatList: Promise<void> | null = null;
  let boatListHeld = false;
  const boatCalls: string[] = [];
  let phoneToken = "";
  let witness = "";
  let sse: SseRecorder;
  let startServer = async () => {};
  const created: string[] = [];

  const vmState = (state: Record<string, unknown> = READY) => writeFileAtomic(stateFile, JSON.stringify(state));
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const api = (method: string, path: string, body?: unknown) => call(method, path, body);
  const phone = (method: string, path: string, body?: unknown) => call(method, path, body, { authorization: `Bearer ${phoneToken}` });
  const ok = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-3000)}`);
      await sleep(40);
    }
  }
  const query = (threadId?: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ ...(threadId ? { threadId } : {}), ...extra }).toString();
    return params ? `?${params}` : "";
  };
  const control = (as: typeof api, botId: string, body?: Record<string, unknown>, threadId?: string) =>
    as(body ? "POST" : "GET", `/api/bots/${botId}/computer/control${query(threadId)}`, body);
  const held = async (botId: string, threadId?: string) => (await control(api, botId, undefined, threadId)).body.held as boolean;
  const joinVm = (botId: string, controlLeaseId: string, threadId?: string) =>
    phone("POST", `/api/bots/${botId}/local-computer/join${query(threadId, { controlLeaseId })}`, {});
  const viewer = (target: string, botId: string, controlLeaseId: string, threadId?: string) =>
    phone("GET", `/api/desktop-viewer/${target}${query(threadId, { botId, controlLeaseId })}`);
  const setMode = (mode: "shared" | "per-bot" | "pool") => ok("PATCH", "/api/config", { localVm: { mode } });
  /** The rig reads the window from the state file whenever the idle timer's window is set. */
  const setIdleMinutes = (idleTimeoutMinutes: number) => ok("PATCH", "/api/config", { localVm: { idleTimeoutMinutes } });
  const newBot = async (name: string, patch: Record<string, unknown> = {}) => {
    const { bot } = await ok("POST", "/api/bots", { name });
    await ok("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: null, ...patch });
    created.push(bot.id);
    return bot as { id: string; threadId: string };
  };
  const newTask = async (botId: string, surface?: string) => {
    const { task } = await ok("POST", `/api/bots/${botId}/tasks`, {});
    if (surface) await ok("PATCH", `/api/bots/${botId}/tasks/${task.threadId}`, { surface });
    return task.threadId as string;
  };
  const dumpFor = (text: string) => until<any>(() => {
    if (!existsSync(dumpFile)) return null;
    try {
      const sent = JSON.parse(readFileSync(dumpFile, "utf8"));
      return JSON.stringify(sent.prompt ?? "").includes(text) ? sent : null;
    } catch { return null; }
  }, Boolean);
  const busy = async (botId: string, threadId: string) => (await ok("GET", "/api/bots?messages=0")).bots
    .find((bot: any) => bot.id === botId)?.tasks?.find((task: any) => task.threadId === threadId)?.busy === true;
  /** Starts a slow turn and answers with its MCP mounts once the fake engine has it. */
  const startTurn = async (botId: string, threadId: string) => {
    const text = `Work on the desktop ${randomUUID()}`;
    await ok("POST", `/api/bots/${botId}/messages`, { text, threadId });
    const servers = (await dumpFor(text)).mcpConfig.mcpServers;
    return { computer: servers.computer, comms: servers.agents.env.OMB_COMMS_TOKEN as string };
  };
  const finishTurns = async (...turns: Array<[string, string]>) => {
    writeFileSync(finishFile, "finish");
    for (const [botId, threadId] of turns) await until(() => busy(botId, threadId), value => !value);
    rmSync(finishFile, { force: true });
  };
  const gate = async (computer: any) => (await fetch(computer.env.OMB_CONTROL_URL, {
    headers: { authorization: `Bearer ${computer.env.OMB_CONTROL_TOKEN}` },
  })).json() as Promise<any>;
  const askSignIn = async (comms: string, site: string) => {
    const response = await fetch(`${base}/api/internal/request-sign-in`, {
      method: "POST", headers: { authorization: `Bearer ${comms}`, "content-type": "application/json" }, body: JSON.stringify({ site }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { messageId: string }).messageId;
  };
  /** The computer-control frames for this bot sent after `since` frames had arrived. */
  const framesFor = (botId: string, since: number) =>
    sse.frames.slice(since).filter(frame => frame.kind === "computer-control" && frame.botId === botId);

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-phone-shared-vm-"));
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    vmState();
    const data = join(home, "data");
    const ui = join(home, "static");
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Shared VM takeover</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    boatServer = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://box.fixture").pathname;
      boatCalls.push(`${req.method} ${path}`);
      res.setHeader("content-type", "application/json");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (path === "/sandboxes" && req.method === "POST") {
        boatRow = { id: "bx_23456789", name: body.name ?? "fixture-box", state: "idle" };
        return res.end(JSON.stringify({ sandbox: boatRow }));
      }
      if (path === "/sandboxes") {
        if (holdBoatList) { boatListHeld = true; await holdBoatList; }
        return res.end(JSON.stringify({ sandboxes: boatRow ? [boatRow] : [] }));
      }
      if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid/" }));
      if (path.endsWith("/resume") && boatRow) { boatRow.state = "idle"; return res.end("{}"); }
      if (/^\/sandboxes\/bx_[^/]+$/.test(path)) {
        const row = boatRow?.id === path.slice("/sandboxes/".length) ? boatRow : null;
        if (req.method === "DELETE") { if (row) boatRow = null; return res.end("{}"); }
        if (!row) res.statusCode = 404;
        else if (req.method === "PATCH" && body.name) row.name = body.name;
        return res.end(JSON.stringify(row ? { sandbox: row } : { error: "missing" }));
      }
      return res.end("{}");
    });
    await new Promise<void>(resolve => boatServer.listen(0, "127.0.0.1", resolve));
    writeFileSync(join(data, "config.json"), JSON.stringify({ box: { token: "box_one" }, instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    startServer = async () => {
      child = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
        join(ROOT, "server/index.ts")], {
        cwd: ROOT, env: {
          PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
          APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
          TEMP: home, TMP: home, TMPDIR: home,
          OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
          OMB_BOAT_API: `http://127.0.0.1:${(boatServer.address() as { port: number }).port}`,
          OMB_COMPUTER_CALL_WAIT_MS: String(CALL_WAIT_MS), OMB_TEST_LEASE_GRACE_MS: String(GRACE_MS),
          OMB_TEST_VIEWER_RECHECK_MS: String(RECHECK_MS),
        }, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", chunk => { output += chunk; });
      child.stderr!.on("data", chunk => { output += chunk; });
      await until(async () => {
        if (child!.exitCode !== null) throw new Error(`the server exited:\n${output}`);
        try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
      }, Boolean, 30_000);
    };
    await startServer();
    const seeded = (await ok("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
    if (seeded) await ok("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
    const { code } = await ok("POST", "/api/auth/pairing", {});
    const paired = await fetch(`${base}/api/auth/pair`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "Fixture phone" }, body: JSON.stringify({ code }),
    });
    phoneToken = ((await paired.json()) as { token: string }).token;
    witness = (await newBot("Witness")).id;
    created.length = 0;
    sse = await openSse(`${base}/api/events`);
  }, 60_000);

  afterEach(async () => {
    holdBoatList = null;
    writeFileSync(finishFile, "finish");
    // A bot a person's hold reaches cannot be deleted, so every hold a test left goes first.
    await control(api, witness, { action: "release" });
    const bots = (await api("GET", "/api/bots?messages=0")).body?.bots ?? [];
    for (const botId of created.splice(0)) {
      const tasks: Array<{ threadId: string }> = bots.find((bot: any) => bot.id === botId)?.tasks ?? [];
      for (const threadId of [undefined, ...tasks.map(task => task.threadId)]) await control(api, botId, { action: "release" }, threadId);
      await api("POST", `/api/bots/${botId}/interrupt`, {});
      await api("DELETE", `/api/bots/${botId}`);
    }
    rmSync(finishFile, { force: true });
    rmSync(dumpFile, { force: true });
    vmState();
    await setMode("shared");
    await control(api, witness, { action: "release" });
  }, 30_000);

  afterAll(async () => {
    sse?.close();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (boatServer) await new Promise<void>(resolve => boatServer.close(() => resolve()));
    if (home) await removeTempDir(home);
  });

  it("a phone's take of one Auto bot holds the shared desktop for every bot, and its join and viewer open that desktop", async () => {
    const [a, b] = [await newBot("Ada"), await newBot("Bea")];
    const id = lease();
    expect((await control(phone, a.id, { action: "take", controlLeaseId: id })).body).toMatchObject({ held: true, owned: true });
    expect(await held(b.id)).toBe(true);
    const joined = await joinVm(a.id, id);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.socketPath).toMatch(/^api\/desktop-viewer\/local\/shared\/websockify\?/);
    expect(joined.body.password).toBe("fixture-vnc");
    expect(await viewer("local/shared", a.id, id)).toEqual({ status: 200, body: { password: "fixture-vnc" } });
    expect((await control(phone, a.id, { action: "release", controlLeaseId: id })).body.released).toBe(true);
    expect(await held(b.id)).toBe(false);
  });

  it.each(["shared", "per-bot"] as const)("a phone's Local VM hold in %s mode lapses a grace after its last beat; a desktop's and a phone's cloud hold do not", async mode => {
    await setMode(mode);
    const [a, desk, cloud] = [await newBot("Ada"), await newBot("Desk"), await newBot("Cumulus", { computer: "cloud" })];
    const [id, deskId, cloudId] = [lease(), lease(), lease()];
    const since = sse.frames.length;
    const takenAt = Date.now();
    expect((await control(phone, a.id, { action: "take", controlLeaseId: id })).body.owned).toBe(true);
    if (mode === "per-bot") expect((await control(api, desk.id, { action: "take", controlLeaseId: deskId })).body.owned).toBe(true);
    expect((await control(phone, cloud.id, { action: "take", controlLeaseId: cloudId })).body.owned).toBe(true);
    await sleep(GRACE_MS / 2);
    expect((await control(phone, a.id, { action: "check", controlLeaseId: lease() })).body.owned).toBe(false);
    expect((await control(phone, a.id, { action: "check", controlLeaseId: id })).body.owned).toBe(true);
    await sleep(takenAt + GRACE_MS + 600 - Date.now());
    expect(await held(a.id)).toBe(true);
    await until(() => held(a.id), value => !value, GRACE_MS * 2);
    await until(() => framesFor(a.id, since).at(-1)?.held, value => value === false);
    if (mode === "per-bot") expect(await held(desk.id)).toBe(true);
    expect(await held(cloud.id)).toBe(true);
  }, 30_000);

  it("a desktop take of the shared desktop never lapses", async () => {
    const id = lease();
    expect((await control(api, witness, { action: "take", controlLeaseId: id })).body.owned).toBe(true);
    await sleep(GRACE_MS + 1_000);
    expect(await held(witness)).toBe(true);
  }, 20_000);

  it("a phone whose join finds the VM not ready still loses its hold a grace later", async () => {
    vmState({ ...READY, stopped: ["shared"] });
    const a = await newBot("Ada");
    const id = lease();
    expect((await control(phone, a.id, { action: "take", controlLeaseId: id })).body.owned).toBe(true);
    const refused = await joinVm(a.id, id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("fixture desktop unavailable");
    await until(() => held(a.id), value => !value, GRACE_MS * 2);
  }, 20_000);

  it("a bot working on the shared VM waits through a person's hold, and the call that waited is not performed", async () => {
    const worker = await newBot("Worker", { computer: "vm" });
    const { computer } = await startTurn(worker.id, worker.threadId);
    expect(await gate(computer)).toEqual({ held: false, helpOpen: false });
    await control(api, witness, { action: "take" });
    expect(await gate(computer)).toMatchObject({ held: true, reason: "person" });
    const waiting = gate(computer);
    await sleep(500);
    await control(api, witness, { action: "release" });
    expect((await waiting).blockedReason).toBe(CONTROL_HANDED_BACK);
    expect(await gate(computer)).toEqual({ held: false, helpOpen: false });
    await finishTurns([worker.id, worker.threadId]);
  }, 30_000);

  it("a new turn that must start the shared VM waits for a person's hand-back as 'A person is using it', then claims it", async () => {
    vmState({ ...READY, stopped: ["shared"] });
    await control(api, witness, { action: "take" });
    const worker = await newBot("Worker", { computer: "vm" });
    const text = `Start the desktop ${randomUUID()}`;
    await ok("POST", `/api/bots/${worker.id}/messages`, { text, threadId: worker.threadId });
    await until(() => ok("GET", `/api/threads/${worker.threadId}/messages?limit=50`),
      page => JSON.stringify(page).includes("A person is using it."));
    expect(existsSync(dumpFile)).toBe(false);
    await control(api, witness, { action: "release" });
    expect((await dumpFor(text)).mcpConfig.mcpServers.computer).toBeTruthy();
    await finishTurns([worker.id, worker.threadId]);
  }, 30_000);

  it("a person's hold keeps the shared VM from its idle stop, and a take waits out its image update", async () => {
    vmState({ ...READY, idleMs: 300 });
    const id = lease();
    expect((await control(api, witness, { action: "take", controlLeaseId: id })).body.owned).toBe(true);
    expect((await call("POST", `/api/bots/${witness}/local-computer/join${query(undefined, { controlLeaseId: id })}`, {})).status).toBe(200);
    await setIdleMinutes(5);
    await sleep(1_500);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).actions ?? []).toEqual([]);
    await control(api, witness, { action: "release", controlLeaseId: id });
    await until(() => JSON.parse(readFileSync(stateFile, "utf8")).stopped ?? [], stopped => stopped.includes("shared"));
    vmState();
    await setIdleMinutes(480);

    vmState({ ...READY, holdPull: true });
    const pulling = api("POST", "/api/local-computer/pull", {});
    await sleep(300);
    const refused = await control(api, witness, { action: "take" });
    expect(refused.status).toBe(409);
    expect(await held(witness)).toBe(false);
    vmState();
    expect((await pulling).status).toBe(200);
    expect((await control(api, witness, { action: "take" })).body.held).toBe(true);
  }, 30_000);

  it("a person's hold on the shared desktop refuses moving an Auto bot off it, and a take waits out a mode change", async () => {
    const a = await newBot("Ada");
    await control(api, a.id, { action: "take" });
    const moved = await api("PATCH", `/api/bots/${a.id}`, { computer: "cloud" });
    expect(moved.status).toBe(409);
    await control(api, a.id, { action: "release" });

    let releaseBoat = () => {};
    holdBoatList = new Promise(resolve => { releaseBoat = resolve; });
    boatListHeld = false;
    const changing = api("PATCH", "/api/config", { box: { token: "box_two" }, localVm: { mode: "per-bot" } });
    await until(() => boatListHeld, Boolean);
    const refused = await control(api, a.id, { action: "take" });
    holdBoatList = null;
    releaseBoat();
    expect(refused.status).toBe(409);
    expect((await changing).status).toBe(200);
  }, 30_000);

  it("a Local VM mode change ends the shared desktop's hold and every hold whose key it changes, and keeps the rest", async () => {
    const [a, cloud] = [await newBot("Ada"), await newBot("Cumulus", { computer: "cloud" })];
    await control(api, a.id, { action: "take" });
    await control(api, cloud.id, { action: "take" });
    await setMode("per-bot");
    expect(await held(a.id)).toBe(false);
    expect(await held(witness)).toBe(false);
    expect(await held(cloud.id)).toBe(true);
    await control(api, a.id, { action: "take" });
    await setMode("shared");
    expect(await held(a.id)).toBe(false);
    expect(await held(cloud.id)).toBe(true);
  }, 30_000);

  it("only a person's Done on the shared desktop's last open sign-in card hands it back", async () => {
    const [a, b] = [await newBot("Ada", { computer: "vm" }), await newBot("Bea", { computer: "vm" })];
    const asked = await startTurn(b.id, b.threadId);
    await askSignIn(asked.comms, "b.example");
    await finishTurns([b.id, b.threadId]);
    const own = await startTurn(a.id, a.threadId);
    const [first, second] = [await askSignIn(own.comms, "a.example"), await askSignIn(own.comms, "c.example")];
    await finishTurns([a.id, a.threadId]);

    await control(api, a.id, { action: "take" });
    await ok("POST", `/api/bots/${b.id}/messages`, { text: "I signed in to b.example myself.", threadId: b.threadId });
    await until(() => ok("GET", `/api/threads/${b.threadId}/messages?limit=50`),
      page => page.messages.some((message: any) => message.signIn?.answeredInChat));
    expect(await held(a.id)).toBe(true);
    await ok("POST", `/api/bots/${a.id}/sign-in-cards/${first}/done`, { threadId: a.threadId });
    expect(await held(a.id)).toBe(true);
    await ok("POST", `/api/bots/${a.id}/sign-in-cards/${second}/done`, { threadId: a.threadId });
    expect(await held(a.id)).toBe(false);
  }, 60_000);

  it("a change on a bot's own key while the shared desktop is held still tells its panels it is held", async () => {
    const a = await newBot("Ada");
    const elsewhere = await newTask(a.id, "cloud");
    const start = sse.frames.length;
    await control(api, witness, { action: "take" });
    await until(() => framesFor(a.id, start), frames => frames.length === 1);
    await control(api, a.id, { action: "take" }, elsewhere);
    await until(() => framesFor(a.id, start), frames => frames.length === 2);
    const since = sse.frames.length;
    await control(api, a.id, { action: "release" }, elsewhere);
    await until(() => framesFor(a.id, since), frames => frames.length > 0);
    expect(framesFor(a.id, since).at(-1)).toMatchObject({ held: true });
  });

  it("deleting a bot takes its sign-in request off the shared desktop", async () => {
    const b = await newBot("Bea", { computer: "vm" });
    const asked = await startTurn(b.id, b.threadId);
    await askSignIn(asked.comms, "b.example");
    await finishTurns([b.id, b.threadId]);
    expect((await control(api, witness)).body.helpReason).toBe("sign in to b.example");
    await ok("DELETE", `/api/bots/${b.id}`);
    expect((await control(api, witness)).body.helpReason).toBeNull();
  }, 30_000);

  it("a cloud bot's conversation pinned to the shared VM takes, asks and pauses on the shared desktop", async () => {
    const books = await newBot("Books", { computer: "cloud" });
    const pinned = await newTask(books.id, "vm");
    const asked = await startTurn(books.id, pinned);
    const card = await askSignIn(asked.comms, "ledger.example");
    await finishTurns([books.id, pinned]);
    expect((await control(api, witness)).body.helpReason).toBe("sign in to ledger.example");

    const since = sse.frames.length;
    await control(api, books.id, { action: "take" }, pinned);
    expect(await held(witness)).toBe(true);
    await until(() => framesFor(books.id, since).at(-1)?.held, value => value === true);
    const worker = await newBot("Tickets", { computer: "vm" });
    const { computer } = await startTurn(worker.id, worker.threadId);
    expect(await gate(computer)).toMatchObject({ held: true, reason: "person" });
    await ok("POST", `/api/bots/${books.id}/sign-in-cards/${card}/done`, { threadId: pinned });
    expect(await held(witness)).toBe(false);
    expect(await gate(computer)).toEqual({ held: false, helpOpen: false });
    await finishTurns([worker.id, worker.threadId]);

    const own = lease();
    expect((await control(phone, books.id, { action: "take", controlLeaseId: own })).body.owned).toBe(true);
    expect((await joinVm(books.id, own)).status).toBe(409);
    expect((await control(phone, books.id, { action: "release", controlLeaseId: own })).body.released).toBe(true);

    const there = lease();
    expect((await control(phone, books.id, { action: "take", controlLeaseId: there }, pinned)).body.owned).toBe(true);
    expect(await held(witness)).toBe(true);
    await ok("PATCH", `/api/bots/${books.id}/tasks/${pinned}`, { surface: "cloud" });
    expect((await control(phone, books.id, { action: "release", controlLeaseId: there })).body.released).toBe(true);
    expect(await held(witness)).toBe(false);
  }, 60_000);

  it("a thread-less take of an Auto bot keeps its Boat in use and pauses its conversation on the cloud too", async () => {
    const a = await newBot("Ada");
    const scope = createHash("sha256").update(readFileSync(join(home, "data", "environment-id"), "utf8").trim()).digest("hex").slice(0, 12);
    const name = `ogb-${scope}-${a.id.slice(0, 8).replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(a.id).digest("hex").slice(0, 6)}`;
    boatRow = { id: "bx_abcdefgh", name, state: "idle" };
    try {
      const onCloud = await newTask(a.id, "cloud");
      const { computer } = await startTurn(a.id, onCloud);
      // A Boat's tools reach the gate through the harness proxy, with the turn's computer capability.
      const boatGate = () => gate({ env: { OMB_CONTROL_URL: `${base}/api/internal/computer-control?botId=${a.id}`, OMB_CONTROL_TOKEN: computer.env.OMB_MCP_TOKEN_COMPUTER } });
      expect(await boatGate()).toEqual({ held: false, helpOpen: false });
      await control(api, a.id, { action: "take" });
      expect(await boatGate()).toMatchObject({ held: true, reason: "person" });
      await finishTurns([a.id, onCloud]);
      const boxes = (await ok("GET", "/api/computers/boxes")).instances;
      expect(boxes.find((instance: { ownerBotId: string }) => instance.ownerBotId === a.id)).toMatchObject({ inUse: true });
    } finally {
      await control(api, a.id, { action: "release" });
      boatRow = null;
    }
  }, 30_000);

  // One row per place a person's hold can land; `key` is where the design puts it.
  it.each([
    { row: "shared, Auto", mode: "shared", key: "desk" },
    { row: "shared, cloud, thread on the VM", mode: "shared", computer: "cloud", pin: "vm", inThread: true, key: "desk" },
    { row: "shared, cloud, no thread", mode: "shared", computer: "cloud", pin: "vm", key: "own" },
    { row: "shared, Auto, thread on this computer", mode: "shared", pin: "local", inThread: true, key: "own" },
    { row: "per-bot, Auto", mode: "per-bot", key: "own" },
    { row: "pool, Auto", mode: "pool", key: "own" },
    { row: "team cloud computer", mode: "shared", team: true, key: "team" },
  ] as const)("every path a person takes resolves the same control key: $row", async (row: {
    mode: "shared" | "per-bot" | "pool"; key: "desk" | "own" | "team"; computer?: string; pin?: string; inThread?: boolean; team?: boolean;
  }) => {
    await setMode(row.mode);
    const section = row.team ? `Team ${randomUUID()}` : undefined;
    const subject = await newBot("Subject", { ...(row.computer ? { computer: row.computer } : {}), ...(section ? { section } : {}) });
    const mate = section ? (await newBot("Mate", { section })).id : null;
    if (section) {
      const requestId = randomUUID();
      await ok("POST", "/api/team-computers", { requestId, name: "Team desktop", acknowledgeCost: true });
      await ok("PATCH", `/api/team-computers/${requestId}`, { section, acknowledgeSharedAccess: true });
    }
    const pinned = row.pin ? await newTask(subject.id, row.pin) : undefined;
    const threadId = row.inThread ? pinned : undefined;
    const desk = row.key === "desk";
    const id = lease();

    expect((await control(phone, subject.id, { action: "take", controlLeaseId: id }, threadId)).body.owned).toBe(true);
    expect(await held(subject.id, threadId)).toBe(true);
    expect(await held(witness)).toBe(desk);
    if (mate) expect(await held(mate)).toBe(true);

    const target = row.mode === "per-bot" ? `local/bot-${createHash("sha256").update(subject.id).digest("hex")}`
      : row.mode === "pool" ? "local/pool-0" : "local/shared";
    const [joined, viewed] = [await joinVm(subject.id, id, threadId), await viewer(target, subject.id, id, threadId)];
    if (desk) {
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(viewed.status, JSON.stringify(viewed.body)).toBe(200);
    } else {
      expect([joined.status, viewed.status]).toEqual([409, 409]);
      expect(joined.body.socketPath).toBeUndefined();
      const refusal = row.mode === "pool" ? expect.stringContaining("pool mode")
        : row.mode === "per-bot" ? expect.not.stringContaining("Take control") : "Take control of this computer first";
      expect(viewed.body.error).toEqual(refusal);
    }

    expect((await control(phone, subject.id, { action: "check", controlLeaseId: id }, threadId)).body.owned).toBe(true);
    expect((await control(phone, subject.id, { action: "release", controlLeaseId: id }, threadId)).body.released).toBe(true);
    expect(await held(subject.id, threadId)).toBe(false);

    const since = sse.frames.length;
    await control(api, witness, { action: "take" });
    await until(() => framesFor(witness, since), frames => frames.length > 0);
    await sleep(200);
    expect(framesFor(subject.id, since).length > 0).toBe(row.mode === "shared" && !row.team);
  }, 30_000);

  it("the panel's release, sent without its conversation, ends the hold it took there", async () => {
    const a = await newBot("Ada");
    const elsewhere = await newTask(a.id, "cloud");
    const id = lease();
    expect((await control(api, a.id, { action: "take", controlLeaseId: id }, elsewhere)).body.owned).toBe(true);
    expect((await control(api, a.id, { action: "release", controlLeaseId: id })).body.released).toBe(true);
    expect(await held(a.id, elsewhere)).toBe(false);
  });

  it("a closing viewer's release by its open's lease, without a conversation, frees that Boat hold and leaves a phone's hold on the shared desktop", async () => {
    const a = await newBot("Ada");
    const onCloud = await newTask(a.id, "cloud");
    await control(phone, witness, { action: "take" });
    const id = lease();
    expect((await control(api, a.id, { action: "take", controlLeaseId: id }, onCloud)).body.owned).toBe(true);
    expect((await control(api, a.id, { action: "release", controlLeaseId: id })).body.released).toBe(true);
    expect(await held(witness)).toBe(true);
  });

  it("a leased take through an Auto bot that a phone's hold on the shared desktop refuses, and that take's leased release, leave the phone holding it", async () => {
    const a = await newBot("Ada");
    const phoneLease = lease();
    expect((await control(phone, witness, { action: "take", controlLeaseId: phoneLease })).body.owned).toBe(true);
    const id = lease();
    expect((await control(api, a.id, { action: "take", controlLeaseId: id })).body).toMatchObject({ held: true, owned: false });
    expect((await control(api, a.id, { action: "release", controlLeaseId: id })).body.released).toBe(false);
    expect((await control(phone, witness, { action: "check", controlLeaseId: phoneLease })).body.owned).toBe(true);
  });

  it("the bot list tells a cloud bot with a conversation on the shared desktop that a person holds it", async () => {
    const books = await newBot("Books", { computer: "cloud" });
    await newTask(books.id, "vm");
    await control(api, witness, { action: "take" });
    expect((await ok("GET", "/api/bots?messages=0")).computerControl[books.id]).toMatchObject({ held: true });
  });

  it("a bot a person's hold on the shared desktop reaches cannot be deleted until the hand-back", async () => {
    const a = await newBot("Ada");
    await control(api, witness, { action: "take" });
    const refused = await api("DELETE", `/api/bots/${a.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Hand back control of this bot's computer before deleting it");
    expect((await ok("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.id === a.id)).toBe(true);
    await control(api, witness, { action: "release" });
    expect((await api("DELETE", `/api/bots/${a.id}`)).status).toBe(200);
  }, 30_000);

  it("deleting a bot the shared desktop's hold does not reach leaves that hold", async () => {
    const cloud = await newBot("Cumulus", { computer: "cloud" });
    await control(api, witness, { action: "take" });
    expect((await api("DELETE", `/api/bots/${cloud.id}`)).status).toBe(200);
    expect(await held(witness)).toBe(true);
  }, 30_000);

  it("a cloud bot being deleted is kept with its Boat when a person takes the shared desktop its conversation is pinned to, through another bot, while the deletion reads the cloud inventory", async () => {
    const a = await newBot("Books", { computer: "cloud" });
    await newTask(a.id, "vm");
    const scope = createHash("sha256").update(readFileSync(join(home, "data", "environment-id"), "utf8").trim()).digest("hex").slice(0, 12);
    const name = `ogb-${scope}-${a.id.slice(0, 8).replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(a.id).digest("hex").slice(0, 6)}`;
    boatRow = { id: "bx_keptbxat", name, state: "idle" };
    try {
      let releaseBoat = () => {};
      holdBoatList = new Promise(resolve => { releaseBoat = resolve; });
      boatListHeld = false;
      const deleting = api("DELETE", `/api/bots/${a.id}`);
      await until(() => boatListHeld, Boolean);
      await control(api, witness, { action: "take" });
      holdBoatList = null;
      releaseBoat();
      const refused = await deleting;
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error).toBe("Hand back control of this bot's computer before deleting it");
      expect((await ok("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.id === a.id)).toBe(true);
      expect([boatRow?.id, boatCalls.includes("DELETE /sandboxes/bx_keptbxat")]).toEqual(["bx_keptbxat", false]);
    } finally {
      boatRow = null;
    }
  }, 30_000);

  it("another device's hold on the shared desktop leaves a cloud bot's Boat turn running until a panel takes that conversation's computer", async () => {
    const books = await newBot("Books", { computer: "cloud" });
    await newTask(books.id, "vm");
    const scope = createHash("sha256").update(readFileSync(join(home, "data", "environment-id"), "utf8").trim()).digest("hex").slice(0, 12);
    const name = `ogb-${scope}-${books.id.slice(0, 8).replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(books.id).digest("hex").slice(0, 6)}`;
    boatRow = { id: "bx_bkwtqrsz", name, state: "idle" };
    try {
      const { computer } = await startTurn(books.id, books.threadId);
      const boatGate = () => gate({ env: { OMB_CONTROL_URL: `${base}/api/internal/computer-control?botId=${books.id}`, OMB_CONTROL_TOKEN: computer.env.OMB_MCP_TOKEN_COMPUTER } });
      await control(api, witness, { action: "take" });
      expect((await ok("GET", "/api/bots?messages=0")).computerControl[books.id]).toMatchObject({ held: true });
      expect(await boatGate()).toEqual({ held: false, helpOpen: false });
      const id = lease();
      expect((await control(api, books.id, { action: "take", controlLeaseId: id }, books.threadId)).body).toMatchObject({ held: true, owned: true });
      expect(await boatGate()).toMatchObject({ held: true, reason: "person" });
      expect((await control(api, books.id, { action: "release", controlLeaseId: id })).body.released).toBe(true);
      await finishTurns([books.id, books.threadId]);
    } finally {
      boatRow = null;
    }
  }, 30_000);

  it("a phone's take of the shared desktop that nothing ever beats lapses a grace later", async () => {
    const a = await newBot("Ada");
    expect((await control(phone, a.id, { action: "take", controlLeaseId: lease() })).body.owned).toBe(true);
    await until(() => held(a.id), value => !value, GRACE_MS * 2);
  }, 20_000);

  it("an open viewer of the shared desktop keeps the phone's hold past the grace, and its close lets the hold lapse", async () => {
    const websockify = createServer();
    websockify.on("upgrade", (req, socket) => {
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.on("error", () => {});
      socket.on("end", () => socket.end());
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise<void>(resolve => websockify.listen(0, "127.0.0.1", resolve));
    vmState({ ...READY, viewerPort: (websockify.address() as { port: number }).port });
    const client = createConnection({ host: "127.0.0.1", port: Number(new URL(base).port) });
    try {
      const a = await newBot("Ada");
      const id = lease();
      expect((await control(phone, a.id, { action: "take", controlLeaseId: id })).body.owned).toBe(true);
      let response = "";
      client.setEncoding("utf8");
      client.on("data", chunk => { response += chunk; });
      client.on("error", () => {});
      client.write(`GET /api/desktop-viewer/local/shared/websockify${query(undefined, { botId: a.id, controlLeaseId: id })} HTTP/1.1\r\n`
        + `Host: ${new URL(base).host}\r\nAuthorization: Bearer ${phoneToken}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
      await until(() => response, text => text.includes("101 Switching Protocols"));
      await sleep(GRACE_MS * 2);
      expect(await held(a.id)).toBe(true);
      const closed = once(client, "close");
      client.end();
      await closed;
      await until(() => held(a.id), value => !value, GRACE_MS * 2);
    } finally {
      client.destroy();
      websockify.closeAllConnections();
      await new Promise<void>(resolve => websockify.close(() => resolve()));
    }
  }, 30_000);

  it("a person's hold on the shared desktop keeps it from its automatic update until the hand-back", async () => {
    await control(api, witness, { action: "take" });
    vmState({ ...READY, outdated: ["shared"] });
    await ok("GET", "/api/local-computer");
    await sleep(1_500);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).actions ?? []).toEqual([]);
    await control(api, witness, { action: "release" });
    await until(() => JSON.parse(readFileSync(stateFile, "utf8")).actions ?? [], actions => actions.some((entry: { action: string }) => entry.action === "run"));
  }, 30_000);

  it("a take holds the key of the bot's settings once its body has arrived, not when its headers did", async () => {
    const a = await newBot("Ada", { computer: "vm" });
    const body = JSON.stringify({ action: "take" });
    const sending = httpRequest(`${base}/api/bots/${a.id}/computer/control${query(a.threadId)}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) } });
    const answered = new Promise<number>((resolve, reject) => {
      sending.on("response", response => { response.resume(); resolve(response.statusCode ?? 0); });
      sending.on("error", reject);
    });
    sending.write(body.slice(0, 4));
    await sleep(1_000);
    await ok("PATCH", `/api/bots/${a.id}`, { computer: "cloud" });
    sending.end(body.slice(4));
    expect(await answered).toBe(200);
    expect([await held(witness), await held(a.id)]).toEqual([false, true]);
  }, 30_000);

  it("a bot's control answers 404 for a conversation of another bot", async () => {
    const [a, b] = [await newBot("Ada"), await newBot("Bea")];
    expect((await control(api, a.id, undefined, b.threadId)).status).toBe(404);
    expect((await control(api, a.id, undefined, a.threadId)).status).toBe(200);
  });

  it("the Team map does not capture a bot's Boat while its hold sits on the shared desktop", async () => {
    const a = await newBot("Ada");
    const scope = createHash("sha256").update(readFileSync(join(home, "data", "environment-id"), "utf8").trim()).digest("hex").slice(0, 12);
    const name = `ogb-${scope}-${a.id.slice(0, 8).replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(a.id).digest("hex").slice(0, 6)}`;
    boatRow = { id: "bx_mapframe", name, state: "idle" };
    const captures = () => boatCalls.filter(entry => entry === "POST /sandboxes/bx_mapframe/commands").length;
    try {
      await control(api, a.id, { action: "take" });
      await ok("GET", "/api/computers/frames");
      await sleep(1_500);
      expect(captures()).toBe(0);
      await control(api, a.id, { action: "release" });
      await ok("GET", "/api/computers/frames");
      await until(captures, count => count > 0);
    } finally {
      await control(api, a.id, { action: "release" });
      boatRow = null;
    }
  }, 30_000);

  it("a turn's command on the shared VM is refused while a person holds it, even when the take lands as it starts", async () => {
    const worker = await newBot("Worker", { computer: "vm" });
    const { comms } = await startTurn(worker.id, worker.threadId);
    const exec = async () => (await fetch(`${base}/api/internal/vm-exec`, {
      method: "POST", headers: { authorization: `Bearer ${comms}`, "content-type": "application/json" }, body: JSON.stringify({ command: "true" }),
    })).status;
    expect(await exec()).toBe(200);
    await control(api, witness, { action: "take" });
    expect(await exec()).toBe(409);
    await control(api, witness, { action: "release" });
    expect(await exec()).toBe(200);
    rmSync(`${stateFile}.runtime`, { force: true });
    vmState({ ...READY, holdRuntime: true });
    const started = exec();
    await until(() => existsSync(`${stateFile}.runtime`), Boolean);
    await control(api, witness, { action: "take" });
    vmState();
    expect(await started).toBe(409);
    await finishTurns([worker.id, worker.threadId]);
  }, 30_000);

  it("a bot's screen on the shared VM is not captured while a person holds it", async () => {
    const frame = `${stateFile}.frame`;
    vmState({ ...READY, frames: true });
    const worker = await newBot("Worker", { computer: "vm" });
    const { computer } = await startTurn(worker.id, worker.threadId);
    expect(await gate(computer)).toEqual({ held: false, helpOpen: false });
    await until(() => existsSync(frame), Boolean, 10_000);
    await control(api, witness, { action: "take" });
    await sleep(500);
    rmSync(frame, { force: true });
    await sleep(7_000);
    expect(existsSync(frame)).toBe(false);
    await control(api, witness, { action: "release" });
    await until(() => existsSync(frame), Boolean, 10_000);
    await finishTurns([worker.id, worker.threadId]);
  }, 45_000);

  it("a bot moved to the cloud while its turn still works on the shared desktop is told about a hold taken on that conversation", async () => {
    const worker = await newBot("Worker", { computer: "vm" });
    await startTurn(worker.id, worker.threadId);
    await ok("PATCH", `/api/bots/${worker.id}`, { computer: "cloud" });
    const since = sse.frames.length;
    await control(api, worker.id, { action: "take" }, worker.threadId);
    expect(await held(witness)).toBe(true);
    expect((await ok("GET", "/api/bots?messages=0")).computerControl[worker.id]).toMatchObject({ held: true });
    await until(() => framesFor(worker.id, since).at(-1)?.held, value => value === true);
    await control(api, worker.id, { action: "release" }, worker.threadId);
    await finishTurns([worker.id, worker.threadId]);
  }, 30_000);

  // A failed VM leaves the server's own preview of the conversation on the VPS; a ready one shows it the VM.
  it.each([
    { row: "the shared VM while the server would show the VPS", target: "local/shared", vm: { ...READY, failed: true }, desk: true },
    { row: "its VPS while the server would show the shared VM", target: "vps", vm: READY, desk: false },
  ])("a panel's take on an unplaced conversation of an Auto bot with a VPS holds the desktop it names, $row, tells its panel so, and its hand-back with its lease ends it", async ({ target, vm, desk }) => {
    vmState(vm);
    const a = await newBot("Ada", { cloudBackend: "vps" });
    const unplaced = await newTask(a.id);
    const named = target === "vps" ? `vps/${a.id}` : target;
    const id = lease();
    expect((await control(api, a.id, { action: "take", controlLeaseId: id, target: named }, unplaced)).body.owned).toBe(true);
    expect([await held(witness), await held(a.id, unplaced)]).toEqual([desk, true]);
    expect((await control(api, a.id, { action: "release", controlLeaseId: id, target: named }, unplaced)).body.released).toBe(true);
    expect([await held(witness), await held(a.id)]).toEqual([false, false]);
  }, 30_000);

  it("a panel's hand-back without a lease, naming the shared VM from an unplaced conversation of a bot with a VPS, ends a phone's hold taken through another bot", async () => {
    const a = await newBot("Ada", { cloudBackend: "vps" });
    const unplaced = await newTask(a.id);
    await control(phone, witness, { action: "take" });
    expect(await held(witness)).toBe(true);
    await control(api, a.id, { action: "release", target: "local/shared" }, unplaced);
    expect(await held(witness)).toBe(false);
  }, 30_000);

  it.each([
    { row: "another bot's VPS holds only the bot's own computer", mode: "shared", target: "vps", status: 200 },
    { row: "a pool seat not its own holds only the bot's own computer", mode: "pool", target: "local/pool-1", status: 200 },
    { row: "the shared VM in per-bot mode is refused", mode: "per-bot", target: "local/shared", status: 409 },
    { row: "the shared VM from a conversation on the cloud is refused", mode: "shared", computer: "cloud", target: "local/shared", status: 409 },
    { row: "no desktop at all is refused", mode: "shared", target: "shared", status: 400 },
    { row: "a list holding the shared VM is refused", mode: "shared", target: ["local/shared"], status: 400 },
  ] as Array<{ row: string; mode: "shared" | "per-bot" | "pool"; computer?: string; target: string | string[]; status: number }>)("a take naming $row", async ({ mode, computer, target, status }) => {
    await setMode(mode);
    const [a, b] = [await newBot("Ada", { cloudBackend: "vps", ...(computer ? { computer } : {}) }), await newBot("Bea", { cloudBackend: "vps" })];
    const answer = await control(api, a.id, { action: "take", controlLeaseId: lease(), target: target === "vps" ? `vps/${b.id}` : target }, a.threadId);
    expect(answer.status, JSON.stringify(answer.body)).toBe(status);
    expect([await held(a.id), await held(b.id), await held(witness)]).toEqual([status === 200, false, false]);
  }, 30_000);

  it("a phone's take of an Auto bot with a VPS, without a conversation, holds the bot's own computer and does not lapse", async () => {
    const a = await newBot("Ada", { cloudBackend: "vps" });
    expect((await control(phone, a.id, { action: "take", controlLeaseId: lease() })).body.owned).toBe(true);
    expect([await held(witness), await held(a.id)]).toEqual([false, true]);
    await sleep(GRACE_MS + 1_000);
    expect(await held(a.id)).toBe(true);
    await control(api, a.id, { action: "release" });
  }, 30_000);

  it("after a restart, Done on a card in a cloud bot's conversation pinned to the shared desktop hands that desktop back", async () => {
    const books = await newBot("Books", { computer: "cloud" });
    const pinned = await newTask(books.id, "vm");
    const asked = await startTurn(books.id, pinned);
    const card = await askSignIn(asked.comms, "ledger.example");
    await finishTurns([books.id, pinned]);
    sse.close();
    await waitForExit(child!, { signal: "SIGTERM" });
    await startServer();
    sse = await openSse(`${base}/api/events`);
    await control(api, witness, { action: "take" });
    await ok("POST", `/api/bots/${books.id}/sign-in-cards/${card}/done`, { threadId: pinned });
    expect(await held(witness)).toBe(false);
  }, 60_000);
});
