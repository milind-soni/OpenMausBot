// A person watching a bot's agent-browser page in a narrow panel, against the pinned agent-browser and its Chrome:
// the page fills the panel at a desktop's width, a resize waits for the bot's running call, the bot's click lands on
// the page as it is laid out, its screenshot of the tall page comes as JPEG, and the standard page returns once nobody
// watches. Runs when agent-browser resolves (tools directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for
// the download; otherwise skipped.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentBrowserIntegration, closeBrowserSession, prepareBrowserSessionState, resolveAgentBrowserBinary, setBrowserViewport } from "../../server/browser-engine.ts";
import { BrowserLive } from "../../server/browser-live.ts";
import { BROWSER_VIEWPORT, type PageSize } from "../../server/browser-page-size.ts";
import { relay, RelayPorts, relayTarget } from "../../server/browser-relay.ts";
import { BrowserRuntime, browserRuntimeEnv, type BrowserSpawnSpec } from "../../server/browser-runtime.ts";
import { openGate, type EgressGate } from "../../server/browser/egress/gate.ts";
import { refusalFor } from "../../server/browser/egress/policy.ts";
import { SseRecorder } from "../../server/browser/viewers/testing/v1-session.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";

const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) {
  console.log(`skipping browser fill e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
const posix = process.platform !== "win32";

/** A page taller than the standard viewport, whose Low button only a tall viewport shows; a click names the page's size. */
const PAGE = `<!doctype html><title>tall</title><body style="margin:0;height:4000px">
<button id="low" style="position:absolute;left:600px;top:1950px;width:200px;height:100px" onclick="document.title = 'clicked low at ' + innerWidth + 'x' + innerHeight">Low</button>
</body>`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T> | T, check: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(value)} after ${timeoutMs} ms`);
    await sleep(100);
  }
}

function jpegSize(bytes: Buffer): PageSize | null {
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

describe("an agent-browser page a person watches in a narrow panel", () => {
  let server: Server;
  let base = "";
  let home = "";
  let sockets = "";
  let spec: BrowserSpawnSpec;
  let runtime: BrowserRuntime;
  let live: BrowserLive;
  let gate: EgressGate | undefined;
  const applied: Array<{ size: PageSize; at: number }> = [];
  const session = `omb-fill-${randomBytes(3).toString("hex")}`;

  beforeAll(async () => {
    if (!enabled) return;
    const browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    home = mkdtempSync(join(tmpdir(), "omb-fill-e2e-"));
    // Unix socket paths must stay short (macOS temp paths are long).
    sockets = mkdtempSync(join(posix ? "/tmp" : tmpdir(), "omb-fill-"));
    mkdirSync(join(home, "tmp"), { recursive: true });
    gate = await openGate({ decide: (destination, addresses) => refusalFor(destination, addresses, {
      host: "desktop", ownPort: () => false, botPort: async () => false, localNetwork: true, allowed: () => false,
    }) });
    const integration = agentBrowserIntegration({
      binaryPath: browser.binary, session, encryptionKey: randomBytes(32).toString("hex"), persistent: false, egressPort: gate.port,
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...(browser.chrome ? { AGENT_BROWSER_EXECUTABLE_PATH: browser.chrome } : {}) },
    });
    spec = { ...integration, env: { ...integration.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, "tmp"), AGENT_BROWSER_SOCKET_DIR: sockets } };
    await prepareBrowserSessionState(browser.binary, session, { env: spec.env, persistent: false });
    runtime = new BrowserRuntime({
      applyViewport: (value, size) => {
        applied.push({ size, at: Date.now() });
        return setBrowserViewport(value.command, value.env, size);
      },
      closeBrowser: (name, value) => closeBrowserSession(value.command, browserRuntimeEnv({ ...value.env, AGENT_BROWSER_SESSION: name })),
    });
    live = new BrowserLive({ runtime });
  }, 600_000);

  afterAll(async () => {
    if (!enabled) return;
    live?.closeAll();
    await closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session })).catch(() => false);
    await runtime?.closeAll();
    await new Promise((resolve) => server?.close(resolve));
    await gate?.close();
    await removeTempDir(home);
    await removeTempDir(sockets);
  }, 60_000);

  const call = (name: string, args: Record<string, unknown> = {}) =>
    runtime.agentRpc(session, spec, "tools/call", { name: `agent_browser_${name}`, arguments: args }) as Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;
  const text = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n");
  /** Read past the runtime, so it never sizes the page first. */
  const page = async <T>(script: string): Promise<T> => {
    const port = await new RelayPorts().port(relayTarget(spec, session));
    if (!port) throw new Error("the browser's daemon has no relay port");
    return (await relay(port, { action: "evaluate", script }, { timeoutMs: 20_000 })).data?.result as T;
  };
  const size = () => page<[number, number]>("[innerWidth, innerHeight]");
  const same = (expected: unknown) => (actual: unknown) => JSON.stringify(actual) === JSON.stringify(expected);

  run("fills the panel at a desktop's width, resizes only between the bot's calls, and gives the standard page back once nobody watches", async () => {
    expect(text(await call("open", { url: `${base}/` }))).toContain("Page observed after navigation.");
    expect(await size()).toEqual([BROWSER_VIEWPORT.width, BROWSER_VIEWPORT.height]);

    const view = new SseRecorder();
    await live.open({ botId: "bot-e2e", session, spec, owner: "local-owner", isCurrent: () => true, res: view.response, size: { width: 400, height: 750 } });
    const viewerId = String(view.events.find((event) => event.type === "ready")?.data.viewerId);
    await until(size, same([1280, 2400]));
    const frame = () => view.events.filter((event) => event.type === "frame").at(-1)?.data.metadata as { deviceWidth: number; deviceHeight: number } | undefined;
    await until(frame, (metadata) => metadata?.deviceWidth === 1280 && metadata.deviceHeight === 2400);

    const snapshot = text(await call("snapshot"));
    const low = /button "Low" \[ref=(e\d+)\]/u.exec(snapshot)?.[1];
    expect(low, snapshot).toBeTruthy();
    expect((await call("click", { selector: `@${low}` })).isError).not.toBe(true);
    expect(await page<string>("document.title")).toBe("clicked low at 1280x2400");

    const shot = await call("screenshot");
    const image = shot.content.find((part) => part.type === "image");
    expect(image?.mimeType).toBe("image/jpeg");
    expect(jpegSize(Buffer.from(image!.data!, "base64"))).toEqual({ width: 1280, height: 2400 });

    // The bot's call holds the browser: the person's resize lands only after it.
    const waited = call("wait_ms", { ms: 1_500 }).then(() => Date.now());
    await sleep(300);
    expect(await live.action({ viewerId, botId: "bot-e2e", owner: "local-owner", body: { type: "resize", width: 900, height: 700 } })).toEqual({ ok: true });
    const ended = await waited;
    await until(size, same([1280, 996]));
    const resized = applied.find((entry) => entry.size.height === 996)!;
    expect(resized.at).toBeGreaterThanOrEqual(ended - 50);

    view.destroy();
    await sleep(200);
    expect(await size()).toEqual([1280, 996]);
    expect((await call("get_url")).isError).not.toBe(true);
    expect(await size()).toEqual([BROWSER_VIEWPORT.width, BROWSER_VIEWPORT.height]);
    expect(applied.at(-1)?.size).toEqual(BROWSER_VIEWPORT);
  }, 300_000);
});
