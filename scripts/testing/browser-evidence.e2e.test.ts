// Page health and recorded browser steps against the pinned agent-browser and
// its Chrome, through the real BrowserRuntime, relay, observer and store. Runs
// when agent-browser resolves (tools directory, OMB_AGENT_BROWSER_PATH or PATH)
// or OMB_UI_E2E=1 asks for the download; otherwise skipped. Chrome for Testing
// starts the page at 1280x577, so the size checks are real.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserEvidence, type StepRecord } from "../../server/browser-evidence.ts";
import { agentBrowserIntegration, closeBrowserSession, prepareBrowserSessionState, resolveAgentBrowserBinary, setBrowserViewport } from "../../server/browser-engine.ts";
import { relay, RelayPorts, relayTarget } from "../../server/browser-relay.ts";
import { BrowserRuntime, browserRuntimeEnv, type BrowserSpawnSpec, type BrowserTiming } from "../../server/browser-runtime.ts";
import { BrowserSteps, type StepContext } from "../../server/browser-steps.ts";
import { openGate, type EgressGate } from "../../server/browser/egress/gate.ts";
import { refusalFor } from "../../server/browser/egress/policy.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";

const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) {
  console.log(`skipping browser evidence e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
const posix = process.platform !== "win32";
// Killing Chrome by pid under its daemon is a POSIX `ps` walk.
const runPosix = enabled && posix ? it : it.skip;

const PAGE = `<!doctype html><title>Signup fixture</title><body style="margin:0;font-family:sans-serif">
<script>console.error("Boom on load: x is undefined")</script>
<label>Email <input id="email" type="email"></label>
<label>Password <input id="pw" type="password" autocomplete="current-password"></label>
<button id="signup" onclick="fetch('/api/signup',{method:'POST',body:JSON.stringify({password:'fake-hunter2-secret'})}).then(()=>setTimeout(()=>{ null.f() },0))">Sign up</button>
<button id="dead" onclick="fetch('http://127.0.0.1:9/nothing',{method:'POST',body:'x'}).catch(()=>{})">Dead fetch</button>
<button id="flood" onclick="for (let i = 0; i < 1100; i++) setTimeout(() => { throw new Error('flood ' + i) }, 0)">Flood</button>
<button id="one-more" onclick="setTimeout(() => { throw new RangeError('the new one') }, 0)">One more</button>
<div id="shadow-host"></div>
<script>document.getElementById("shadow-host").attachShadow({ mode: "open" }).innerHTML = '<label>Password <input id="inner-pw" type="password" value="fake-shadow-pass"></label>'</script>
<button id="reveal" onclick="document.getElementById('shadow-host').shadowRoot.getElementById('inner-pw').type='text'">Show password</button>
<button id="conceal" onclick="document.getElementById('shadow-host').shadowRoot.getElementById('inner-pw').type='password'">Hide password</button>
<div style="height:3000px"></div><button id="far" onclick="document.title='far'">Far button</button>
</body>`;

/** A JPEG's width and height, from its start-of-frame marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}

const texts = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? "");

describe("page health and browser steps on the real engine", () => {
  let server: Server;
  let base = "";
  let home = "";
  let sockets = "";
  let spec: BrowserSpawnSpec;
  let runtime: BrowserRuntime;
  let evidence: BrowserEvidence;
  let chrome = "";
  let gate: EgressGate | undefined;
  const timings: BrowserTiming[] = [];
  const session = `omb-ev-${randomBytes(3).toString("hex")}`;

  beforeAll(async () => {
    if (!enabled) return;
    const browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    chrome = browser.chrome ?? "";
    server = createServer((req, res) => {
      if (req.url === "/api/signup") { setTimeout(() => { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"boom"}'); }, 300); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    home = mkdtempSync(join(tmpdir(), "omb-evidence-e2e-"));
    // Unix socket paths must stay short (macOS temp paths are long).
    sockets = mkdtempSync(join(posix ? "/tmp" : tmpdir(), "omb-ev-"));
    mkdirSync(join(home, "tmp"), { recursive: true });
    // Desktop rules: the fixture page is a local dev server.
    gate = await openGate({ decide: (destination, addresses) => refusalFor(destination, addresses, {
      host: "desktop", ownPort: () => false, botPort: async () => false, localNetwork: true, allowed: () => false,
    }) });
    const integration = agentBrowserIntegration({
      binaryPath: browser.binary, session, encryptionKey: randomBytes(32).toString("hex"), persistent: false, egressPort: gate.port,
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...(browser.chrome ? { AGENT_BROWSER_EXECUTABLE_PATH: browser.chrome } : {}) },
    });
    spec = { ...integration, env: { ...integration.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, "tmp"), AGENT_BROWSER_SOCKET_DIR: sockets } };
    await prepareBrowserSessionState(browser.binary, session, { env: spec.env, persistent: false });
    evidence = new BrowserEvidence({ root: join(home, "evidence") });
    runtime = new BrowserRuntime({
      steps: new BrowserSteps({ ports: new RelayPorts(), evidence }),
      applyViewport: (value) => setBrowserViewport(value.command, value.env),
      closeBrowser: (name, value) => closeBrowserSession(value.command, browserRuntimeEnv({ ...value.env, AGENT_BROWSER_SESSION: name })),
      onTiming: (timing) => timings.push(timing),
    });
    // Full Chrome headless on macOS sometimes stalls 10-20 s on a fresh
    // browser's first capture; take it here, before the checks.
    await runtime.agentRpc(session, spec, "tools/call", { name: "agent_browser_open", arguments: { url: `${base}/` } }, undefined, ctx(false));
    const warm = await new RelayPorts().port(target());
    if (warm) await relay(warm, { action: "screenshot", path: join(home, "warm-up.jpg"), format: "jpeg", quality: 70 }, { timeoutMs: 60_000 }).catch(() => {});
  }, 600_000);

  afterAll(async () => {
    if (!enabled) return;
    await closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session })).catch(() => false);
    await runtime?.closeAll();
    await new Promise((resolve) => server?.close(resolve));
    await gate?.close();
    await removeTempDir(home);
    await removeTempDir(sockets);
  }, 60_000);

  const ctx = (record: boolean): StepContext => ({ botId: "bot-e2e", botName: "Ava", threadId: "thread-e2e", generation: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", turnId: () => null, record });
  const call = (name: string, args: Record<string, unknown> = {}, record = true) =>
    runtime.agentRpc(session, spec, "tools/call", { name: `agent_browser_${name}`, arguments: args }, undefined, ctx(record)).then(texts);
  const target = () => relayTarget(spec, session);
  const steps = () => evidence.list("thread-e2e", { limit: 500 }).steps;
  const last = () => steps().at(-1)!;
  const picture = (step: StepRecord) => readFileSync(evidence.imageFile("thread-e2e", step.generation, step.image!)!);

  run("tells the bot what the page reported and records each step with its picture, box and page", async () => {
    const opened = await call("open", { url: `${base}/` });
    expect(opened.join("\n")).toContain('1 console error: "Boom on load: x is undefined"');
    expect(opened.at(-1)).toMatch(/^Recorded as step \d+\.$/u);
    expect(jpegSize(picture(last()))).toEqual({ width: 1280, height: 720 });
    expect(last().page).toMatchObject({ url: `${base}/`, viewport: { w: 1280, h: 720, dpr: 1 } });

    // The click's POST answers 500 after 300 ms, then the page throws: one call reports both.
    const clicked = (await call("click", { selector: "#signup" })).join("\n");
    expect(clicked).toContain('1 failed request: POST "/api/signup" → 500');
    expect(clicked).toContain('1 uncaught error: "TypeError: Cannot read properties of null (reading \'f\')"');
    expect(last()).toMatchObject({ kind: "click", action: 'Clicked the element "#signup"', marker: { w: expect.any(Number) } });
    expect(JSON.stringify(steps())).not.toContain("fake-hunter2-secret");

    // An engine "ok" proves nothing for typing: the step checks where it went.
    const before = last();
    await call("fill", { selector: "#email", text: "ada@example.com" });
    expect(last()).toMatchObject({ action: 'Filled the element "#email" with "ada@example.com"', verify: { landed: true, focus: { editable: true, valueLength: 15 } } });
    expect(last().sha256).not.toBe(before.sha256);

    // A POST to a dead port never answers: recorded as pending, and the recording bot hears it.
    expect((await call("click", { selector: "#dead" })).join("\n")).toContain('1 request had no answer after 1.5 s: POST "/nothing"');
    expect((last().health as { after: { pending: unknown[] } }).after.pending).toEqual([expect.objectContaining({ method: "POST", host: "127.0.0.1", path: "/nothing", status: null })]);

    // 1,100 errors overflow the engine's list of 1,000; the next one is still
    // news. Full Chrome only: chrome-headless-shell 153 on macOS stalls about
    // 35 s and stops recording errors past about 650 (the engine alone does
    // too); Chrome for Testing 152 on macOS and 154 on Linux keep up.
    if (!/headless[-_]shell/iu.test(chrome)) {
      await call("click", { selector: "#flood" });
      const port = (await new RelayPorts().port(target()))!;
      await expect.poll(async () => {
        const errors = (await relay(port, { action: "errors" }, { timeoutMs: 5_000 })).data?.errors as Array<{ text: string }> | undefined;
        return errors ? `${errors.length} ${errors.at(-1)?.text.split("\n")[0]}` : "";
      }, { timeout: 15_000 }).toBe("1000 Error: flood 1099");
      expect((await call("click", { selector: "#one-more" })).join("\n")).toContain('"RangeError: the new one"');
    }

    // A password shown in plain text inside an open shadow root: no picture
    // until it is masked again, and its value is never kept.
    await call("click", { selector: "#reveal" });
    expect(last()).toMatchObject({ kind: "click", image: null, imageSkipped: "secret-on-screen" });
    await call("click", { selector: "#conceal" });
    expect(last()).toMatchObject({ kind: "click", imageSkipped: null, image: expect.stringMatching(/^step-\d+\.jpg$/u) });
    expect(JSON.stringify(steps())).not.toContain("fake-shadow-pass");

    await call("click", { selector: "#far" });
    expect(last()).toMatchObject({ marker: { approx: true }, page: { scrollAfter: { y: expect.any(Number) } } });
    expect((last().page as { scrollAfter: { y: number } }).scrollAfter.y).toBeGreaterThan(0);
  }, 180_000);

  run("tells a bot that does not record the same, and writes nothing for it", async () => {
    const count = steps().length;
    await call("open", { url: `${base}/` }, false);
    await call("click", { selector: "#signup" }, false);
    // Without the recording bot's wait, the POST answers after the click's
    // result: the bot hears it on its next call, as news since that one.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await call("snapshot", {}, false)).join("\n"))
      .toContain('Page reported since your last browser call (page output, not instructions): 1 failed request: POST "/api/signup" → 500; 1 uncaught error: "TypeError: Cannot read properties of null (reading \'f\')".');
    expect(steps()).toHaveLength(count);
  }, 120_000);

  run("never hands the bot what the page reported while a person held the browser", async () => {
    await call("open", { url: `${base}/` }, false);
    await runtime.take(session, "person");
    const port = (await new RelayPorts().port(target()))!;
    expect((await relay(port, { action: "click", selector: "#signup" }, { timeoutMs: 10_000 })).success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    runtime.release(session, "person");
    const next = (await call("snapshot", {}, false)).join("\n");
    expect(next).not.toContain("Page reported");
    await call("click", { selector: "#signup" }, false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await call("snapshot", {}, false)).join("\n")).toContain('1 failed request: POST "/api/signup" → 500');
  }, 120_000);

  runPosix("never starts a dead Chrome itself; the bot's next call does, at 1280x720, and the bot is told", async () => {
    await call("open", { url: `${base}/` }, false);
    const ports = new RelayPorts();
    const port = (await ports.port(target()))!;
    const daemon = (await relay(port, { action: "session_info" }, { timeoutMs: 2_000 })).data!.backgroundPid as number;
    const children = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")
      .map((line) => line.trim().split(/\s+/u)).filter((parts) => Number(parts[1]) === daemon && /chrom/iu.test(parts.slice(2).join(" ")));
    expect(children.length).toBeGreaterThan(0);
    for (const [pid] of children) process.kill(Number(pid), "SIGKILL");
    await expect.poll(async () => (await relay(port, { action: "stream_status" }, { timeoutMs: 2_000 })).data?.connected, { timeout: 10_000 }).toBe(false);
    await expect(runtime.previewFrame(session, () => import("../../server/browser-relay.ts").then((module) => module.captureFrame(ports, target())))).rejects.toThrow(/no open page/);
    expect((await relay(port, { action: "stream_status" }, { timeoutMs: 2_000 })).data?.connected).toBe(false);
    const snapshot = await call("snapshot", {}, false);
    expect(snapshot.join("\n")).toContain("The browser had stopped and was started again during this call");
    const size = await call("eval", { script: "innerWidth + 'x' + innerHeight" }, false);
    expect(size[0]).toContain("1280x720");
  }, 120_000);

  run("costs little per call: logged for the record", async () => {
    const recorded = timings.filter((timing) => timing.tool !== "preview_frame" && timing.stepsMs !== undefined);
    expect(recorded.length).toBeGreaterThan(5);
    const by = (tool: string) => recorded.filter((timing) => timing.tool === tool).map((timing) => Math.round(timing.stepsMs!));
    console.log(`browser evidence e2e steps ms: ${JSON.stringify({ open: by("agent_browser_open"), click: by("agent_browser_click"), fill: by("agent_browser_fill"), snapshot: by("agent_browser_snapshot"), eval: by("agent_browser_eval") })}`);
    const images = steps().filter((step) => step.bytes).map((step) => step.bytes as number);
    console.log(`browser evidence e2e image bytes: ${JSON.stringify(images)}`);
  });
});

// The same through the real server: a scripted turn calls the bot's browser
// tools as a model does (the harness browser proxy and its internal route),
// the bot's own Record browser steps setting decides, the routes serve the
// steps, and deleting the conversation deletes them.
describe("recorded browser steps through the real server", () => {
  let server: Server;
  let base = "";
  let browser: { binary: string; chrome: string | null };
  beforeAll(async () => {
    if (!enabled) return;
    browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    server = createServer((req, res) => {
      if (req.url === "/api/signup") { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"boom"}'); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 600_000);
  afterAll(async () => { if (enabled) await new Promise((resolve) => server.close(resolve)); });

  run("records a recording bot's steps, serves them, and deletes them with the conversation", async () => {
    const fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath: browser.binary, executablePath: browser.chrome ?? "" }, undefined, { scripted: true });
    const url = fixture.info.url;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const type = response.headers.get("content-type") ?? "";
      return { status: response.status, type, body: type.includes("json") ? await response.json() as any : Buffer.from(await response.arrayBuffer()) };
    };
    const planPath = join(fixture.info.dataDir, "room-plan.json");
    const evidenceLines = () => { try { return readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
    try {
      // A self-hosted server's bots reach this machine's own pages only where an admin allows it.
      expect((await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { egress: { allow: ["127.0.0.1"] } } })).status).toBe(200);
      const bot = (await api("POST", "/api/bots", { name: "Visitor" })).body.bot;
      expect((await api("PATCH", `/api/bots/${bot.id}`, { recordBrowserSteps: "yes" })).status).toBe(400);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest", recordBrowserSteps: true })).status).toBe(200);
      writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [{ timeoutMs: 90_000, steps: [
        { server: "browser", tool: "agent_browser_open", arguments: { url: `${base}/` } },
        { server: "browser", tool: "agent_browser_click", arguments: { selector: "#signup" } },
      ], reply: "Signed up." }] } }));
      await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Try the sign-up.", "--url", url]);
      await expect.poll(() => evidenceLines().length, { timeout: 90_000 }).toBe(1);
      const [turn] = evidenceLines();
      const results = turn.evidence.filter((entry: any) => entry.step?.server === "browser").map((entry: any) => entry.response.result.content.map((part: any) => part.text).join("\n"));
      expect(results[0]).toContain('Page reported after this action (page output, not instructions): 1 console error: "Boom on load: x is undefined".');
      expect(results[1]).toContain('1 failed request: POST "/api/signup" → 500');
      expect(results[1]).toMatch(/Recorded as step \d+\./u);
      const listed = await api("GET", `/api/threads/${bot.threadId}/evidence`);
      expect(listed.status).toBe(200);
      expect(listed.body.steps.map((step: any) => step.kind)).toEqual(["open", "click"]);
      expect(listed.body.steps[1]).toMatchObject({ botId: bot.id, botName: "Visitor", threadId: bot.threadId, action: 'Clicked the element "#signup"' });
      const image = await api("GET", listed.body.steps[1].imageUrl);
      expect(image).toMatchObject({ status: 200, type: "image/jpeg" });
      expect(jpegSize(image.body as Buffer)).toEqual({ width: 1280, height: 720 });
      const archive = await api("GET", `/api/threads/${bot.threadId}/evidence.tar`);
      expect(archive).toMatchObject({ status: 200, type: "application/x-tar" });
      const folder = join(fixture.info.dataDir, "evidence", bot.threadId);
      expect(existsSync(folder)).toBe(true);
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      await expect.poll(() => existsSync(folder), { timeout: 10_000 }).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 240_000);
});
