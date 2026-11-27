// A person's and a bot's input to a page, on the default engine, through the real server: the pinned agent-browser and
// its Chrome, the live view's event stream and action requests as the app sends them, and the bot's tools as a model
// calls them. The page reports what it saw to this test's own server. Runs when agent-browser resolves (tools directory,
// OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the download; otherwise skipped.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import type { PreviewStreamInput } from "../../src/lib/browser-stream-client.ts";
import { liveAction } from "../../src/lib/browser-live-action.ts";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../control-omb.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";

const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) {
  console.log(`skipping browser input e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;

/** Fixed positions, so a person's click is aimed without reading the page. */
const PAGE = `<!doctype html><title>Input fixture</title><body style="margin:0;font:16px sans-serif">
<button id="press" style="position:absolute;left:40px;top:40px;width:200px;height:40px">Press</button>
<input id="name" aria-label="Name" style="position:absolute;left:40px;top:100px;width:200px;height:30px">
<div id="rich" contenteditable="true" style="position:absolute;left:40px;top:160px;width:200px;height:30px"></div>
<select id="pick" style="position:absolute;left:40px;top:220px;width:200px;height:30px"><option>Alpha</option><option>Beta</option><option>Gamma</option></select>
<button id="off" disabled style="position:absolute;left:300px;top:40px">Closed</button>
<div id="plain" style="position:absolute;left:300px;top:100px">Plain text</div>
<button id="swap" style="position:absolute;left:300px;top:160px">Swap</button>
<script>
let order = 0;
const say = (what) => fetch("/seen?" + new URLSearchParams({ what, order: String(order++) }));
document.getElementById("press").addEventListener("click", (event) => say("click:" + event.isTrusted));
document.getElementById("name").addEventListener("input", (event) => say("input:" + event.target.value));
document.getElementById("rich").addEventListener("input", (event) => say("rich:" + event.target.textContent));
document.getElementById("pick").addEventListener("change", (event) => say("pick:" + event.target.selectedIndex));
document.getElementById("off").addEventListener("click", () => say("off-click"));
document.getElementById("swap").addEventListener("click", () => {
  const fresh = document.createElement("input");
  fresh.setAttribute("aria-label", "Name");
  fresh.addEventListener("input", (event) => say("fresh:" + event.target.value));
  document.getElementById("name").replaceWith(fresh);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab" || event.metaKey) event.preventDefault();
  say(["keydown", event.key, event.code, event.keyCode, +event.ctrlKey, +event.shiftKey, +event.altKey, +event.metaKey].join(" "));
}, true);
say("load");
</script>`;
const PRESS = { x: 140, y: 60 };
const NAME = { x: 140, y: 115 };
const RICH = { x: 140, y: 175 };
const PICK = { x: 140, y: 235 };

type Body = Record<string, unknown>;
type Answer = { status: number; body: any };

/** The app's v1 action for an input: the body the panel posts. */
function action(input: PreviewStreamInput): Body {
  const body = liveAction(input);
  if (!body || Array.isArray(body)) throw new Error(`no single v1 action for ${input.type}`);
  return body;
}

const mouse = (kind: "move" | "down" | "up", at: { x: number; y: number }) =>
  action({ type: "mouse", action: kind, ...at, button: kind === "move" ? "none" : "left", buttons: kind === "down" ? 1 : 0, clickCount: kind === "move" ? 0 : 1, modifiers: 0 });

/** A letter's key-down and key-up as the panel's keyboard handler sends them. */
function keys(letter: string): Body[] {
  const key = { type: "key", key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), modifiers: 0 } as const;
  return [action({ ...key, action: "down", text: letter }), action({ ...key, action: "up" })];
}

describe("input to a page on the default browser engine", () => {
  let pages: Server;
  let base = "";
  let fixture: VerificationServer;
  let url = "";
  let bot: { id: string; threadId: string };
  let binary = "";
  const seen: string[] = [];
  const closers: Array<() => void> = [];

  const api = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
  /** A failure's own evidence: the end of the server's log, which goes with the fixture otherwise. */
  const showServerLog = () => onTestFailed(() => {
    let log = "(the server log could not be read)";
    try { log = serverLog().split("\n").slice(-60).join("\n"); } catch {}
    console.log(`server log, last lines:\n${log}`);
  });
  /** The server's lines about input that did not reach the page, without each browser's own session id. */
  const dropLines = () => serverLog().split("\n").filter((line) => line.startsWith("browser input:")).map((line) => line.replace(/ session=\S+/, ""));

  beforeAll(async () => {
    if (!enabled) return;
    const browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    binary = browser.binary;
    pages = createServer((req, res) => {
      const at = new URL(req.url ?? "/", "http://fixture.invalid");
      if (at.pathname === "/seen") { seen[Number(at.searchParams.get("order"))] = at.searchParams.get("what") ?? ""; res.writeHead(204); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;
    fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, { scripted: true });
    url = fixture.info.url;
    // A self-hosted server's bots reach this machine's own pages only where an admin allows it.
    expect((await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { egress: { allow: ["127.0.0.1"] } } })).status).toBe(200);
    bot = (await api("POST", "/api/bots", { name: "Visitor" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
  }, 600_000);

  afterAll(async () => {
    if (!enabled) return;
    for (const close of closers) close();
    // A failed test can leave the engine's daemon running: close --all is scoped to this fixture's HOME.
    if (fixture) await promisify(execFile)(binary, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => undefined);
    await fixture?.close();
    await new Promise((resolve) => pages?.close(resolve));
  }, 60_000);

  /** One connection of the live view: its event stream read, each frame acknowledged. */
  async function connectView() {
    const abort = new AbortController();
    closers.push(() => abort.abort());
    // As the panel opens it: a view that draws the page's dropdown lists.
    const stream = await fetch(`${url}/api/bots/${bot.id}/browser/live?selects=1`, { headers: { origin: url, accept: "text/event-stream" }, signal: abort.signal });
    expect(stream.status).toBe(200);
    const view = { viewerId: "", inputBatch: 1, frames: 0, ended: false, error: "", retryable: false, selectPopups: [] as Array<{ id: string; options: Array<{ label: string }>; selectedIndex: number }> };
    const post = (body: Body) => api("POST", `/api/bots/${bot.id}/browser/action`, { ...body, viewerId: view.viewerId });
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          let data: any = {};
          try { data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}"); } catch { continue; }
          if (name === "ready") { view.viewerId = data.viewerId; view.inputBatch = Number(data.inputBatch) || 1; }
          if (name === "frame") { view.frames += 1; void post({ type: "ack", seq: data.seq }).catch(() => undefined); }
          if (name === "error") { view.error = String(data.message); view.retryable = data.retryable === true; }
          if (name === "selectPopup") view.selectPopups.push(data);
        }
      }
    })().catch(() => undefined).finally(() => { view.ended = true; });
    await expect.poll(() => view.viewerId !== "" || view.ended, { timeout: 90_000, interval: 100 }).toBe(true);
    return { view, post, close: () => abort.abort() };
  }

  /** The live view as the panel opens it: like the panel, it connects again, up to five times, after an error the server
   * calls retryable (an engine slow to start on a busy machine is restarted, and the view told to reconnect). */
  async function openView() {
    let opened = await connectView();
    for (let attempt = 1; attempt < 5 && !opened.view.viewerId && opened.view.retryable; attempt++) {
      opened.close();
      opened = await connectView();
    }
    expect({ error: opened.view.error, ready: opened.view.viewerId !== "" }).toEqual({ error: "", ready: true });
    await expect.poll(() => opened.view.frames, { timeout: 60_000, interval: 100 }).toBeGreaterThan(0);
    return opened;
  }

  run("the bot's click and fill tools change the page, and a missing target is an error the server logs", async () => {
    showServerLog();
    const planPath = join(fixture.info.dataDir, "room-plan.json");
    const evidence = () => { try { return readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
    seen.length = 0;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [{ timeoutMs: 180_000, steps: [
      { server: "browser", tool: "agent_browser_open", arguments: { url: `${base}/` } },
      { server: "browser", tool: "agent_browser_click", arguments: { selector: "#press" } },
      { server: "browser", tool: "agent_browser_fill", arguments: { selector: "#name", text: "hello" } },
      { server: "browser", tool: "agent_browser_click", arguments: { selector: "#missing" }, expectError: true },
    ], reply: "Done." }] } }));
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Use the page.", "--url", url]);
    const results = () => evidence().flatMap((turn: any) => turn.evidence).filter((entry: any) => entry.step?.server === "browser").map((entry: any) => entry.response.result.isError === true);
    await expect.poll(results, { timeout: 180_000, interval: 200 }).toEqual([false, false, false, true]);
    await expect.poll(() => seen.includes("click:true") && seen.includes("input:hello"), { timeout: 15_000, interval: 100 }).toBe(true);
    await expect.poll(dropLines, { timeout: 10_000, interval: 100 }).toContain("browser input: bot click dropped reason=target_not_found engine=agent-browser transport=tools");
    expect(serverLog()).not.toContain("#missing");
  }, 300_000);

  run("a person takes control, clicks a button and types a word, and the page sees both", async () => {
    showServerLog();
    const { view, post, close } = await openView();
    // A failure here must not leave the browser held for whatever runs next.
    try {
      expect(await post({ type: "take" })).toMatchObject({ status: 200, body: { ok: true } });
      seen.length = 0;
      expect(await post(action({ type: "navigate", url: `${base}/` }))).toEqual({ status: 200, body: { ok: true } });
      await expect.poll(() => seen.includes("load"), { timeout: 30_000, interval: 100 }).toBe(true);

      for (const kind of ["move", "down", "up"] as const) expect(await post(mouse(kind, PRESS))).toEqual({ status: 200, body: { ok: true } });
      await expect.poll(() => seen.includes("click:true"), { timeout: 15_000, interval: 100 }).toBe(true);

      for (const kind of ["move", "down", "up"] as const) expect(await post(mouse(kind, NAME))).toEqual({ status: 200, body: { ok: true } });
      const typed = [..."word"].flatMap(keys);
      // The panel sends what queued behind a request as one batch where the server said it takes batches.
      if (view.inputBatch >= typed.length) expect(await post({ type: "input_batch", events: typed })).toEqual({ status: 200, body: { ok: true } });
      else for (const body of typed) expect(await post(body)).toEqual({ status: 200, body: { ok: true } });
      // Each report is its own request, so they may arrive out of order.
      await expect.poll(() => seen.filter((entry) => entry.startsWith("input:")).sort(), { timeout: 15_000, interval: 100 }).toEqual(["input:w", "input:wo", "input:wor", "input:word"]);

      expect(await post({ type: "release" })).toEqual({ status: 200, body: { ok: true } });
      const refused = await post(mouse("down", PRESS));
      expect(refused).toEqual({ status: 409, body: { error: "Browser control changed. Try again." } });
      await expect.poll(dropLines, { timeout: 10_000, interval: 100 }).toContain("browser input: person input_mouse dropped reason=not_controlling engine=agent-browser transport=v1");
      expect(seen.filter((entry) => entry.startsWith("click:"))).toEqual(["click:true"]);
    } finally {
      await post({ type: "release" }).catch(() => undefined);
      close();
    }
  }, 300_000);

  /** A view holding the browser on a fresh copy of the fixture page. */
  async function holdPage() {
    const opened = await openView();
    expect(await opened.post({ type: "take" })).toMatchObject({ status: 200, body: { ok: true } });
    seen.length = 0;
    expect(await opened.post(action({ type: "navigate", url: `${base}/?at=${Date.now()}` }))).toEqual({ status: 200, body: { ok: true } });
    await expect.poll(() => seen.includes("load"), { timeout: 30_000, interval: 100 }).toBe(true);
    const click = async (at: { x: number; y: number }) => {
      for (const kind of ["move", "down", "up"] as const) expect(await opened.post(mouse(kind, at))).toEqual({ status: 200, body: { ok: true } });
    };
    return { ...opened, click };
  }

  run("a person's keys reach the page with their key, code, key code and modifiers, in a field and in rich text", async () => {
    showServerLog();
    const { post, click, close } = await holdPage();
    try {
      type Key = { key: string; code: string; keyCode: number; modifiers?: number; text?: string };
      const press = async (keys: Key[]) => {
        for (const key of keys) expect(await post(action({ type: "key", action: "down", modifiers: 0, ...key }))).toEqual({ status: 200, body: { ok: true } });
        for (const key of [...keys].reverse()) expect(await post(action({ type: "key", action: "up", key: key.key, code: key.code, keyCode: key.keyCode, modifiers: 0 }))).toEqual({ status: 200, body: { ok: true } });
      };
      const shift = { key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: 8 };
      await click(NAME);
      seen.length = 0;
      await press([{ key: "a", code: "KeyA", keyCode: 65, text: "a" }]);
      await press([shift, { key: "B", code: "KeyB", keyCode: 66, modifiers: 8, text: "B" }]);
      await press([{ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }]);
      await press([{ key: "Backspace", code: "Backspace", keyCode: 8 }]);
      await press([{ key: "Escape", code: "Escape", keyCode: 27 }]);
      await press([{ key: "Control", code: "ControlLeft", keyCode: 17, modifiers: 2 }, { key: "a", code: "KeyA", keyCode: 65, modifiers: 2 }]);
      await press([{ key: "Meta", code: "MetaLeft", keyCode: 91, modifiers: 4 }, { key: "k", code: "KeyK", keyCode: 75, modifiers: 4 }]);
      await press([{ key: "F2", code: "F2", keyCode: 113 }]);
      await press([{ key: "Tab", code: "Tab", keyCode: 9 }]);
      const downs = () => seen.filter((entry) => entry?.startsWith("keydown "));
      // key, code, keyCode, then Control, Shift, Alt and Meta held.
      await expect.poll(downs, { timeout: 15_000, interval: 100 }).toEqual([
        "keydown a KeyA 65 0 0 0 0", "keydown Shift ShiftLeft 16 0 1 0 0", "keydown B KeyB 66 0 1 0 0", "keydown ArrowLeft ArrowLeft 37 0 0 0 0",
        "keydown Backspace Backspace 8 0 0 0 0", "keydown Escape Escape 27 0 0 0 0", "keydown Control ControlLeft 17 1 0 0 0", "keydown a KeyA 65 1 0 0 0",
        "keydown Meta MetaLeft 91 0 0 0 1", "keydown k KeyK 75 0 0 0 1", "keydown F2 F2 113 0 0 0 0", "keydown Tab Tab 9 0 0 0 0",
      ]);
      // "aB", then Backspace after ArrowLeft took the "a".
      expect(seen.filter((entry) => entry?.startsWith("input:"))).toEqual(["input:a", "input:aB", "input:B"]);
      await click(RICH);
      seen.length = 0;
      await press([{ key: "h", code: "KeyH", keyCode: 72, text: "h" }]);
      await press([shift, { key: "I", code: "KeyI", keyCode: 73, modifiers: 8, text: "I" }]);
      await expect.poll(() => seen.filter((entry) => entry?.startsWith("rich:")), { timeout: 15_000, interval: 100 }).toEqual(["rich:h", "rich:hI"]);
      expect(downs()).toEqual(["keydown h KeyH 72 0 0 0 0", "keydown Shift ShiftLeft 16 0 1 0 0", "keydown I KeyI 73 0 1 0 0"]);
    } finally {
      await post({ type: "release" }).catch(() => undefined);
      close();
    }
  }, 300_000);

  run("a person's press on a dropdown list shows its options in the view, and the option chosen reaches the page", async () => {
    showServerLog();
    const { view, post, click, close } = await holdPage();
    try {
      for (const index of [2, 1]) {
        const before = view.selectPopups.length;
        seen.length = 0;
        await click(PICK);
        await expect.poll(() => view.selectPopups.length, { timeout: 15_000, interval: 100 }).toBe(before + 1);
        const popup = view.selectPopups.at(-1)!;
        expect(popup.options.map((option) => option.label)).toEqual(["Alpha", "Beta", "Gamma"]);
        // The press opened the view's list, not the page's own: the page saw no click.
        expect(seen.filter((entry) => entry?.startsWith("pick:"))).toEqual([]);
        expect(await post(action({ type: "selectChoose", id: popup.id, index }))).toEqual({ status: 200, body: { ok: true } });
        await expect.poll(() => seen.filter((entry) => entry?.startsWith("pick:")), { timeout: 15_000, interval: 100 }).toEqual([`pick:${index}`]);
      }
      expect(view.selectPopups.at(-1)!.selectedIndex).toBe(2);
    } finally {
      await post({ type: "release" }).catch(() => undefined);
      close();
    }
  }, 300_000);

  run("the bot hears an error for a click on a disabled button and for a fill or type that did not land in its target", async () => {
    showServerLog();
    const planPath = join(fixture.info.dataDir, "room-plan.json");
    const evidence = () => { try { return readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
    const before = evidence().length;
    seen.length = 0;
    const step = (tool: string, args: Record<string, unknown>, expectError = false) => ({ server: "browser", tool: `agent_browser_${tool}`, arguments: args, ...(expectError ? { expectError: true } : {}) });
    // The scripted bot takes the plan's turn at the index of the turns it already took.
    const earlier = Array.from({ length: evidence().filter((turn: any) => turn.botId === bot.id).length }, () => ({ steps: [], reply: "Done." }));
    const turn = (steps: unknown[]) => ({ timeoutMs: 180_000, steps, reply: "Done." });
    const look = turn([
      step("open", { url: `${base}/?bot=${Date.now()}` }),
      step("click", { selector: "#off" }, true),
      step("click", { selector: "#name" }),
      step("fill", { selector: "#plain", text: "zzz" }, true),
      step("type", { selector: "#plain", text: "yyy" }, true),
      step("snapshot", {}),
    ]);
    const send = (turns: unknown[]) => {
      writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [...earlier, ...turns] } }));
      return runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Use the page.", "--url", url]);
    };
    const answers = () => evidence().slice(before).flatMap((turn: any) => turn.evidence).filter((entry: any) => entry.step?.server === "browser");
    const text = (at: number) => answers()[at].response.result.content.map((part: any) => part.text).join(" ");
    await send([look]);
    await expect.poll(() => answers().length, { timeout: 180_000, interval: 200 }).toBe(6);
    // Engines number refs their own way (0.39 counts on across a session), so the next turn uses the ref this snapshot gave.
    const nameRef = /textbox "Name" \[ref=(e\d+)\]/.exec(text(5))?.[1];
    expect(nameRef, text(5)).toBeDefined();
    // After the swap that ref names a field the page replaced.
    await send([look, turn([step("click", { selector: "#swap" }), step("fill", { selector: `@${nameRef}`, text: "eve" }, true)])]);
    await expect.poll(() => answers().length, { timeout: 180_000, interval: 200 }).toBe(8);
    const errors = answers().map((entry: any) => `${entry.step.tool.replace("agent_browser_", "")}:${entry.response.result.isError === true}`);
    expect(errors).toEqual(["open:false", "click:true", "click:false", "fill:true", "type:true", "snapshot:false", "click:false", "fill:true"]);
    // Our own check's words on the pinned engine; agent-browser 0.39.2 and later refuse it themselves.
    expect(text(1)).toMatch(/disabled/);
    expect(text(3)).toContain("does not hold the text");
    // Later engines refuse a ref the page replaced themselves.
    expect(text(7)).toMatch(/Take a new snapshot|Unknown ref/);
    expect(seen).not.toContain("off-click");
  }, 300_000);
});
