// A room as a feed of its threads, in the real renderer, with no switch: a room of two bots shows each thread's first
// line and its replies, the room's "+" in the sidebar brings the room up with the cursor in the feed's composer, a row
// opens its thread beside the feed, and a line sent from the feed's composer starts a thread of its own there while the
// room's current thread stays where it was. A row's menu pins, archives and deletes its thread, archived ones come back
// under Show archived threads, and the panel beside the feed renames and deletes the thread it holds. Below 768px the
// room is its single transcript.
// Closed threads fold into one quiet row that opens ten at a time, the panel says who closed its thread and reopens it,
// a new line opens a closed thread, and the sidebar marks a closed thread and offers Reopen.
// Needs the pinned agent-browser binary: runs when one resolves (tools directory, OMB_AGENT_BROWSER_PATH or PATH) or
// OMB_UI_E2E=1 asks for the verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

    await evaluate(`document.querySelector('[data-sidebar-bot-row="${info.botId}"]').click(); true`);
    await until(() => evaluate("!document.querySelector('[data-room-feed]')"), "the bot's chat on screen");
    await evaluate(`document.querySelector('[data-sidebar-group-row="${room.id}"]').parentElement.querySelector('button[aria-label="New thread"]').click(); true`);
    await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length === 3"), "the feed to list the room's three threads");
    await until(() => evaluate("document.activeElement === document.querySelector('[data-room-feed-composer] textarea')"), "the cursor in the feed's composer after the room's +");
    expect(await current()).toBe(room.threadId);
    // The sidebar's top + offers the same, for the room that is open.
    await evaluate("document.activeElement.blur(); document.querySelector('button[aria-label=\"New or share\"]').click(); true");
    await until(() => evaluate(`Boolean(document.querySelector('[data-plus-room-thread="${room.id}"]'))`), "New thread in the room on the + menu");
    expect(await evaluate(`document.querySelector('[data-plus-room-thread="${room.id}"]').textContent`)).toBe("New thread in Launch room");
    await evaluate(`document.querySelector('[data-plus-room-thread="${room.id}"]').click(); true`);
    await until(() => evaluate("document.activeElement === document.querySelector('[data-room-feed-composer] textarea')"), "the cursor in the feed's composer after the top +");
    expect(await current()).toBe(room.threadId);
    expect(await evaluate("[...document.querySelectorAll('[data-feed-thread]')].map((row) => row.textContent.includes('1 reply'))")).toEqual([true, true, true]);
    expect(await evaluate(`Boolean(document.querySelector('[aria-expanded][aria-label*="Launch room"]'))`)).toBe(false);
    await ui("screenshot", "--out", join(evidenceDir, "room-feed.png"));

    await evaluate("document.querySelectorAll('[data-feed-thread] > button:first-child')[1].click(); true");
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

    const row = (threadId: string) => `[data-feed-thread="${threadId}"]`;
    const menuItem = (label: string) => `[...[...document.querySelectorAll('[data-thread-overlay]')].at(-1)?.querySelectorAll('button') ?? []].find((button) => button.textContent.includes(${JSON.stringify(label)}))`;
    const tasks = async () => ((await api("GET", "/api/bots")).groups as Array<{ id: string; tasks: Array<{ threadId: string; title: string; pinned?: boolean; archivedAt?: number }> }>).find((group) => group.id === room.id)!.tasks;
    const [, logos] = await evaluate("[...document.querySelectorAll('[data-feed-thread]')].map((item) => item.getAttribute('data-feed-thread'))") as string[];
    await evaluate(`document.querySelector('${row(logos!)} button[aria-expanded]').click(); true`);
    await until(() => evaluate(`Boolean(${menuItem("Pin")})`), "the row's menu");
    await evaluate(`${menuItem("Pin")}.click(); true`);
    await until(async () => (await tasks()).find((task) => task.threadId === logos)?.pinned === true, "the thread to be pinned");
    await until(() => evaluate(`Boolean(document.querySelector('${row(logos!)} [data-feed-pinned]'))`), "the pin on its row");

    await evaluate(`document.querySelector('${row(logos!)} button[aria-expanded]').click(); true`);
    await until(() => evaluate(`Boolean(${menuItem("Archive")})`), "the row's menu again");
    await evaluate(`${menuItem("Archive")}.click(); true`);
    await until(() => evaluate(`!document.querySelector('${row(logos!)}')`), "the archived thread to leave the feed");
    await evaluate("document.querySelector('[data-feed-archived-toggle]').click(); true");
    await until(() => evaluate(`Boolean(document.querySelector('${row(logos!)}'))`), "the archived thread to show again");
    await evaluate(`document.querySelector('${row(logos!)} button[aria-expanded]').click(); true`);
    await until(() => evaluate(`Boolean(${menuItem("Unarchive")})`), "Unarchive in its menu");
    await evaluate(`${menuItem("Unarchive")}.click(); true`);
    await until(async () => (await tasks()).find((task) => task.threadId === logos)?.archivedAt === undefined, "the thread to come back");

    await evaluate(`document.querySelector('${row(logos!)} > button:first-child').click(); true`);
    await until(() => evaluate(`document.querySelector('[data-thread-panel]')?.getAttribute('data-thread-panel') === ${JSON.stringify(logos)}`), "the thread beside the feed");
    await browse("click", "[data-thread-panel] header button[aria-expanded]");
    await until(() => evaluate(`Boolean(${menuItem("Download as .md")})`), "the panel's menu with the thread's export");
    await evaluate(`${menuItem("Rename thread")}.click(); true`);
    await until(() => evaluate("document.activeElement === document.querySelector('[data-thread-panel] header input')"), "the title's field");
    await browse("fill", "[data-thread-panel] header input", "Logo files");
    await browse("press", "Enter");
    await until(async () => (await tasks()).find((task) => task.threadId === logos)?.title === "Logo files", "the thread's new title");
    expect(await evaluate("document.querySelector('[data-thread-panel] h2').textContent")).toBe("Logo files");
    expect(await evaluate("getComputedStyle(document.querySelector('[data-room-feed] .glass-scroller')).maskImage")).toContain("linear-gradient");
    await ui("screenshot", "--out", join(evidenceDir, "room-feed-thread-actions.png"));

    const confirmDelete = `[...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Delete thread")`;
    const demo = (await evaluate("[...document.querySelectorAll('[data-feed-thread]')].map((item) => item.getAttribute('data-feed-thread'))") as string[])[2]!;
    await evaluate(`document.querySelector('${row(demo)} button[aria-expanded]').click(); true`);
    await until(() => evaluate(`Boolean(${menuItem("Delete thread")})`), "Delete in the row's menu");
    await evaluate(`${menuItem("Delete thread")}.click(); true`);
    await until(() => evaluate(`Boolean(${confirmDelete})`), "the delete confirmation");
    await evaluate(`${confirmDelete}.click(); true`);
    await until(async () => !(await tasks()).some((task) => task.threadId === demo), "the thread to be deleted");
    await until(() => evaluate(`!document.querySelector('${row(demo)}')`), "its row to leave the feed");
    await browse("click", "[data-thread-panel] header button[aria-expanded]");
    await until(() => evaluate(`Boolean(${menuItem("Delete thread")})`), "Delete in the panel's menu");
    await evaluate(`${menuItem("Delete thread")}.click(); true`);
    await until(() => evaluate(`Boolean(${confirmDelete})`), "the panel's delete confirmation");
    await evaluate(`${confirmDelete}.click(); true`);
    await until(async () => !(await tasks()).some((task) => task.threadId === logos), "the open thread to be deleted");
    await until(() => evaluate("!document.querySelector('[data-thread-panel]')"), "the panel to close");

    // An Inbox line for a bot's own thread opens in the chat, as before the feed; only room threads use the side panel.
    await api("POST", `/api/bots/${basil.id}/messages`, { text: "Check the invoices" });
    await idle();
    const inboxOpen = () => evaluate("Boolean(document.querySelector('[data-inbox-panel=\"side\"]'))");
    const toggleInbox = () => evaluate("document.querySelector('[data-sidebar-inbox]').click(); true");
    if (!(await inboxOpen())) await toggleInbox();
    await until(() => evaluate("[...document.querySelectorAll('[data-inbox-panel] button[aria-label]')].some((b) => b.getAttribute('aria-label').includes('Basil'))"), "Basil's thread in the Inbox");
    await evaluate("[...document.querySelectorAll('[data-inbox-panel] button[aria-label]')].find((b) => b.getAttribute('aria-label').includes('Basil')).click(); true");
    await until(() => evaluate(`document.querySelector('[data-sidebar-bot-row="${basil.id}"]')?.getAttribute('aria-current') === 'page'`), "Basil's chat on screen");
    expect(await evaluate("Boolean(document.querySelector('[data-thread-panel]'))")).toBe(false);
    if (await inboxOpen()) await toggleInbox();

    // A room thread sits beside the feed only while the feed keeps 420px; otherwise it takes the feed's place, with a way back.
    const layouts: Array<Record<string, unknown>> = [];
    for (const width of ["1100", "900", "800"]) {
      for (const withInbox of [false, true]) {
        await browse("set", "viewport", width, "900");
        await evaluate(`document.querySelector('[data-sidebar-group-row="${room.id}"]')?.click(); true`);
        await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length > 0"), `the feed at ${width}px`);
        if (withInbox !== await inboxOpen()) await toggleInbox();
        await evaluate("document.querySelector('[data-feed-thread] > button:first-child').click(); true");
        await until(() => evaluate("Boolean(document.querySelector('[data-thread-panel]'))"), `the thread at ${width}px`);
        const measure = () => evaluate(`(() => {
          const feed = document.querySelector('[data-room-feed]'), panel = document.querySelector('[data-thread-panel]');
          return { width: ${width}, withInbox: ${withInbox}, inboxAfter: Boolean(document.querySelector('[data-inbox-panel="side"]')),
            inPlace: panel.hasAttribute('data-thread-in-place'), feed: feed ? Math.round(feed.getBoundingClientRect().width) : 0,
            panel: Math.round(panel.getBoundingClientRect().width), back: Boolean(document.querySelector('[data-thread-back]')) };
        })()`) as Promise<Record<string, unknown>>;
        // The sidebar folds and the panel slides in first: read the layout once it holds still.
        let layout = await measure();
        for (let tries = 0; tries < 20; tries++) {
          await new Promise((done) => setTimeout(done, 600));
          const again = await measure();
          if (JSON.stringify(again) === JSON.stringify(layout)) break;
          layout = again;
        }
        layouts.push(layout);
        if (layout.inPlace) {
          expect(layout, JSON.stringify(layout)).toMatchObject({ feed: 0, back: true });
          await ui("screenshot", "--out", join(evidenceDir, `room-feed-thread-in-place-${width}${withInbox ? "-inbox" : ""}.png`));
          await evaluate("document.querySelector('[data-thread-back]').click(); true");
          await until(() => evaluate("Boolean(document.querySelector('[data-room-feed]')) && !document.querySelector('[data-thread-panel]')"), "back to the feed");
        } else {
          expect(layout.feed as number, JSON.stringify(layout)).toBeGreaterThanOrEqual(420);
          expect(layout.panel as number).toBeGreaterThanOrEqual(360);
          await evaluate("document.querySelector('[data-thread-panel] header button[aria-label=\"Close thread\"]').click(); true");
          await until(() => evaluate("!document.querySelector('[data-thread-panel]')"), "the thread to close");
        }
      }
    }
    writeFileSync(join(evidenceDir, "room-feed-layouts.json"), JSON.stringify(layouts, null, 1));
    const at = (width: number, withInbox: boolean) => layouts.find((layout) => layout.width === width && layout.withInbox === withInbox);
    // Opened with the Inbox open, where the Inbox is what leaves too little room, the Inbox closes and the thread sits beside.
    expect(at(1100, true)).toMatchObject({ inPlace: false, inboxAfter: false });
    // At 800px the feed and the thread never both fit: the thread takes the feed's place, and an open Inbox stays.
    expect(at(800, false)).toMatchObject({ inPlace: true });
    expect(at(800, true)).toMatchObject({ inPlace: true, inboxAfter: true });
    if (await inboxOpen()) await toggleInbox();

    await browse("set", "viewport", "700", "900");
    await until(() => evaluate("!document.querySelector('[data-room-feed]') && Boolean(document.querySelector('[data-look=\"chat\"] [role=\"log\"]'))"), "the room's transcript below 768px");
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(existsSync(info.dataDir)).toBe(false);
  }
}, LAUNCH_TIMEOUT_MS + 240_000);

