// Taking control of a cloud computer while the panel's picture of it is still on its way. One stub plays the Admin's
// Boat relay and can hold every screen capture, so each case starts with a preview in flight.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

type Row = { id: string; name?: string; state: string };

describe("taking control never waits for the screen preview", () => {
  let home = "";
  let base = "";
  let child: ChildProcess | null = null;
  let output = "";
  let relay: Server;
  const rows: Row[] = [];
  const shots: string[] = [];
  let holdShots: Promise<void> | null = null;
  let releaseShots = () => {};

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
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const hold = () => {
    holdShots = new Promise(resolve => { releaseShots = () => { holdShots = null; resolve(); }; });
  };
  const newBot = async (name: string, patch: Record<string, unknown>) => {
    const { bot } = await apiOk("POST", "/api/bots", { name });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { browser: false, modelSelection: { instanceId: "engine", model: "claude-sonnet-5" }, ...patch });
    return bot as { id: string; name: string; threadId: string };
  };

  beforeAll(async () => {
    relay = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://relay.test");
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", async () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const path = url.pathname.replace(/^\/relay\/api\/box\/v1/, "");
        if (req.headers.authorization !== `Bearer ${INCLUDED}` || !url.pathname.startsWith("/relay/api/box/v1")) {
          return send(401, { ok: false, code: "unauthorized", message: "Unauthorized" });
        }
        const body = raw ? JSON.parse(raw) : {};
        if (path === "/boxes" && req.method === "GET") return send(200, { ok: true, boxes: rows, pageInfo: { nextCursor: null } });
        if (path === "/boxes" && req.method === "POST") {
          const row = { id: `bx_${"23456789abcdefgh"[rows.length]}3456789`, state: "ready" };
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
        if (!verb && req.method === "GET") return send(200, { ok: true, box: row });
        if (verb === "stop" && req.method === "POST") {
          row.state = "archived";
          return send(200, { ok: true, box: row });
        }
        if (verb === "desktop" && req.method === "POST") return send(200, { desktopUrl: `https://desktop.invalid/${row.id}` });
        if (verb === "commands" && req.method === "POST") {
          if (String(body.command).includes("ogb-panel.jpg")) {
            shots.push(row.id);
            await holdShots;
          }
          return send(200, { exitCode: 0, stdout: "captured", stderr: "" });
        }
        if (verb === "artifacts" && req.method === "GET") {
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(FRAME.length) });
          return res.end(FRAME);
        }
        send(404, { ok: false, code: "not_found", message: "Not found" });
      });
    });
    await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
    const relayBase = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

    home = mkdtempSync(join(tmpdir(), "omb-take-control-"));
    const data = join(home, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { engine: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE } } } }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_BOAT_API: `${relayBase}/own-key-must-not-be-used`,
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
  }, 60_000);

  afterAll(async () => {
    releaseShots();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (relay) await new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); });
    if (home) await removeTempDir(home);
  });

  it("a bot's cloud computer: take control and its desktop link go through; changing the computer still waits", async () => {
    const bot = await newBot("Pip", { computer: "cloud" });
    await apiOk("POST", `/api/bots/${bot.id}/computer/provision`, {});
    hold();
    const preview = `/api/bots/${bot.id}/computer/screenshot?threadId=${bot.threadId}`;
    const first = api("POST", preview, {});
    await until(() => shots.length, count => count === 1);
    const second = api("POST", preview, {});

    const took = await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
    expect(took.status, `take control waited on the preview: ${JSON.stringify(took.body)}`).toBe(200);
    expect(took.body.held).toBe(true);
    const joined = await api("POST", `/api/bots/${bot.id}/computer/join?threadId=${bot.threadId}`, {});
    expect(joined.status, `the desktop link waited on the preview: ${JSON.stringify(joined.body)}`).toBe(200);
    expect(joined.body.joinUrl).toBe(`https://desktop.invalid/${rows[0]!.id}`);
    const slept = await api("POST", `/api/bots/${bot.id}/computer/sleep`, {});
    expect(slept.status, "putting it to sleep must still wait for the capture").toBe(409);

    releaseShots();
    expect((await first).body.png).toBe(FRAME.toString("base64"));
    expect((await second).body.png).toBe(FRAME.toString("base64"));
    expect(shots, "two panels watching share one capture").toHaveLength(1);
    expect((await apiOk("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" })).held).toBe(false);
  }, 60_000);

  it("a team's shared computer: the same, from the bot and from the Team map", async () => {
    const requestId = randomUUID();
    await apiOk("POST", "/api/team-computers", { requestId, name: "Ops desktop", acknowledgeCost: true });
    const box = rows.at(-1)!.id;
    const ada = await newBot("Ada", { section: "Ops" });
    await apiOk("PATCH", `/api/team-computers/${requestId}`, { section: "Ops", acknowledgeSharedAccess: true });
    shots.length = 0;
    hold();
    const first = api("POST", `/api/bots/${ada.id}/computer/screenshot?threadId=${ada.threadId}`, {});
    await until(() => shots.length, count => count === 1);
    expect(shots).toEqual([box]);

    const took = await api("POST", `/api/bots/${ada.id}/computer/control`, { action: "take" });
    expect(took.status, `take control waited on the preview: ${JSON.stringify(took.body)}`).toBe(200);
    const joined = await api("POST", `/api/bots/${ada.id}/computer/join?threadId=${ada.threadId}`, {});
    expect(joined.status, `the desktop link waited on the preview: ${JSON.stringify(joined.body)}`).toBe(200);
    expect((await apiOk("POST", `/api/bots/${ada.id}/computer/control`, { action: "release" })).held).toBe(false);
    const lease = randomUUID();
    const map = await api("POST", `/api/team-computers/${requestId}/control`, { action: "take", controlLeaseId: lease });
    expect(map.status, `the Team map's take waited on the preview: ${JSON.stringify(map.body)}`).toBe(200);
    expect(map.body.owned).toBe(true);
    const mapJoined = await api("POST", `/api/team-computers/${requestId}/join`, {});
    expect(mapJoined.status, `the Team map's desktop link waited on the preview: ${JSON.stringify(mapJoined.body)}`).toBe(200);
    expect(mapJoined.body.joinUrl).toBe(`https://desktop.invalid/${box}`);
    await apiOk("POST", `/api/team-computers/${requestId}/control`, { action: "release", controlLeaseId: lease });

    releaseShots();
    expect((await first).status).toBe(200);
  }, 60_000);
});
