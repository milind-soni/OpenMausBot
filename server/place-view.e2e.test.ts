// A cloud computer that can't start, end to end: what a failed turn's row
// says and stores (shared/place-view.ts). Each refusal is the one the Admin's
// relay sends today (server/cloud-services.ts in openmaus-cloud), read into
// one plain line and one next action, with where the place came from deciding
// the way on. The words are what phones read; `place` is what the app words
// again. Real server, fake Claude CLI, and a loopback Boat whose answers each
// journey sets; a restartable home so a test can seed an automatic pin.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The Admin relay's refusal envelope (boatError in openmaus-cloud). */
const refusal = (status: number, code: string, message: string) =>
  ({ status, body: { ok: false, type: "sandbox.error", status, code, message, error: { code, message, status } } });
const HOURS = refusal(429, "limit_reached", "Your Pro plan's 50 cloud computer hours for October are used up. They reset on 1 November.");
const AT_ONCE = refusal(429, "limit_reached", "Your Personal plan includes 1 cloud computer at once. Delete one to start another.");
const DOWN = refusal(503, "service_unavailable", "Cloud computers are temporarily unavailable. Try again later.");

describe("a cloud computer that can't start, against the real server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";
  let boatServer: Server;
  let boatApi = "";
  /** What a create answers: a refusal, or a new computer. */
  let createAnswer: { status: number; body: unknown } | null = null;
  /** Start the next server with the plan's cloud computers (the Admin's relay), not an own key. */
  let included = false;
  let creates = 0;
  const boxes: Array<{ id: string; name: string; state: string }> = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: NoInfer<T>) => boolean, what = "fixture"): Promise<T> {
    const end = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`${what} wait expired: ${JSON.stringify(value)}\n${output.slice(-2_000)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const messages = async (threadId: string) => (await apiOk("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[];
  /** The failed-turn row a turn on this thread settles with. */
  const failedRow = (threadId: string, after = 0): Promise<any> => until(
    async () => (await messages(threadId)).slice(after).find((message) => String(message.tool?.name ?? "").startsWith("error:")),
    Boolean, "failed row");
  const idle = (botId: string) => until(
    async () => (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId),
    (bot: any) => bot && !bot.busy, "idle bot");
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[];
    edit(bots.find((bot: any) => bot.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));
  };
  const send = (botId: string, threadId: string, text: string) =>
    apiOk("POST", `/api/bots/${botId}/messages`, { text, threadId });

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home, OMB_TEST_SEALED_PATH: "1",
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui,
        OMB_BOX_API: boatApi, OMB_USER_DATA: join(home, "user-data"),
        ...(included ? { OMB_CLOUD_BOAT_URL: boatApi, OMB_CLOUD_BOAT_TOKEN: "relay_place_view_fixture" } : {}),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean, "boot");
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-place-view-"));
    data = join(home, "data");
    ui = join(home, "static");
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Place view</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    boatServer = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      const path = new URL(req.url ?? "/", "http://box.fixture").pathname;
      let raw = ""; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      if (path === "/boxes" && req.method === "POST") {
        creates++;
        if (createAnswer) { res.statusCode = createAnswer.status; return res.end(JSON.stringify(createAnswer.body)); }
        const row = { id: `bx_${String(23456789 + boxes.length)}`, name: String(body.name ?? ""), state: "idle" };
        boxes.push(row);
        return res.end(JSON.stringify({ box: row }));
      }
      if (path === "/boxes") return res.end(JSON.stringify({ boxes }));
      if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
      if (path.endsWith("/commands")) return res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
      const row = boxes.find(entry => path === `/boxes/${entry.id}`);
      if (row) {
        if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
        return res.end(JSON.stringify({ box: row }));
      }
      res.end("{}");
    });
    await new Promise<void>(resolve => boatServer.listen(0, "127.0.0.1", resolve));
    boatApi = `http://127.0.0.1:${(boatServer.address() as { port: number }).port}`;
    writeConfig(true);
  });
  const writeConfig = (ownKey: boolean) => writeFileSync(join(data, "config.json"), JSON.stringify({
    ...(ownKey ? { box: { token: "box_place_view_fixture" } } : {}),
    // Every turn first takes one screenshot through the cloud computer's
    // tools, as a model's first computer call does: that call, not the
    // message, starts the bot's cloud computer.
    instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
    } },
  }));
  afterAll(async () => {
    await stop();
    if (boatServer) await new Promise<void>(resolve => boatServer.close(() => resolve()));
    if (home) await removeTempDir(home);
  });
  afterEach(async () => {
    await stop();
    createAnswer = null; creates = 0; boxes.length = 0;
    if (included) { included = false; writeConfig(true); }
  });

  it("J5: no hours left says when they come back, offers the plan, and starts nothing", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Hours Bot" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    createAnswer = HOURS;
    await send(bot.id, bot.threadId, "Open the desktop.");
    const row = await failedRow(bot.threadId);
    expect(row.tool.name).toBe("error: This month's 50 cloud computer hours are used up. They come back on 1 November. See your plan on the Plan page.");
    expect(row.tool.place).toEqual({ state: "cc-no-hours", params: { bot: "Hours Bot", plan: "Pro", hours: 50, month: "November" }, source: "works-on" });
    await idle(bot.id);
    // The one refused create, and nothing started after it.
    expect(creates).toBe(1);
    expect(boxes).toEqual([]);
  }, 90_000);

  it("J6: at once names the bot that holds the plan's cloud computer", async () => {
    await start();
    const { bot: holder } = await apiOk("POST", "/api/bots", { name: "Ada" });
    await apiOk("PATCH", `/api/bots/${holder.id}`, { computer: "cloud" });
    await send(holder.id, holder.threadId, "Use your desktop.");
    await until(() => boxes.length, count => count === 1, "Ada's computer");
    await idle(holder.id);
    expect((await messages(holder.threadId)).some(message => String(message.tool?.name ?? "").startsWith("error:"))).toBe(false);

    const { bot } = await apiOk("POST", "/api/bots", { name: "Bo" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    createAnswer = AT_ONCE;
    await send(bot.id, bot.threadId, "Use your desktop too.");
    const row = await failedRow(bot.threadId);
    expect(row.tool.name).toBe("error: Your Personal plan includes 1 cloud computer, and Ada has it. Manage your cloud computers in Settings → Local VM.");
    expect(row.tool.place).toEqual({ state: "cc-at-once", params: { bot: "Bo", plan: "Personal", max: 1, holders: ["Ada"] }, source: "works-on" });
  }, 90_000);

  it("J7: a relay that can't start one says so plainly, with Try again and no Boat words", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Down Bot" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    createAnswer = DOWN;
    await send(bot.id, bot.threadId, "Open the desktop.");
    const row = await failedRow(bot.threadId);
    expect(row.tool.name).toBe("error: Cloud computers can't start right now. It isn't anything you did. Try again.");
    expect(row.tool.name).not.toMatch(/boat|box|Works on to Auto/i);
    expect(row.tool.place).toEqual({ state: "cc-unavailable", params: { bot: "Down Bot" }, source: "works-on" });
  }, 90_000);

  it("the Admin's subscription_inactive reads as Plan ended, by its code, with See your plan", async () => {
    included = true;
    writeConfig(false);
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Ended Bot" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    createAnswer = refusal(402, "subscription_inactive", "Cloud computers are included with an active Cloud subscription.");
    await send(bot.id, bot.threadId, "Open the desktop.");
    const row = await failedRow(bot.threadId);
    expect(row.tool.name).toBe("error: Your MausBot Cloud plan has ended, so cloud computers are off. See your plan on the Plan page.");
    expect(row.tool.place).toEqual({ state: "cc-ended", params: { bot: "Ended Bot" }, source: "works-on" });
  }, 90_000);

  it("an automatic pin that fails is cleared, and the row says the conversation is back on Auto", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Pinned Bot" });
    await stop();
    // Where an earlier Auto turn landed (select_computer, or a claimed
    // computer): the machine's memory, not a person's choice.
    editSavedBot(bot.id, saved => {
      Object.assign(saved.tasks.find((task: any) => task.threadId === bot.threadId), { surface: "cloud", surfaceSource: "auto" });
    });
    await start();
    createAnswer = DOWN;
    await send(bot.id, bot.threadId, "Carry on on the desktop.");
    const row = await failedRow(bot.threadId);
    expect(row.tool.name).toBe("error: Cloud computers can't start right now. It isn't anything you did. This conversation is back on Auto. Send your message again.");
    expect(row.tool.place).toEqual({ state: "cc-unavailable", params: { bot: "Pinned Bot" }, source: "auto-pin" });
    await idle(bot.id);
    expect(savedTask(bot.id, bot.threadId)?.surface).toBeUndefined();
    // And so it is: the next message runs on Auto, which never asks Boat.
    const createsBefore = creates;
    const after = (await messages(bot.threadId)).length;
    await send(bot.id, bot.threadId, "What is 2+2?");
    await until(async () => (await messages(bot.threadId)).slice(after).some(message => message.role === "bot" && message.kind === "text"), Boolean, "Auto reply");
    expect(creates).toBe(createsBefore);
  }, 90_000);

  it("a cloud routine that can't start its computer points at where the routine runs", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Routine Bot" });
    createAnswer = DOWN;
    const { routine } = await apiOk("POST", "/api/routines", { name: "Desktop check", botId: bot.id,
      prompt: "Check the cloud desktop.", runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const { run } = await apiOk("POST", `/api/routines/${routine.id}/run`, {});
    const threadId: string = await until(async (): Promise<string> =>
      (await apiOk("GET", "/api/routines")).runs.find((entry: any) => entry.id === run.id)?.threadId ?? "", Boolean, "routine thread");
    const row = await failedRow(threadId);
    expect(row.tool.name).toBe("error: Cloud computers can't start right now. It isn't anything you did. Change where this routine runs.");
    expect(row.tool.place).toEqual({ state: "cc-unavailable", params: { bot: "Routine Bot" }, source: "routine" });
    expect(row.tool.name).not.toMatch(/Works on/);
  }, 90_000);
});
