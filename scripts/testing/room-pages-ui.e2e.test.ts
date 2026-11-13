// A page and an MCP app shown in a room: two members' real room turns put them there through the internal card route
// and the MCP gate, and the real renderer shows both to the room, view-only. A real mouse click on the page's send
// button and on the app's server button posts nothing. Needs the pinned agent-browser binary: runs when one resolves
// (tools directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the verified download; otherwise skipped.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { ROOM_VIEW_ONLY } from "../../shared/app.ts";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_APP = join(ROOT, "server", "testing", "fake-stdio-app-server.ts");
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping room pages ui e2e: no agent-browser binary resolves; set OMB_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "omb-ui-evidence-"));
afterAll(async () => { if (!process.env.OMB_UI_EVIDENCE_DIR) await removeTempDir(evidenceDir); });

/** The send button sits at a fixed place in the page, so a real mouse can find it inside the frame. What send() did
 * shows in the page and in its height, which the host's frame follows: 300px when it resolved, 240px when refused. */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;font:15px/1.4 var(--font-sans);color:var(--color-text-primary)}
#mode{position:absolute;left:16px;top:12px;margin:0}
#send{position:absolute;left:16px;top:48px;width:260px;height:44px;font:inherit;cursor:pointer}
#out{position:absolute;left:16px;top:104px;margin:0;font-weight:600}
</style></head><body><p id="mode"></p><button id="send">Send "3 cups" to the bot</button><p id="out">Not clicked yet</p>
<div id="room" style="height:160px"></div><script>
document.getElementById("mode").textContent = "mausbot.room is " + window.mausbot.room + ": this page is view-only here";
document.getElementById("send").onclick = function () {
  window.mausbot.setContext("3 cups on screen");
  window.mausbot.send("I have had 3 cups").then(function () {
    document.getElementById("out").textContent = "Clicked: send() resolved and posted nothing";
    document.getElementById("room").style.height = "300px";
  }, function (error) {
    document.getElementById("out").textContent = "Clicked: send() refused: " + error.message;
    document.getElementById("room").style.height = "240px";
  });
};
</script></body></html>`;

async function launch(env: NodeJS.ProcessEnv): Promise<{ child: ReturnType<typeof spawn>; info: { ui: string; url: string; botId: string; dataDir: string; logPath: string } }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "control-omb.ts"), "ui", "launch", "--mode", "slow"], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`ui launch exited ${child.exitCode}: ${stderr}`);
    const start = stdout.indexOf("{");
    if (start !== -1) {
      try { return { child, info: JSON.parse(stdout.slice(start)) }; } catch { /* not all of it yet */ }
    }
    if (Date.now() > deadline) throw new Error(`ui launch printed no handle: ${stderr}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function until<T>(probe: () => Promise<T> | T, what: string, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

(enabled ? it : it.skip)("shows a member's page and another member's MCP app to the room, and a click in either posts nothing", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-pages-"));
  const gate = join(scratch, "finish");
  const { child, info } = await launch({ ...process.env, FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_VERSION: "2.1.270" });
  let engineSide: ChildProcessWithoutNullStreams | undefined;
  try {
    const api = fixtureApi(info.url, { headers: { origin: info.url } });
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
    const mouse = (...args: string[]) => agentBrowser(browser.binary, sessionEnv(browser), ["mouse", ...args]);
    /** The accessibility tree reaches into the frames: what a page or an app shows is readable here. */
    const shows = async (text: string) => JSON.stringify(await ui("snapshot")).includes(JSON.stringify(text).slice(1, -1));
    await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", "1280", "1000"]);
    const dump = () => { try { return JSON.parse(readFileSync(join(info.dataDir, "fake-claude-dump.json"), "utf8")); } catch { return null; } };
    const card = async (token: string, body: unknown) => {
      const response = await fetch(`${info.url}/api/internal/options-card`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    await api("POST", "/api/mcp/servers", { name: "board", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_APP] });
    await api("PATCH", "/api/mcp/servers/board", { enabled: true });
    expect(await api("POST", "/api/mcp/servers/board/test")).toMatchObject({ ok: true });
    const basil = (await api("POST", "/api/bots", { name: "Basil" })).bot;
    const room = (await api("POST", "/api/groups", {
      memberIds: [info.botId, basil.id], name: "Launch room", setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${room.threadId}/messages`)).messages;
    const roomTurn = (botId: string) => until(() => {
      const env = dump()?.mcpConfig?.mcpServers?.agents?.env;
      return env?.OMB_BOT_ID === botId && env?.OMB_THREAD_ID === room.threadId ? { token: env.OMB_COMMS_TOKEN as string, mounts: dump().mcpConfig.mcpServers } : null;
    }, `${botId}'s room turn`, 60_000);
    const settled = async () => {
      writeFileSync(gate, "finish");
      await until(async () => !(await api("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.busy), "the room's turns to end", 60_000);
      rmSync(gate, { force: true });
    };

    const row = `[data-sidebar-group-row="${room.id}"]`;
    await until(() => evaluate(`Boolean(document.querySelector('${row}'))`), "the room's sidebar row");
    await evaluate(`document.querySelector('${row}').click(); true`);
    await until(() => evaluate(`Boolean(document.querySelector('${row}[aria-current="page"]'))`), "the room to open");

    // Pepper answers the room and shows a page there through the same internal route show_html uses.
    await ui("type", "--name", "Message Launch room", "--text", "Pepper, show us the coffee counter");
    await ui("press", "--keys", "Enter");
    const pepper = await roomTurn(info.botId);
    const shown = await card(pepper.token, { tool: "show_html", html: PAGE, title: "Coffee counter", height: 180 });
    expect(shown, JSON.stringify(shown.body)).toMatchObject({ status: 201, body: { messageId: expect.any(String) } });
    const pageId = shown.body.messageId as string;
    await settled();

    // Basil's room turn calls an MCP tool with a UI; the gate the engine runs it through reports it to the room.
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@Basil show the board", mentions: [basil.id], sendId: "room-pages-ui-send-0001" });
    const basilTurn = await roomTurn(basil.id);
    expect(basilTurn.mounts.board).toBeTruthy();
    engineSide = spawn(basilTurn.mounts.board.command, ["--experimental-strip-types", "--no-warnings", ...basilTurn.mounts.board.args],
      { stdio: "pipe", env: { ...process.env, ...basilTurn.mounts.board.env } });
    const lines = createInterface({ input: engineSide.stdout })[Symbol.asyncIterator]();
    const ask = async (id: number, method: string, params?: unknown) => {
      engineSide!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return JSON.parse((await lines.next()).value as string);
    };
    await ask(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.270" } });
    await ask(2, "tools/list");
    expect((await ask(3, "tools/call", { name: "show_board", arguments: { cards: 4 } })).result.content[0].text).toBe("Board with 4 cards");
    const boardRow = await until(async () => (await transcript()).find((message) => message.kind === "app" && message.app?.source === "mcp"), "the board's row");
    await settled();

    const rows = (await transcript()).filter((message) => message.kind === "app");
    expect(rows.map((message) => [message.id, message.from?.botId])).toEqual([[pageId, info.botId], [boardRow.id, basil.id]]);
    const pageDoc = await api("GET", `/api/threads/${room.threadId}/messages/${pageId}/app`);
    expect(pageDoc).toMatchObject({ room: true, can: { message: false, modelContext: false, serverTools: false, openLinks: true } });
    expect(await api("GET", `/api/threads/${room.threadId}/messages/${boardRow.id}/app`)).toMatchObject({ room: true, can: { serverTools: false, serverResources: false, message: false } });

    // Both rows render in the room for the person, view-only: no Point and no Share on the page.
    const live = (id: string) => `[data-app="${id}"][data-app-room][data-app-state="live"] iframe[data-app-frame]`;
    await until(() => evaluate(`Boolean(document.querySelector('${live(pageId)}') && document.querySelector('${live(boardRow.id)}'))`), "both frames to go live", 30_000);
    expect(await evaluate(`[...document.querySelectorAll('[data-app="${pageId}"] button')].map((b) => b.textContent.trim()).filter((t) => t === "Point" || t === "Share")`)).toEqual([]);
    expect(await evaluate(`Boolean([...document.querySelectorAll('[data-app="${pageId}"] button')].find((b) => b.getAttribute("aria-label") === "Full screen"))`)).toBe(true);
    mkdirSync(evidenceDir, { recursive: true });

    // Every request the renderer makes goes through fetch: from here on each one is kept.
    await evaluate(`(() => { window.__requests = []; const original = window.fetch; window.fetch = (input, init) => {
      window.__requests.push([String(input instanceof Request ? input.url : input), (init && init.method) || "GET"]); return original(input, init); }; return true; })()`);
    const frameBox = async (id: string): Promise<{ left: number; top: number; height: number; viewport: number }> => evaluate(`(() => {
      const r = document.querySelector('[data-app="${id}"] iframe').getBoundingClientRect(); return { left: r.left, top: r.top, height: r.height, viewport: innerHeight }; })()`);
    const inView = (id: string) => until(async () => {
      await evaluate(`document.querySelector('[data-app="${id}"]').scrollIntoView({ block: "center" }); true`);
      await new Promise((done) => setTimeout(done, 400));
      const box = await frameBox(id);
      return box.top >= 0 && box.top + 150 <= box.viewport ? box : null;
    }, `the frame of ${id} to be in view`);
    /** A real mouse press and release at a point inside the frame. */
    const click = async (box: { left: number; top: number }, x: number, y: number) => {
      await mouse("move", String(Math.round(box.left + x)), String(Math.round(box.top + y)));
      await mouse("down");
      await mouse("up");
    };

    const sentBefore = (await transcript()).filter((message) => message.role === "user").length;
    const page = await inView(pageId);
    await ui("screenshot", "--out", join(evidenceDir, "room-pages-shown.png"));
    await click(page, 146, 70);
    // 300px: send() resolved in the page without asking the host; a refusal would leave it at 240px.
    await until(async () => (await frameBox(pageId)).height === 300, "the page to show what its send did");
    expect(await shows("Clicked: send() resolved and posted nothing")).toBe(true);
    await inView(pageId);
    await ui("screenshot", "--out", join(evidenceDir, "room-pages-clicked-send.png"));

    await inView(boardRow.id);
    await ui("click", "--name", "Paint it red");
    await until(() => shows(`Error -32000: ${ROOM_VIEW_ONLY}`), "the board to show the host's refusal");
    await inView(boardRow.id);
    await ui("screenshot", "--out", join(evidenceDir, "room-pages-clicked-app.png"));

    await evaluate(`fetch("/api/health").catch(() => {}); true`);
    const requests = await until(async () => {
      const seen = await evaluate("window.__requests") as Array<[string, string]>;
      return seen.some(([url]) => url.endsWith("/api/health")) ? seen : null;
    }, "the request recorder to see its own check");
    expect(requests.filter(([, method]) => method !== "GET")).toEqual([]);
    const after = await transcript();
    expect(after.filter((message) => message.role === "user")).toHaveLength(sentBefore);
    expect(after.filter((message) => message.kind === "app").map((message) => message.app?.context)).toEqual([undefined, undefined]);
    // The server refuses the same calls a page or a client could make on its own.
    const refused = await fetch(`${info.url}/api/bots/${info.botId}/messages`, { method: "POST", headers: { "content-type": "application/json", origin: info.url },
      body: JSON.stringify({ threadId: room.threadId, sendId: "room-pages-ui-send-0002", appMessage: { messageId: pageId, text: "I have had 3 cups" } }) });
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: ROOM_VIEW_ONLY } });
    const logs = await ui("console");
    writeFileSync(join(evidenceDir, "room-pages.json"), JSON.stringify({ room, rows, pageDoc: { ...pageDoc, srcdoc: `${String(pageDoc.srcdoc).slice(0, 200)}…` }, requests, console: logs }, null, 2));
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
  } finally {
    if (engineSide && engineSide.exitCode === null) await waitForExit(engineSide, { signal: "SIGTERM", graceMs: 5_000 });
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(existsSync(info.dataDir)).toBe(false);
    await removeTempDir(scratch);
  }
}, LAUNCH_TIMEOUT_MS + 240_000);
