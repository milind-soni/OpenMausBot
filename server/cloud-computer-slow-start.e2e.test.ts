// A cloud computer's first start takes about a minute, longer than one
// computer call may wait. The call that runs out is told the computer is
// still starting (not that someone else has it), a later call works, and the
// computer is created once. A start that stalls ends at the start budget with
// one "didn't start" row instead of "still starting" until the watchdog.
// The real server, the fake Claude CLI and a stub of the Admin's Boat relay,
// with the call wait and the start budget shortened; disposable home, no
// network.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");
const INCLUDED = `box_omb_${randomUUID()}`;
const FRAME = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
/** One computer call waits this long on a start; the whole start, this long. */
const CALL_WAIT_MS = 1_500;
const START_BUDGET_MS = 20_000;
const STILL_STARTING = "The cloud computer is still starting. This call was not performed. Take a fresh screenshot in a moment.";

describe("a slow cloud computer start", () => {
  let home = "";
  let dumpFile = "";
  let finishFile = "";
  let base = "";
  let child: ChildProcess | null = null;
  let output = "";
  let relay: Server;
  const rows: Array<{ id: string; name?: string; state: string }> = [];
  const requests: string[] = [];
  /** The relay keeps a new computer "provisioning" while this is set, and
   * never answers a desktop link request while `desktop` is set. */
  const hold = { provisioning: false, desktop: false };
  const held: ServerResponse[] = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json().catch(() => null) as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBeLessThan(400);
    return parsed;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const creates = () => requests.filter(request => request === "POST /boxes").length;
  const task = async (botId: string) => (await api("GET", "/api/bots?messages=40")).bots.find((bot: any) => bot.id === botId);
  const failedRows = async (botId: string) => (await task(botId))?.messages.filter((message: any) => message.tool?.name?.startsWith("error:")) ?? [];
  const startTurn = async (botId: string, text: string, threadId?: string) => {
    rmSync(dumpFile, { force: true });
    if (!threadId) rmSync(finishFile, { force: true });
    await api("POST", `/api/bots/${botId}/messages`, { text, ...(threadId ? { threadId } : {}) });
    return until((): any => {
      if (!existsSync(dumpFile)) return null;
      try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
    }, Boolean);
  };
  const screenshot = async (sent: any) => {
    const env = sent.mcpConfig.mcpServers.computer.env;
    const response = await fetch(new URL("/api/internal/computer/mcp", env.OMB_HARNESS_URL), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OMB_MCP_TOKEN_COMPUTER}` },
      body: JSON.stringify({ method: "tools/call", params: { name: "screenshot", arguments: {} } }),
    });
    const body = await response.json() as any;
    expect(body.result, `${response.status} ${JSON.stringify(body)}\n${output.slice(-3000)}`).toBeDefined();
    return body.result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  };
  const cloudBot = async (name: string) => {
    const { bot } = await api("POST", "/api/bots", { name });
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, browser: false, computer: "cloud" });
    return bot as { id: string; threadId: string };
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
        const path = url.pathname.replace(/^\/relay\/api\/box\/v1/, "");
        requests.push(`${req.method} ${path}`);
        if (req.headers.authorization !== `Bearer ${INCLUDED}`) return send(401, { ok: false, code: "unauthorized" });
        if (path === "/boxes" && req.method === "GET") return send(200, { ok: true, boxes: rows, pageInfo: { nextCursor: null } });
        if (path === "/boxes" && req.method === "POST") {
          const row = { id: `bx_${"23456789abcdefgh"[rows.length]}3456789`, state: "provisioning" };
          rows.push(row);
          return send(201, { ok: true, box: row });
        }
        const [, id = "", verb = ""] = /^\/boxes\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
        const row = rows.find(candidate => candidate.id === id);
        if (!row) return send(404, { ok: false, code: "not_found" });
        if (!verb && req.method === "PATCH") {
          row.name = (raw ? JSON.parse(raw) : {}).name;
          return send(200, { ok: true, box: row });
        }
        if (!verb && req.method === "GET") {
          const seen = { ...row };
          if (row.state === "provisioning" && !hold.provisioning) row.state = "ready";
          return send(200, { ok: true, box: seen });
        }
        if (verb === "desktop" && req.method === "POST") {
          // Accepted, never answered: a relay that stalls.
          if (hold.desktop) return void held.push(res);
          return send(200, { desktopUrl: `https://desktop.invalid/${row.id}` });
        }
        if (verb === "commands" && req.method === "POST") return send(200, { exitCode: 0, stdout: "captured", stderr: "" });
        if (verb === "artifacts" && req.method === "GET") {
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(FRAME.length) });
          return res.end(FRAME);
        }
        send(404, { ok: false, code: "not_found" });
      });
    });
    await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
    const relayBase = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    home = mkdtempSync(join(tmpdir(), "omb-cloud-slow-"));
    const data = join(home, "data");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
      claude: {
        driver: "claudeAgent", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
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
        OMB_BOX_API: `${relayBase}/own-key-must-not-be-used`,
        OMB_CLOUD_BOAT_URL: `${relayBase}/relay/api/box/v1`,
        OMB_CLOUD_BOAT_TOKEN: INCLUDED,
        OMB_CLOUD_COMPUTER_START_WAIT_MS: String(CALL_WAIT_MS),
        OMB_CLOUD_COMPUTER_START_BUDGET_MS: String(START_BUDGET_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (child!.exitCode !== null) throw new Error(`the server exited:\n${output}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, Boolean, 30_000);
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    for (const res of held) res.destroy();
    if (relay) await new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); });
    if (home) await removeTempDir(home);
  });

  it("a call that outwaits its share is told the computer is still starting; a later call works, one create", async () => {
    hold.provisioning = true;
    const bot = await cloudBot("Slow starter");
    const sent = await startTurn(bot.id, "Open the cloud desktop");
    // Still starting is what it is doing, and nobody else has it.
    expect(await screenshot(sent)).toEqual({ isError: true, content: [{ type: "text", text: STILL_STARTING }] });
    expect(creates()).toBe(1);

    hold.provisioning = false;
    const later = await until(() => screenshot(sent), result => !result.isError, 20_000);
    expect(later.content[0]).toMatchObject({ type: "image" });
    expect(creates()).toBe(1);
    writeFileSync(finishFile, "finish");
    await until(() => task(bot.id), current => current?.busy === false);
    expect(await failedRows(bot.id)).toEqual([]);
    await api("DELETE", `/api/bots/${bot.id}`);
  }, 45_000);

  it("while another conversation has the computer, a call says so, not that it is starting", async () => {
    const bot = await cloudBot("Shared starter");
    const first = await startTurn(bot.id, "Open the cloud desktop");
    await until(() => screenshot(first), result => !result.isError, 20_000);
    // A second conversation of the same bot, while the first holds the computer.
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second look" });
    const second = await startTurn(bot.id, "Look at the cloud desktop too", sibling.threadId);
    const answer = await screenshot(second);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toMatch(/^Another thread is using this computer\. This call was not performed\./);
    writeFileSync(finishFile, "finish");
    await until(() => task(bot.id), current => current?.busy === false && current.tasks.every((entry: any) => !entry.busy), 30_000);
    await api("DELETE", `/api/bots/${bot.id}`);
  }, 60_000);

  it("a start that stalls ends at the start budget with one row that says it didn't start, and the turn ends", async () => {
    hold.desktop = true;
    try {
      const bot = await cloudBot("Stuck starter");
      const sent = await startTurn(bot.id, "Open the cloud desktop");
      const started = Date.now();
      expect(await screenshot(sent)).toEqual({ isError: true, content: [{ type: "text", text: STILL_STARTING }] });
      const [row] = await until(() => failedRows(bot.id), found => found.length > 0, START_BUDGET_MS + 15_000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(START_BUDGET_MS - CALL_WAIT_MS - 1_000);
      expect(row.tool.name).toBe("error: Stuck starter's cloud computer didn't start. Try again.");
      expect(row.tool.place).toEqual({ state: "cc-no-start", params: { bot: "Stuck starter" }, source: "works-on" });
      // The failure ended the turn, with that one row.
      await until(() => task(bot.id), current => current?.busy === false, 20_000);
      expect(await failedRows(bot.id)).toHaveLength(1);
      await api("DELETE", `/api/bots/${bot.id}`);
    } finally {
      hold.desktop = false;
    }
  }, 60_000);
});
