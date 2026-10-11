// A bot set to work on its cloud computer starts that computer only when it
// actually uses it. The real server, the fake Claude CLI and one stub that
// plays the Admin's Boat relay (the included cloud computers of an
// OpenMausBot Cloud plan). Every relay request is recorded, so each journey
// can say exactly which calls a person's action cost: a chat that never
// touches the screen costs none, and the first computer call creates the
// computer once. Disposable home; no network.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");
const INCLUDED = `box_omb_${randomUUID()}`;
// A one-pixel JPEG: what the relay hands back as a screen frame.
const FRAME = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

type Row = { id: string; name?: string; state: string };
type Request = { method: string; path: string };

describe("a cloud computer starts only when the bot uses it", () => {
  let home = "";
  let data = "";
  let dumpFile = "";
  let finishFile = "";
  let base = "";
  let child: ChildProcess | null = null;
  let output = "";
  let relay: Server;
  let events: SseRecorder;
  const rows: Row[] = [];
  /** Looks a waking computer still answers "resuming" to. */
  const wakeLooks = { left: 0 };
  /** The relay refuses every create the way the Admin does once a plan's
   * hours are used up. */
  const refuse = { creates: false };
  const requests: Request[] = [];
  /** Boat ids in Boat's own alphabet, one per computer created. */
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
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  /** The `computer` frames the chat's progress line is drawn from. */
  const starts = (botId: string) => events.frames
    .filter(frame => frame.kind === "computer" && frame.botId === botId)
    .map(({ state, place }) => ({ state, place }));
  const creates = () => requests.filter(request => request.method === "POST" && request.path === "/boxes").length;
  const resumes = () => requests.filter(request => request.method === "POST" && request.path.endsWith("/resume")).length;
  const task = async (botId: string) =>
    (await apiOk("GET", "/api/bots?messages=40")).bots.find((bot: any) => bot.id === botId);
  const idle = (botId: string) => until(() => task(botId), bot => bot?.busy === false);
  const lastReply = async (botId: string) => (await task(botId))?.messages.findLast((message: any) => message.kind === "text" && message.role === "bot");
  /** The failed-turn row (shared/failed-turn.ts), once it is written. */
  const failedRow = (botId: string) => until<any>(
    async () => (await task(botId))?.messages.findLast((message: any) => message.tool?.name?.startsWith("error:")),
    Boolean,
  );
  /** A conversation's failed-turn rows (a room's or a routine's thread). */
  const errorRows = async (threadId: string) =>
    (await apiOk("GET", `/api/threads/${threadId}/messages?limit=60`)).messages
      .filter((message: any) => message.tool?.name?.startsWith("error:"));
  /** select_computer, as the agents tools call it for this turn. */
  const selectComputer = (sent: any, surface?: string) => {
    const agents = sent.mcpConfig.mcpServers.agents;
    const upstream = agents.env.OMB_GATE_UPSTREAM ? JSON.parse(agents.env.OMB_GATE_UPSTREAM).env : agents.env;
    return fetch(`${base}/api/internal/computer/select`, {
      method: surface ? "POST" : "GET",
      headers: { authorization: `Bearer ${upstream.OMB_COMMS_TOKEN}`, "content-type": "application/json" },
      ...(surface ? { body: JSON.stringify({ surface }) } : {}),
    }).then(response => response.json() as Promise<any>);
  };
  /** The turn's launch files, once the fake CLI has read them. */
  const dump = (): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
  }, Boolean);
  /** One JSON-RPC request on the mounted cloud computer, exactly as
   * harness-mcp-proxy sends it for the engine. */
  const computerCall = async (sent: any, method: string, params: unknown = {}) => {
    const env = sent.mcpConfig.mcpServers.computer.env;
    const response = await fetch(new URL("/api/internal/computer/mcp", env.OMB_HARNESS_URL), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OMB_MCP_TOKEN_COMPUTER}` },
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  /** Start a turn the fake CLI holds open until `finish()`. */
  const startTurn = async (botId: string, text: string) => {
    rmSync(dumpFile, { force: true });
    rmSync(finishFile, { force: true });
    await apiOk("POST", `/api/bots/${botId}/messages`, { text });
    return dump();
  };
  const finish = async (botId: string) => {
    writeFileSync(finishFile, "finish");
    await idle(botId);
  };
  const cloudBot = async (name: string, patch: Record<string, unknown> = {}) => {
    const { bot } = await apiOk("POST", "/api/bots", { name });
    await apiOk("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, browser: false, computer: "cloud", ...patch,
    });
    return bot as { id: string; name: string; threadId: string };
  };

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
        // Every request is counted, a stray own-key one included.
        const path = url.pathname.replace(/^\/relay\/api\/box\/v1/, "");
        requests.push({ method: req.method ?? "GET", path });
        if (req.headers.authorization !== `Bearer ${INCLUDED}` || !url.pathname.startsWith("/relay/api/box/v1")) {
          return send(401, { ok: false, code: "unauthorized", message: "Unauthorized" });
        }
        const body = raw ? JSON.parse(raw) : {};
        if (path === "/boxes" && req.method === "GET") return send(200, { ok: true, boxes: rows, pageInfo: { nextCursor: null } });
        if (path === "/boxes" && req.method === "POST") {
          if (refuse.creates) return send(402, { ok: false, code: "hours_used", message: "This month's 50 cloud computer hours are used up." });
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
          // A new computer is ready by the next look. A waking one takes
          // longer than the gate's short wait for a desktop that claims at
          // once, as a real wake can.
          const seen = { ...row };
          if (row.state === "provisioning") row.state = "ready";
          if (row.state === "resuming" && --wakeLooks.left <= 0) row.state = "ready";
          return send(200, { ok: true, box: seen });
        }
        if (verb === "resume" && req.method === "POST") {
          row.state = "resuming";
          wakeLooks.left = 3;
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
    const relayBase = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    home = mkdtempSync(join(tmpdir(), "omb-cloud-lazy-"));
    data = join(home, "data");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
      claude: {
        driver: "claudeAgent", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
      },
      // The same CLI, whose every turn first takes one screenshot through
      // the cloud computer's tools, as a model's first computer call does.
      uses: {
        driver: "claudeAgent", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
      },
      // The same CLI, signed out: what a Cloud with no AI sign-in yet runs.
      "claude-out": {
        driver: "claudeAgent", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "not-logged-in", FAKE_CLAUDE_AUTH: "out" },
      },
    } }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        // An own key would go here; nothing may use it.
        OMB_BOX_API: `${relayBase}/own-key-must-not-be-used`,
        OMB_CLOUD_BOAT_URL: `${relayBase}/relay/api/box/v1`,
        OMB_CLOUD_BOAT_TOKEN: INCLUDED,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (child!.exitCode !== null) throw new Error(`the server exited:\n${output}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, Boolean, 30_000);
    events = await openSse(`${base}/api/events`);
    await events.until(frame => frame.kind === "hello");
  }, 60_000);

  afterAll(async () => {
    events?.close();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (relay) await new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); });
    if (home) await removeTempDir(home);
  });

  it("choosing Cloud computer and opening the Computer panel create and wake nothing", async () => {
    const before = requests.length;
    const bot = await cloudBot("Chooser");
    // What the Computer panel reads when it opens on this conversation.
    const status = await apiOk("GET", `/api/bots/${bot.id}/computer?threadId=${bot.threadId}`);
    expect(status).toMatchObject({ surface: "cloud", backend: "box", configured: true, box: null });
    expect(creates()).toBe(0);
    expect(resumes()).toBe(0);
    expect(requests.slice(before).every(request => request.method === "GET")).toBe(true);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  });

  it("a plain chat on Cloud computer makes no relay call at all", async () => {
    const bot = await cloudBot("Chatter");
    const before = requests.length;
    const sent = await startTurn(bot.id, "hi");
    // The tools are there for the bot to use…
    expect(sent.mcpConfig.mcpServers.computer?.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(sent.systemPrompt).toContain("assigned cloud computer");
    // …and listing them costs nothing either.
    const listed = await computerCall(sent, "tools/list");
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toContain("screenshot");
    await finish(bot.id);
    expect(withoutTurnClock((await lastReply(bot.id))?.text ?? "")).toContain("reply to: hi");
    expect(requests.slice(before)).toEqual([]);
    expect(starts(bot.id)).toEqual([]);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  }, 30_000);

  it("a room message to a member on Cloud computer makes no relay call either", async () => {
    const bot = await cloudBot("Room member");
    const { group } = await apiOk("POST", "/api/groups", { name: "Lazy room", memberIds: [bot.id] });
    await apiOk("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
    const before = requests.length;
    rmSync(dumpFile, { force: true });
    rmSync(finishFile, { force: true });
    await apiOk("POST", `/api/groups/${group.id}/messages`, { text: "hi" });
    const sent = await dump();
    expect(sent.mcpConfig.mcpServers.computer?.args?.at(-1)).toBe("computer");
    await finish(bot.id);
    expect(requests.slice(before)).toEqual([]);
    await apiOk("DELETE", `/api/groups/${group.id}`);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  }, 30_000);

  it("the first computer call creates the cloud computer exactly once and says so in the chat", async () => {
    const bot = await cloudBot("Worker");
    const sent = await startTurn(bot.id, "Open the cloud desktop");
    expect(creates()).toBe(0);
    const first = await computerCall(sent, "tools/call", { name: "screenshot", arguments: {} });
    expect(first.status).toBe(200);
    expect(first.body.result.isError, JSON.stringify(first.body)).toBeFalsy();
    expect(first.body.result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(creates()).toBe(1);
    const second = await computerCall(sent, "tools/call", { name: "screenshot", arguments: {} });
    expect(second.body.result.isError).toBeFalsy();
    expect(creates()).toBe(1);
    expect(resumes()).toBe(0);
    // One progress line in the chat while it starts.
    expect(starts(bot.id)).toEqual([{ state: "provisioning", place: "cloud" }]);
    await finish(bot.id);

    // Asleep since: the next turn's first call wakes it, once, without a
    // create, and waits for the wake rather than reading it as contention.
    rows.find(row => row.name && row.state === "ready")!.state = "archived";
    const next = await startTurn(bot.id, "Look again");
    expect(resumes()).toBe(0);
    const woken = await computerCall(next, "tools/call", { name: "screenshot", arguments: {} });
    expect(woken.body.result.isError, JSON.stringify(woken.body)).toBeFalsy();
    expect(resumes()).toBe(1);
    expect(creates()).toBe(1);
    expect(starts(bot.id)).toEqual([{ state: "provisioning", place: "cloud" }, { state: "waking", place: "cloud" }]);
    await finish(bot.id);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  }, 60_000);

  it("a signed-out engine fails with the existing sign-in row and no relay call", async () => {
    const bot = await cloudBot("Signed out", { modelSelection: { instanceId: "claude-out", model: "claude-sonnet-5" } });
    const before = requests.length;
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "hi" });
    const row = await failedRow(bot.id);
    await idle(bot.id);
    // The row the app turns into "Sign in to Claude" (signedOutEngine).
    expect(row.tool).toMatchObject({ ok: false, setup: true });
    expect(row.tool.name).toMatch(/Not logged in/);
    expect(requests.slice(before)).toEqual([]);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  }, 30_000);

  it("a tool selection without the computer is refused before any relay call, and select_computer does not offer it", async () => {
    const bot = await cloudBot("Scribe", { toolScope: { deny: ["mcp:computer:*"] } });
    const before = requests.length;
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "hi" });
    const row = await failedRow(bot.id);
    expect(row.tool.name).toBe("error: What Scribe can use doesn't include a computer. Change what Scribe can use in its settings.");
    expect(row.tool.place).toEqual({ state: "cc-tools-off", params: { bot: "Scribe" }, source: "works-on" });
    await idle(bot.id);
    expect(requests.slice(before)).toEqual([]);

    // On Auto the turn runs, and the computer it cannot use is not offered.
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: null });
    const sent = await startTurn(bot.id, "Which computers can you use?");
    const agents = sent.mcpConfig.mcpServers.agents;
    const upstream = agents.env.OMB_GATE_UPSTREAM ? JSON.parse(agents.env.OMB_GATE_UPSTREAM).env : agents.env;
    const selection = await fetch(`${base}/api/internal/computer/select`, {
      headers: { authorization: `Bearer ${upstream.OMB_COMMS_TOKEN}` },
    }).then(response => response.json() as Promise<any>);
    expect(selection.options.find((option: { surface: string }) => option.surface === "cloud")).toMatchObject({
      available: false, reason: "What Scribe can use doesn't include a computer. Change what Scribe can use in its settings.",
    });
    await finish(bot.id);
    expect(requests.slice(before)).toEqual([]);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  }, 30_000);

  it("select_computer counts the cloud computer this turn mounted as chosen before it starts: no restart, no pin", async () => {
    const bot = await cloudBot("Selector");
    const before = creates();
    const sent = await startTurn(bot.id, "Check the weather site on your desktop");
    expect((await selectComputer(sent)).current).toBe("cloud");
    // Already this turn's computer: it starts on its first call, so there is
    // nothing to switch to and no turn to end.
    expect(await selectComputer(sent, "cloud")).toMatchObject({ status: "ready", surface: "cloud" });
    expect(await selectComputer(sent, "auto")).toMatchObject({ status: "ready", surface: "cloud" });
    rmSync(dumpFile, { force: true });
    await finish(bot.id);
    await new Promise(resolve => setTimeout(resolve, 750));
    // No continuation turn launched, and the conversation was not pinned.
    expect(existsSync(dumpFile)).toBe(false);
    expect((await task(bot.id))?.busy).toBe(false);
    const thread = (await task(bot.id))?.tasks.find((candidate: any) => candidate.threadId === bot.threadId);
    expect(thread?.surface).toBeUndefined();
    expect(creates()).toBe(before);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
  }, 30_000);

  it("a room member whose cloud computer can't start says why in the room, once, under its own name", async () => {
    refuse.creates = true;
    try {
      const bot = await cloudBot("Roomie", { modelSelection: { instanceId: "uses", model: "claude-sonnet-5" } });
      const { group } = await apiOk("POST", "/api/groups", { name: "Refused room", memberIds: [bot.id] });
      await apiOk("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
      await apiOk("POST", `/api/groups/${group.id}/messages`, { text: "take a screenshot of your desktop" });
      await until(() => errorRows(group.threadId), rows => rows.length > 0, 30_000);
      await idle(bot.id);
      await new Promise(resolve => setTimeout(resolve, 500));
      const rows = await errorRows(group.threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0].from).toMatchObject({ botId: bot.id, name: "Roomie" });
      // Read as a room member's place (shared/place-view.ts): the Admin's
      // code, with no retry of its own.
      expect(rows[0].tool.name).toBe("error: This month's cloud computer hours are used up. See your plan on the Plan page.");
      expect(rows[0].tool.place).toEqual({ state: "cc-no-hours", params: { bot: "Roomie" }, source: "room" });
      await apiOk("DELETE", `/api/groups/${group.id}`);
      await apiOk("DELETE", `/api/bots/${bot.id}`);
    } finally {
      refuse.creates = false;
    }
  }, 45_000);

  it("a cloud routine whose computer can't start records that cause on its run", async () => {
    refuse.creates = true;
    try {
      const { bot } = await apiOk("POST", "/api/bots", { name: "Runner" });
      await apiOk("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "uses", model: "claude-sonnet-5" }, browser: false });
      const { routine } = await apiOk("POST", "/api/routines", {
        name: "Cloud check", botId: bot.id, prompt: "Screenshot the desktop.", runOn: "cloud", enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      });
      const { run } = await apiOk("POST", `/api/routines/${routine.id}/run`, {});
      const finished = await until(
        async () => (await apiOk("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id),
        (candidate: any) => Boolean(candidate) && !["queued", "running", "waiting"].includes(candidate.status),
        45_000,
      );
      const rows = await errorRows(finished.threadId);
      expect(rows).toHaveLength(1);
      // The receipt, the routine card and the notification read the run's
      // error: the same words as the row, never "interrupted".
      expect(finished.status).toBe("failed");
      expect(`error: ${finished.error}`).toBe(rows[0].tool.name);
      expect(finished.error).toBe("This month's cloud computer hours are used up. See your plan on the Plan page.");
      expect(rows[0].tool.place).toEqual({ state: "cc-no-hours", params: { bot: "Runner" }, source: "routine" });
      // The run's thread settles once the interrupt that ended it lands.
      await until(() => task(bot.id), current => current?.busy === false && current.tasks.every((entry: any) => !entry.busy));
      await apiOk("DELETE", `/api/routines/${routine.id}`);
      await apiOk("DELETE", `/api/bots/${bot.id}`);
    } finally {
      refuse.creates = false;
    }
  }, 60_000);
});
