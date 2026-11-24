// A room as a feed of its threads, in the real renderer: with Settings → Features → Room feed on, a room of two bots
// shows each thread's first line and its replies, a row opens its thread beside the feed, and a line sent from the
// feed's composer starts a thread of its own there while the room's current thread stays where it was. With the switch
// off the room is its single transcript again. Needs the pinned agent-browser binary: runs when one resolves (tools
// directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping room feed ui e2e: no agent-browser binary resolves; set OMB_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "omb-ui-evidence-"));
afterAll(async () => { if (!process.env.OMB_UI_EVIDENCE_DIR) await removeTempDir(evidenceDir); });

async function launch(): Promise<{ child: ReturnType<typeof spawn>; info: { ui: string; url: string; botId: string; dataDir: string } }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "control-omb.ts"), "ui", "launch"], {
    cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
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

(enabled ? it : it.skip)("shows a room's threads as a feed, opens one beside it, and starts a new one without moving the room's current thread", async () => {
  const { child, info } = await launch();
  try {
    const api = fixtureApi(info.url, { headers: { origin: info.url } });
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
    const browse = (...args: string[]) => agentBrowser(browser.binary, sessionEnv(browser), args);
    await browse("set", "viewport", "1440", "900");
    const idle = () => until(async () => ((await api("GET", "/api/bots")).bots as Array<{ busy?: boolean }>).every((bot) => !bot.busy), "the bots to settle");

    const basil = (await api("POST", "/api/bots", { name: "Basil" })).bot;
    const room = (await api("POST", "/api/groups", {
      memberIds: [info.botId, basil.id], name: "Launch room", setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const lines = ["Plan the launch checklist", "Who has the logo files?", "Book the demo room"];
    for (const [index, text] of lines.entries()) {
      const threadId = index === 0 ? room.threadId : (await api("POST", `/api/groups/${room.id}/tasks`, { activate: false })).task.threadId;
      await api("POST", `/api/groups/${room.id}/messages`, { text, threadId });
      await idle();
    }
    const current = async () => ((await api("GET", "/api/bots")).groups as Array<{ id: string; threadId: string }>).find((group) => group.id === room.id)!.threadId;
    expect(await current()).toBe(room.threadId);

    await ui("flag", "--set", "features.roomFeed=true");
    await evaluate(`document.querySelector('[data-sidebar-group-row="${room.id}"]').click(); true`);
    await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length === 3"), "the feed to list the room's three threads");
    expect(await evaluate("[...document.querySelectorAll('[data-feed-thread]')].map((row) => row.textContent.includes('1 reply'))")).toEqual([true, true, true]);
    expect(await evaluate(`Boolean(document.querySelector('[aria-expanded][aria-label*="Launch room"]'))`)).toBe(false);
    await ui("screenshot", "--out", join(evidenceDir, "room-feed.png"));

    await evaluate("document.querySelectorAll('[data-feed-thread] button')[1].click(); true");
    const opened = await until(() => evaluate("document.querySelector('[data-thread-panel]')?.getAttribute('data-thread-panel')"), "the thread to open beside the feed");
    await until(() => evaluate("document.querySelector('[data-thread-panel]').textContent.includes('Who has the logo files?')"), "the thread's lines in the panel");
    expect(await current()).toBe(room.threadId);
    await ui("screenshot", "--out", join(evidenceDir, "room-feed-thread.png"));

    await browse("click", "[data-room-feed-composer] textarea");
    await browse("type", "[data-room-feed-composer] textarea", "Draft the outage email");
    await browse("press", "Enter");
    await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length === 4"), "the new thread's row in the feed");
    const started = await until(async () => {
      const panel = await evaluate("document.querySelector('[data-thread-panel]')?.getAttribute('data-thread-panel')");
      return panel && panel !== opened ? panel as string : null;
    }, "the new thread to open beside the feed");
    await idle();
    const transcript = (await api("GET", `/api/threads/${started}/messages`)).messages as Array<{ role: string; text?: string }>;
    expect(transcript.find((message) => message.role === "user")?.text).toBe("Draft the outage email");
    expect(await current()).toBe(room.threadId);
    await ui("screenshot", "--out", join(evidenceDir, "room-feed-new-thread.png"));

    await ui("flag", "--set", "features.roomFeed=false");
    await until(() => evaluate("!document.querySelector('[data-room-feed]') && Boolean(document.querySelector('[data-look=\"chat\"] [role=\"log\"]'))"), "the room's transcript to come back");
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(existsSync(info.dataDir)).toBe(false);
  }
}, LAUNCH_TIMEOUT_MS + 240_000);