(enabled ? it : it.skip)("folds a room's closed threads, says who closed one beside the feed, and opens it again", async () => {
  const { child, info } = await launch();
  try {
    const api = fixtureApi(info.url, { headers: { origin: info.url } });
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
    const browse = (...args: string[]) => agentBrowser(browser.binary, sessionEnv(browser), args);
    const shot = async (name: string) => {
      for (const skin of ["midnight", "daylight"]) {
        await evaluate(`import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin(${JSON.stringify(skin)}); return true; })`);
        await new Promise((done) => setTimeout(done, 400));
        await ui("screenshot", "--out", join(evidenceDir, `${name}-${skin}.png`));
      }
      await evaluate("import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin('midnight'); return true; })");
    };
    await browse("set", "viewport", "1440", "900");
    const idle = () => until(async () => ((await api("GET", "/api/bots")).bots as Array<{ busy?: boolean }>).every((bot) => !bot.busy), "the bots to settle");

    const room = (await api("POST", "/api/groups", {
      memberIds: [info.botId], name: "Docs room", setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const lines = ["Outline the API guide", "Fix the README typo", "Rename the config page", "Update the changelog", "Plan the docs sprint"];
    const threads: string[] = [];
    for (const [index, text] of lines.entries()) {
      const threadId = index === 0 ? room.threadId : (await api("POST", `/api/groups/${room.id}/tasks`, { activate: false })).task.threadId;
      threads.push(threadId);
      await api("POST", `/api/groups/${room.id}/messages`, { text, threadId });
      await idle();
      await api("POST", `/api/groups/${room.id}/read`, { threadId });
    }
    const tasks = async () => ((await api("GET", "/api/bots")).groups as Array<{ id: string; tasks: Array<{ threadId: string; closedAt?: number; closedBy?: { kind: string; name: string } }> }>)
      .find((group) => group.id === room.id)!.tasks;
    const row = (threadId: string) => `[data-feed-thread="${threadId}"]`;
    const menuItem = (label: string) => `[...[...document.querySelectorAll('[data-thread-overlay]')].at(-1)?.querySelectorAll('button') ?? []].find((button) => button.textContent === ${JSON.stringify(label)})`;

    await evaluate(`document.querySelector('[data-sidebar-group-row="${room.id}"]').click(); true`);
    await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length === 5"), "the feed to list the room's five threads");
    await shot("close-before");

    await evaluate(`document.querySelector('${row(threads[1]!)} button[aria-expanded]').click(); true`);
    await until(() => evaluate(`Boolean(${menuItem("Close")})`), "Close in the row's menu");
    await evaluate(`${menuItem("Close")}.click(); true`);
    await until(async () => (await tasks()).find((task) => task.threadId === threads[1])?.closedBy?.kind === "person", "the thread to be closed by the person");
    for (const threadId of threads.slice(2, 4)) await api("PATCH", `/api/groups/${room.id}/tasks/${threadId}`, { closed: true });
    await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length === 2"), "the closed threads to fold");
    expect(await evaluate("[...document.querySelectorAll('[data-feed-fold]')].map((fold) => fold.textContent)")).toEqual(["3 closed threads"]);
    await shot("close-folded");

    await evaluate("document.querySelector('[data-feed-fold]').click(); true");
    await until(() => evaluate("document.querySelectorAll('[data-feed-thread]').length === 5 && !document.querySelector('[data-feed-fold]')"), "the fold to open in place");
    expect(await evaluate("[...document.querySelectorAll('[data-feed-thread]')].map((item) => Boolean(item.querySelector('[data-feed-closed]')))")).toEqual([false, true, true, true, false]);
    await shot("close-unfolded");

    await evaluate(`document.querySelector('${row(threads[2]!)} > button:first-child').click(); true`);
    await until(() => evaluate(`document.querySelector('[data-thread-panel]')?.getAttribute('data-thread-panel') === ${JSON.stringify(threads[2])}`), "the closed thread beside the feed");
    await until(() => evaluate("document.querySelector('[data-thread-closed]')?.textContent.startsWith('Closed by ')"), "who closed it, in the panel");
    expect(await evaluate("document.querySelectorAll('[data-feed-thread]').length === 5 && !document.querySelector('[data-feed-fold]')")).toBe(true);
    await shot("close-panel");
    await browse("set", "viewport", "900", "900");
    await new Promise((done) => setTimeout(done, 400));
    await ui("screenshot", "--out", join(evidenceDir, "close-panel-narrow-midnight.png"));
    await browse("set", "viewport", "1440", "900");
    await evaluate("document.querySelector('[data-thread-reopen]').click(); true");
    await until(async () => (await tasks()).find((task) => task.threadId === threads[2])?.closedAt === undefined, "Reopen to open the thread");
    await until(() => evaluate("!document.querySelector('[data-thread-closed]') && !document.querySelector('[data-thread-reopen]')"), "the panel to drop its closed line");
    await browse("click", "[data-thread-panel] header button[aria-expanded]");
    await until(() => evaluate(`Boolean(${menuItem("Close")})`), "Close in the panel's menu");
    await evaluate(`${menuItem("Close")}.click(); true`);
    await until(() => evaluate("Boolean(document.querySelector('[data-thread-reopen]'))"), "the panel to show its thread closed again");
    await evaluate("document.querySelector('[data-thread-panel] header button[aria-label=\"Close thread\"]').click(); true");

    await api("POST", `/api/groups/${room.id}/messages`, { text: "One more README fix", threadId: threads[1] });
    await until(async () => (await tasks()).find((task) => task.threadId === threads[1])?.closedAt === undefined, "a new line to open the thread");
    await idle();
    await until(() => evaluate(`Boolean(document.querySelector('${row(threads[1]!)}')) && !document.querySelector('${row(threads[1]!)} [data-feed-closed]')`), "the reopened thread as an ordinary row");

    await browse("set", "viewport", "700", "900");
    await until(() => evaluate("!document.querySelector('[data-room-feed]')"), "the room's transcript below 768px");
    await evaluate(`document.querySelector('button[aria-label="Open bot list"]').click(); true`);
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Expand Docs room threads"], [aria-label="Collapse Docs room threads"]'))`), "the room in the bot list");
    await evaluate(`document.querySelector('[aria-label="Expand Docs room threads"]')?.click(); true`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-sidebar-thread-row="${threads[3]}"]'))`), "the room's threads in the sidebar");
    expect(await evaluate(`document.querySelector('[data-sidebar-thread-row="${threads[3]}"]').textContent`)).toContain("closed by");
    await evaluate(`document.querySelector('[data-sidebar-thread-row="${threads[3]}"]').parentElement.querySelector('button[aria-expanded]').click(); true`);
    await until(() => evaluate(`Boolean(${menuItem("Reopen")})`), "Reopen in the sidebar row's menu");
    await shot("close-sidebar");
    await evaluate(`${menuItem("Reopen")}.click(); true`);
    await until(async () => (await tasks()).find((task) => task.threadId === threads[3])?.closedAt === undefined, "the sidebar's Reopen to open the thread");
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(existsSync(info.dataDir)).toBe(false);
  }
}, LAUNCH_TIMEOUT_MS + 240_000);
