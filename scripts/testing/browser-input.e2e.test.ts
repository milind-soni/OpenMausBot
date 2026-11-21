// A person's and a bot's input to a page, on the default engine, through the real server: the pinned agent-browser and
// its Chrome, the live view's event stream and action requests as the app sends them, and the bot's tools as a model
// calls them. The page reports what it saw to this test's own server. Runs when agent-browser resolves (tools directory,
// OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the download; otherwise skipped.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
<script>
const say = (what) => fetch("/seen?" + new URLSearchParams({ what }));
document.getElementById("press").addEventListener("click", (event) => say("click:" + event.isTrusted));
document.getElementById("name").addEventListener("input", (event) => say("input:" + event.target.value));
say("load");
</script>`;
const PRESS = { x: 140, y: 60 };
const NAME = { x: 140, y: 115 };

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
  const seen: string[] = [];
  const closers: Array<() => void> = [];

  const api = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const serverLog = () => readFileSync(fixture.info.logPath, "utf8");

  beforeAll(async () => {
    if (!enabled) return;
    const browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    pages = createServer((req, res) => {
      const at = new URL(req.url ?? "/", "http://fixture.invalid");
      if (at.pathname === "/seen") { seen.push(at.searchParams.get("what") ?? ""); res.writeHead(204); res.end(); return; }
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
    await fixture?.close();
    await new Promise((resolve) => pages?.close(resolve));
  }, 60_000);

  /** The live view as the panel opens it: its event stream read, each frame acknowledged. */
  async function openView() {
    const abort = new AbortController();
    closers.push(() => abort.abort());
    const stream = await fetch(`${url}/api/bots/${bot.id}/browser/live`, { headers: { origin: url, accept: "text/event-stream" }, signal: abort.signal });
    expect(stream.status).toBe(200);
    const view = { viewerId: "", inputBatch: 1, frames: 0, ended: false };
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
        }
      }
    })().catch(() => undefined).finally(() => { view.ended = true; });
    await expect.poll(() => view.viewerId !== "" || view.ended, { timeout: 90_000, interval: 100 }).toBe(true);
    expect(view.viewerId).not.toBe("");
    await expect.poll(() => view.frames, { timeout: 60_000, interval: 100 }).toBeGreaterThan(0);
    return { view, post, close: () => abort.abort() };
  }

  run("a person takes control, clicks a button and types a word, and the page sees both", async () => {
    const { view, post, close } = await openView();
    // A failure here must not leave the browser held: the bot's test would then be refused.
    try {
      expect(await post({ type: "take" })).toEqual({ status: 200, body: { ok: true, waited: false } });
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
      await expect.poll(() => seen.includes("input:word"), { timeout: 15_000, interval: 100 }).toBe(true);
      expect(seen.filter((entry) => entry.startsWith("input:"))).toEqual(["input:w", "input:wo", "input:wor", "input:word"]);

      expect(await post({ type: "release" })).toEqual({ status: 200, body: { ok: true } });
      const refused = await post(mouse("down", PRESS));
      expect(refused.status).toBe(409);
      await expect.poll(() => /browser input: person input_mouse dropped reason=not_controlling engine=agent-browser transport=v1 session=\S+/.test(serverLog()), { timeout: 10_000, interval: 100 }).toBe(true);
      expect(seen.filter((entry) => entry.startsWith("click:"))).toEqual(["click:true"]);
    } finally {
      await post({ type: "release" }).catch(() => undefined);
      close();
    }
  }, 300_000);

  run("the bot's click and fill tools change the page, and a missing target is an error the server logs", async () => {
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
    await expect.poll(() => evidence().length, { timeout: 180_000, interval: 200 }).toBe(1);
    const results = evidence()[0].evidence.filter((entry: any) => entry.step?.server === "browser").map((entry: any) => entry.response.result);
    expect(results.map((result: any) => result.isError === true)).toEqual([false, false, false, true]);
    await expect.poll(() => seen.includes("click:true") && seen.includes("input:hello"), { timeout: 15_000, interval: 100 }).toBe(true);
    await expect.poll(() => /browser input: bot click dropped reason=target_not_found engine=agent-browser transport=tools session=\S+/.test(serverLog()), { timeout: 10_000, interval: 100 }).toBe(true);
    expect(serverLog()).not.toContain("#missing");
    expect(serverLog()).not.toContain("typed_not_landed");
  }, 300_000);
});
