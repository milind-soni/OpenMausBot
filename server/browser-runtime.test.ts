import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addHeldSecretScrubber, HELD_SECRET_MASK } from "../shared/redact.ts";
import { BROWSER_VIEWPORT } from "./browser-page-size.ts";
import { BROWSER_CALL_DEFAULTS, BROWSER_HOVER_TOOL, BROWSER_RESTART_TOOL, BROWSER_UPLOAD_TOOL, BrowserRuntime, TransportError, browserRuntimeEnv, formatBrowserTiming, type BrowserSpawnSpec, type BrowserTiming } from "./browser-runtime.ts";
import { HARNESS_CALL_BUDGET_MS, HARNESS_PROXY_TIMEOUT_MS } from "./harness-budget.ts";
import { RelayPorts } from "./browser-relay.ts";
import { BrowserSteps, type StepCall, type StepContext } from "./browser-steps.ts";
import { FakeRelay } from "./testing/fake-relay.ts";

const runtimes: BrowserRuntime[] = [];
function runtime(options: ConstructorParameters<typeof BrowserRuntime>[0] = {}) {
  const value = new BrowserRuntime({ requestTimeoutMs: 1_000, takeoverTimeoutMs: 100, idleMs: 1_000, ...options });
  runtimes.push(value);
  return value;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((value) => value.closeAll())); });

describe("browser takeover gate", () => {
  it("immediately blocks shared-session reads and writes, while unrelated sessions work", async () => {
    const value = runtime();
    const action = deferred<string>();
    const pending = value.withAgentAction("shared-profile", () => action.promise);
    const observed = expect(pending).rejects.toThrow(/paused/);
    const taking = value.take("shared-profile", "person");
    expect(value.heldBy("shared-profile")).toBe("person");
    expect(value.canControl("shared-profile", "person")).toBe(false);
    const screenshot = vi.fn();
    await expect(value.withAgentAction("shared-profile", screenshot)).rejects.toThrow(/paused/);
    expect(screenshot).not.toHaveBeenCalled();
    await expect(value.withAgentAction("different-profile", async () => 42)).resolves.toBe(42);
    action.resolve("old screenshot never reaches bot");
    await observed;
    await taking;
    expect(value.canControl("shared-profile", "person")).toBe(true);
    expect(value.canControl("shared-profile", "other-person")).toBe(false);
  });

  it("retains a non-controllable hold when draining times out, even if the action finishes later", async () => {
    const value = runtime({ takeoverTimeoutMs: 20 });
    const action = deferred();
    const pending = value.withAgentAction("s", () => action.promise);
    const observed = expect(pending).rejects.toThrow(/paused/);
    await expect(value.take("s", "owner")).rejects.toThrow(/still finishing/);
    expect(value.heldBy("s")).toBe("owner");
    action.resolve();
    await observed;
    expect(value.canControl("s", "owner")).toBe(false);
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("only the owner can release, and pending human actions drain before agents resume", async () => {
    const value = runtime();
    await value.take("s", "owner");
    await expect(value.take("s", "other")).rejects.toThrow(/Another person/);
    value.release("s", "other");
    expect(value.heldBy("s")).toBe("owner");
    const typed = deferred();
    const human = value.withHumanAction("s", "owner", () => typed.promise);
    value.release("s", "owner");
    expect(value.canControl("s", "owner")).toBe(false);
    expect(value.heldBy("s")).toBe("owner");
    await expect(value.withAgentAction("s", async () => "snapshot")).rejects.toThrow(/paused/);
    await expect(value.withHumanAction("s", "owner", async () => "click")).rejects.toThrow(/Take control/);
    typed.resolve();
    await human;
    expect(value.heldBy("s")).toBeNull();
    await expect(value.withAgentAction("s", async () => "safe screenshot")).resolves.toBe("safe screenshot");
  });

  it("keeps the person's input after a take behind a preview frame, and says when an interruption needs a restart", async () => {
    const value = runtime();
    await expect(value.take("s", "owner")).resolves.toBe(false);
    value.release("s", "owner");
    // A preview frame holds the gate but sends no command that moves the page.
    const frame = deferred();
    const pending = value.previewFrame("s", () => frame.promise);
    const observed = expect(pending).rejects.toThrow(/paused/);
    const taking = value.take("s", "owner");
    frame.resolve(); await observed;
    await expect(taking).resolves.toBe(false);
    expect(value.interrupted("s")).toBe(false);
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    expect(value.interrupted("s")).toBe(true);
    await value.close("s");
    expect(value.interrupted("s")).toBe(false);
  });

  it("keeps the browser usable after an action the engine answered as failed", async () => {
    const value = runtime();
    await expect(value.take("s", "owner")).resolves.toBe(false);
    const answered = Object.assign(new Error("This page could not be opened."), { settled: true });
    await expect(value.withHumanAction("s", "owner", async () => { throw answered; })).rejects.toBe(answered);
    expect(value.interrupted("s")).toBe(false);
    expect(value.canControl("s", "owner")).toBe(true);
    await expect(value.withHumanAction("s", "owner", async () => "next page")).resolves.toBe("next page");
  });

  it("release cancels an in-flight take and does not grant control afterwards", async () => {
    const value = runtime();
    const action = deferred();
    const pending = value.withAgentAction("s", () => action.promise);
    const taking = value.take("s", "owner");
    const observed = expect(taking).rejects.toThrow(/cancelled/);
    value.release("s", "owner");
    await observed;
    action.resolve();
    await pending;
    expect(value.canControl("s", "owner")).toBe(false);
  });

  it("failed actions release their counters and closing a transport does not release the owner", async () => {
    const value = runtime();
    await expect(value.withAgentAction("s", async () => { throw new Error("bad action"); })).rejects.toThrow("bad action");
    await value.take("s", "owner");
    await value.close("s");
    expect(value.heldBy("s")).toBe("owner");
    expect(value.canControl("s", "owner")).toBe(false);
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("does not resume agents after an interrupted human command until browser recovery", async () => {
    const value = runtime();
    await value.take("s", "owner");
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "snapshot")).rejects.toThrow(/Restart/);
    await expect(value.take("s", "owner")).rejects.toThrow(/may still be running/);
    await value.close("s");
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "recovered")).resolves.toBe("recovered");
  });

  it("requires recovery for abandoned pressed input, but ignores stale or unrelated owners", async () => {
    const value = runtime();
    await value.take("s", "owner");
    value.abandonHumanInput("s", "other");
    expect(value.canControl("s", "owner")).toBe(true);
    value.abandonHumanInput("s", "owner");
    expect(value.canControl("s", "owner")).toBe(false);
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "click with stuck modifier")).rejects.toThrow(/Restart/);
    await value.restart("s", "new-viewer", async () => {});
    value.abandonHumanInput("s", "owner");
    await expect(value.withAgentAction("s", async () => "fresh input state")).resolves.toBe("fresh input state");
  });

  it("restarts exclusively and retains an uncertain hold if native close fails", async () => {
    const value = runtime();
    await expect(value.restart("s", "recovery", async () => { throw new Error("close timed out"); })).rejects.toThrow(/timed out/);
    expect(value.heldBy("s")).toBe("recovery");
    expect(value.canControl("s", "recovery")).toBe(false);
    const closing = deferred();
    const restart = value.restart("s", "recovery", () => closing.promise);
    await expect(value.withAgentAction("s", async () => "click")).rejects.toThrow(/paused/);
    await expect(value.withHumanAction("s", "recovery", async () => "click")).rejects.toThrow(/Take control/);
    closing.resolve();
    await restart;
    expect(value.heldBy("s")).toBeNull();
    await expect(value.withAgentAction("s", async () => "recovered")).resolves.toBe("recovered");
  });

  it("skips a preview frame while an agent action runs, so frames cannot queue behind it", async () => {
    const value = runtime();
    const busy = deferred();
    const action = value.withAgentAction("s", () => busy.promise);
    const capture = vi.fn(async () => "frame");
    await expect(value.previewFrame("s", capture)).rejects.toThrow(/busy/);
    expect(capture).not.toHaveBeenCalled();
    busy.resolve();
    await action;
    await expect(value.previewFrame("s", capture)).resolves.toBe("frame");
  });

  it("will not restart active actions or another person's held browser", async () => {
    const value = runtime();
    const nativeClose = vi.fn(async () => {});
    const busy = deferred();
    const agent = value.withAgentAction("s", () => busy.promise);
    await expect(value.restart("s", "recovery", nativeClose)).rejects.toThrow(/busy/);
    busy.resolve();
    await agent;
    await value.take("s", "other");
    await expect(value.restart("s", "recovery", nativeClose)).rejects.toThrow(/Another person/);
    expect(nativeClose).not.toHaveBeenCalled();
  });
});

const FAKE_MCP = `
const lines = require('node:readline').createInterface({input:process.stdin});
const fs = require('node:fs');
let initialized = false;
let rpcTimeoutCalls = 0;
let pageText = 'Ready';
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') { initialized = true; return; }
  let result;
  if (m.method === 'tools/call' && process.env.CALL_LOG) fs.appendFileSync(process.env.CALL_LOG, m.params.name + '\\n');
  if (m.method === 'initialize') result = { protocolVersion:'2024-11-05',capabilities:{tools:{}} };
  else if (m.method === 'tools/list') result = { tools:[{name:'echo'}],pid:process.pid,initialized };
  // BUSY_FILE models agent-browser's one daemon per session, shared by every
  // MCP process: a hung command keeps it busy, and a read waits behind it.
  else if (m.params.name === 'hang') { if (process.env.BUSY_FILE) fs.writeFileSync(process.env.BUSY_FILE, 'busy'); return; }
  else if (m.params.name === 'agent_browser_get_url' && process.env.NO_URL === '1') result = { isError:true, content:[] };
  else if (m.params.name === 'agent_browser_get_url') {
    const answer = () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'http://fixture.test/after'}]}})+'\\n');
    const wait = () => process.env.BUSY_FILE && fs.existsSync(process.env.BUSY_FILE) ? setTimeout(wait, 20) : answer();
    return wait();
  }
  else if (m.params.name === 'crash') process.exit(23);
  else if (m.params.name === 'oversized') { process.stdout.write('x'.repeat(16777217)); return; }
  else if (m.params.name === 'bulky') result = { content:[{type:'text',text:'x'.repeat(50000)},{type:'image',data:'AAAA',mimeType:'image/png'}], structuredContent:{ huge: 'y'.repeat(200000) } };
  else if (m.params.name === 'rpc-error') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'Expected refusal'}})+'\\n'); return; }
  else if (m.params.name === 'rpc-timeout') { rpcTimeoutCalls += 1; if (rpcTimeoutCalls === 1) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'request timed out'}})+'\\n'); return; } result = { content:[{type:'text',text:'engine answered a repeat rpc-timeout call'}] }; }
  else if (m.params.name === 'agent_browser_open' && m.params.arguments.url === 'https://refused.test') result = { isError:true, content:[{type:'text',text:'Navigation refused'}] };
  else if (m.params.name === 'agent_browser_open' && process.env.OPEN_LAUNCHED === '1') result = { content:[{type:'text',text:'Opened'}], structuredContent:{ response:{ data:{ lifecycle:{ launched:true, relaunchedBrowser:false } } } } };
  else if (m.params.name === 'agent_browser_snapshot' && process.env.REJECT_VERIFICATION === '1') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'Snapshot refused'}})+'\\n'); return; }
  else if (m.params.name === 'agent_browser_snapshot' && process.env.HANG_VERIFICATION === '1') return;
  else if (m.params.name === 'agent_browser_snapshot' && process.env.EMPTY_VERIFICATION === '1') result = { content:[] };
  else if (m.params.name === 'agent_browser_snapshot' && process.env.FAIL_VERIFICATION === '1') result = { isError:true, content:[{type:'text',text:'Snapshot unavailable'}] };
  // LEAK: a page that shows a filled password back, in every kind of result.
  else if (process.env.LEAK && m.params.name !== 'agent_browser_get_url') result = { content:[{type:'text',text:'page says ' + process.env.LEAK},{type:'image',data:'AAAA',mimeType:'image/png'}], structuredContent:{ value: process.env.LEAK } };
  else if (m.params.name === 'agent_browser_eval' && process.env.FAIL_EVAL === '1') result = { isError:true, content:[{type:'text',text:'Evaluation failed'}] };
  else if (m.params.name === 'agent_browser_eval') result = { content:[{type:'text',text:JSON.stringify(JSON.stringify({ url:'http://fixture.test/', title:'Fixture', text:pageText + '\\nSay hello' }))}] };
  else if (m.params.name === 'agent_browser_click' && m.params.arguments.selector === '#missing') result = { isError:true, content:[{type:'text',text:'Element not found: #missing'}] };
  else if (m.params.name === 'agent_browser_click') { pageText = 'Hello, Ada'; result = { content:[{type:'text',text:JSON.stringify({ data:{ clicked:m.params.arguments.selector, lifecycle:{ launched:false, relaunchedBrowser:false, launchHash:1 } }, error:null, success:true }, null, 2)}] }; }
  else result = { content:[{type:'text',text:JSON.stringify(m.params)}],pid:process.pid };
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`;
const spec = (): BrowserSpawnSpec => ({ command: process.execPath, args: ["-e", FAKE_MCP], env: { PATH: process.env.PATH } });
/** A fake engine whose daemon is shared by every MCP process (BUSY_FILE),
 * with a log of the commands that reached it (CALL_LOG). */
function daemonSpec(): { spec: BrowserSpawnSpec; busy: string; calls: () => string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "omb-daemon-"));
  const busy = join(dir, "busy"), log = join(dir, "calls");
  const value = spec();
  value.env.BUSY_FILE = busy;
  value.env.CALL_LOG = log;
  return {
    spec: value, busy,
    calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("server-owned browser MCP runtime", () => {
  it("never lets agent_browser_read fetch an address itself, around the browser and its egress gate", async () => {
    const value = runtime();
    const daemon = spec();
    const refused = await value.agentRpc("reader", daemon, "tools/call", { name: "agent_browser_read", arguments: { url: "http://127.0.0.1:8799/api/config" } }) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Open the address with agent_browser_open first/);
    const reads = await value.agentRpc("reader", daemon, "tools/call", { name: "agent_browser_read", arguments: {} }) as { isError?: boolean };
    expect(reads.isError).not.toBe(true);
  });

  it("hands no held secret back to the bot: snapshot, eval, page text, console and network results are all scrubbed", async () => {
    const leaked = "fake-filled-Passw0rd";
    // The default scrubber is the server's registry (shared/redact.ts), as in production.
    const remove = addHeldSecretScrubber((text) => text.split(leaked).join(HELD_SECRET_MASK));
    try {
      const value = runtime();
      const leaking = spec();
      leaking.env.LEAK = leaked;
      for (const name of ["agent_browser_snapshot", "agent_browser_eval", "agent_browser_read", "agent_browser_get_text", "agent_browser_console", "agent_browser_network_requests"]) {
        const result = await value.agentRpc("leaky", leaking, "tools/call", { name, arguments: {} }) as { content: Array<{ type: string; text?: string; data?: string }> };
        expect(JSON.stringify(result), name).not.toContain(leaked);
        expect(result.content[0]!.text, name).toBe(`page says ${HELD_SECRET_MASK}`);
        expect(result.content[1], name).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
      }
    } finally { remove(); }
  });

  it("captures nothing of the page while a person holds it to sign in: no screenshot, snapshot or preview frame", async () => {
    const value = runtime();
    const daemon = daemonSpec();
    try {
      await value.agentRpc("signin", daemon.spec, "tools/call", { name: "agent_browser_get_url", arguments: {} });
      await value.take("signin", "person");
      for (const name of ["agent_browser_screenshot", "agent_browser_snapshot", "agent_browser_get_text"]) {
        await expect(value.agentRpc("signin", daemon.spec, "tools/call", { name, arguments: {} })).rejects.toThrow(/paused while a person controls this browser/);
      }
      const capture = vi.fn(async () => "frame");
      await expect(value.previewFrame("signin", capture)).rejects.toThrow(/paused/);
      expect(capture).not.toHaveBeenCalled();
      expect(daemon.calls()).toEqual(["agent_browser_get_url"]);
      value.release("signin", "person");
      await expect(value.previewFrame("signin", capture)).resolves.toBe("frame");
    } finally { daemon.cleanup(); }
  });

  it("does not turn a failed navigation or failed observation into success", async () => {
    const value = runtime();
    await expect(value.agentRpc("refused", spec(), "tools/call", {
      name: "agent_browser_open", arguments: { url: "https://refused.test" },
    })).resolves.toEqual({ isError: true, content: [{ type: "text", text: "Navigation refused" }] });
    const failing = spec();
    failing.env.FAIL_VERIFICATION = "1";
    const result = await value.agentRpc("unverified", failing, "tools/call", {
      name: "agent_browser_open", arguments: { url: "https://example.com" },
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[1].text).toContain("verification failed");
    expect(result.content[2].text).toBe("Snapshot unavailable");
  });
  it("preserves navigation when its observation rejects at the RPC level", async () => {
    const value = runtime(), failing = spec();
    failing.env.REJECT_VERIFICATION = "1";
    const result = await value.agentRpc("rejected-snapshot", failing, "tools/call", {
      name: "agent_browser_open", arguments: { url: "https://example.com" },
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).name).toBe("agent_browser_open");
    expect(result.content[1].text).toContain("verification failed");
    await expect(value.withAgentAction("rejected-snapshot", async () => "available")).resolves.toBe("available");
  });
  it("keeps transport uncertainty when post-navigation observation times out", async () => {
    const value = runtime({ requestTimeoutMs: 1_000 }), failing = spec();
    failing.env.HANG_VERIFICATION = "1";
    await expect(value.agentRpc("hung-snapshot", failing, "tools/call", {
      name: "agent_browser_open", arguments: { url: "https://example.com" },
    })).resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not answer this agent_browser_open call") }] });
    await expect(value.withAgentAction("hung-snapshot", async () => "no")).rejects.toThrow(/Restart/);
  });
  it("does not claim page verification when the snapshot is empty", async () => {
    const empty = spec();
    empty.env.EMPTY_VERIFICATION = "1";
    const result = await runtime().agentRpc("empty-snapshot", empty, "tools/call", {
      name: "agent_browser_open", arguments: { url: "https://example.com" },
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[1].text).toContain("verification failed");
  });
  it("observes the same page after navigation without repeating the navigation", async () => {
    const value = runtime();
    const result = await value.agentRpc("verified-open", spec(), "tools/call", {
      name: "agent_browser_open", arguments: { url: "https://example.com", session: "wrong-session" },
    }) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toEqual({ name: "agent_browser_open", arguments: { url: "https://example.com" } });
    expect(result.content[1].text).toContain("sign-in");
    expect(result.content[1].text).toContain("Its refs are current");
    expect(JSON.parse(result.content[2].text)).toEqual({ name: "agent_browser_snapshot", arguments: { compact: true } });
  });
  it("says what an action changed on the page, read with eval so the model's refs stay valid", async () => {
    const result = await runtime().agentRpc("act", spec(), "tools/call", {
      name: "agent_browser_click", arguments: { selector: "@e5" },
    }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ data: { clicked: "@e5" }, error: null, success: true });
    expect(result.content[1].text).toBe('Text that appeared on the page: "Hello, Ada". Text that disappeared: "Ready".');
  });
  it("still returns the action when reading the page fails, and does not read after a refused action", async () => {
    const failing = spec();
    failing.env.FAIL_EVAL = "1";
    const unread = await runtime().agentRpc("unread", failing, "tools/call", {
      name: "agent_browser_click", arguments: { selector: "@e5" },
    }) as { content: Array<{ text: string }> };
    expect(unread.content).toHaveLength(1);
    expect(JSON.parse(unread.content[0].text).data).toEqual({ clicked: "@e5" });
    const refused = await runtime().agentRpc("refused-action", spec(), "tools/call", {
      name: "agent_browser_click", arguments: { selector: "#missing" },
    }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused).toEqual({ isError: true, content: [{ type: "text", text: "Element not found: #missing" }] });
  });
  it("inherits only host plumbing and explicit engine settings", () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit");
    try {
      const env = browserRuntimeEnv({ HOME: "/isolated/browser-home", AGENT_BROWSER_SESSION: "fixture" });
      expect(env.HOME).toBe("/isolated/browser-home");
      expect(env.AGENT_BROWSER_SESSION).toBe("fixture");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it("rechecks a revoked capability after initialization and before forwarding", async () => {
    const value = runtime();
    let valid = true;
    const check = () => { if (!valid) throw new Error("capability revoked"); };
    const pending = value.agentRpc("s", spec(), "tools/call", { name: "crash" }, check);
    valid = false;
    await expect(pending).rejects.toThrow(/revoked/);
    await expect(value.agentRpc("s", spec(), "tools/list", {})).resolves.toMatchObject({ initialized: true });
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });
  it("says a take waited only for a bot command the engine received", async () => {
    const value = runtime({ takeoverTimeoutMs: 5_000 });
    const daemon = daemonSpec();
    try {
      // Refused: the take lands after the call entered the gate, before dispatch.
      let taking: Promise<boolean> | undefined;
      const refused = value.agentRpc("s", daemon.spec, "tools/call", { name: "agent_browser_fill", arguments: { selector: "@e3", text: "ada" } },
        () => { taking ??= value.take("s", "owner"); });
      await expect(refused).rejects.toThrow(/paused/);
      await expect(taking).resolves.toBe(false);
      expect(daemon.calls()).toEqual([]);
      value.release("s", "owner");
      // Received: the engine is still running the command when the take lands.
      writeFileSync(daemon.busy, "busy");
      const running = value.agentRpc("s", daemon.spec, "tools/call", { name: "agent_browser_get_url" });
      const discarded = expect(running).rejects.toThrow(/paused/);
      await vi.waitFor(() => expect(daemon.calls()).toEqual(["agent_browser_get_url"]));
      const waited = value.take("s", "owner");
      rmSync(daemon.busy);
      await discarded;
      await expect(waited).resolves.toBe(true);
    } finally {
      daemon.cleanup();
    }
  });
  it("does not assume an MCP timeout stopped an accepted daemon action", async () => {
    // The real daemon detaches from its MCP parent, so transport exit is no proof a navigation or submission stopped.
    const value = runtime({ requestTimeoutMs: 2_000, recoveryCheckMs: 1_500 });
    const daemon = daemonSpec();
    try {
      await expect(value.agentRpc("s", daemon.spec, "tools/list", {})).resolves.toMatchObject({ initialized: true });
      const lost = await value.agentRpc("s", daemon.spec, "tools/call", { name: "hang" }) as { isError: boolean; content: Array<{ text: string }> };
      expect(lost.isError).toBe(true);
      expect(lost.content[0].text).toContain("did not answer this hang call");
      expect(lost.content[0].text).toContain("may already have taken effect");
      expect(value.interrupted("s")).toBe(true);
      await expect(value.take("s", "owner")).rejects.toThrow(/Restart/);
      value.release("s", "owner");
      const busy = await Promise.all([1, 2].map(() => value.agentRpc("s", daemon.spec, "tools/call", { name: "echo" }))) as Array<{ isError: boolean; content: Array<{ text: string }> }>;
      for (const result of busy) {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("still busy with an earlier hang call");
      }
      expect(daemon.calls()).toEqual(["hang", "agent_browser_get_url"]);
      expect(value.interrupted("s")).toBe(true);
      rmSync(daemon.busy);
      const recovered = await value.agentRpc("s", daemon.spec, "tools/call", { name: "echo" }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(recovered.isError).toBeUndefined();
      expect(recovered.content[0].text).toContain("has ended, and it may have taken effect");
      expect(recovered.content[0].text).toContain("This call did not run");
      expect(recovered.content[0].text).toContain("http://fixture.test/after");
      expect(value.interrupted("s")).toBe(false);
      expect(daemon.calls().filter((name) => name !== "agent_browser_get_url")).toEqual(["hang"]);
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name: "echo", arguments: { text: "back" } }))
        .resolves.toMatchObject({ content: [{ text: expect.stringContaining("back") }] });
      await value.take("s", "owner");
      expect(value.canControl("s", "owner")).toBe(true);
    } finally {
      await value.closeAll();
      daemon.cleanup();
    }
  });

  it("does not let an engine check clear uncertainty a person left behind", async () => {
    const value = runtime({ recoveryCheckMs: 1_000 });
    const daemon = daemonSpec();
    try {
      await value.agentRpc("s", daemon.spec, "tools/list", {});
      await value.take("s", "owner");
      value.abandonHumanInput("s", "owner");
      value.release("s", "owner");
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name: "echo" }))
        .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Browser panel/) }] });
      expect(daemon.calls()).toEqual([]);
      expect(value.interrupted("s")).toBe(true);
    } finally {
      await value.closeAll();
      daemon.cleanup();
    }
  });

  it("surfaces an engine-reported JSON-RPC timeout instead of retrying it", async () => {
    // Only a TransportError timeout may be retried (its timer killed that child); this engine answers "request timed out" over a live transport.
    const value = runtime();
    // The fixture times out only the first rpc-timeout call, so a retry would resolve: the rejection proves no retry happened.
    const failure = value.agentRpc("s", spec(), "tools/call", { name: "rpc-timeout" });
    await expect(failure).rejects.toThrow(/request timed out/);
    await expect(failure).rejects.not.toBeInstanceOf(TransportError);
  });

  it("returns a stuck-engine tool error after a human timeout, then the same session works after Restart", async () => {
    const value = runtime();
    await value.agentRpc("s", spec(), "tools/list", {});
    await value.take("s", "owner");
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    value.release("s", "owner");
    const refused = await value.agentRpc("s", spec(), "tools/call", { name: "echo" }) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text).toMatch(/Browser panel/);
    expect(refused.content?.[0]?.text).not.toMatch(/disconnected/i);
    const listed = await value.agentRpc("s", spec(), "tools/list", {}) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toContain("restart_browser");
    await value.restart("s", "owner", async () => {});
    expect(value.interrupted("s")).toBe(false);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "back" } }))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("The person restarted your browser") }, { text: expect.stringContaining("back") }] });
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "again" } }))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("again") }] });
  });

  it("still refuses an agent after a human's own interrupted command, browser alive", async () => {
    const value = runtime();
    await value.agentRpc("s", spec(), "tools/list", {});
    await value.take("s", "owner");
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "snapshot")).rejects.toThrow(/Restart/);
  });

  it("initializes once, reuses its own session client, and supports concurrent ids", async () => {
    const value = runtime();
    const list = await value.agentRpc("one", spec(), "tools/list", {}) as { pid: number; initialized: boolean };
    expect(list.initialized).toBe(true);
    const responses = await Promise.all(["first", "second"].map((text) => value.agentRpc("one", spec(), "tools/call", { name: "echo", arguments: { text } }))) as Array<{ pid: number; content: Array<{ text: string }> }>;
    expect(responses.map((r) => r.pid)).toEqual([list.pid, list.pid]);
    expect(responses[0].content[0].text).toContain("first");
    expect(responses[1].content[0].text).toContain("second");
    const other = await value.agentRpc("two", spec(), "tools/list", {}) as { pid: number };
    expect(other.pid).not.toBe(list.pid);
    await value.take("one", "owner");
    await expect(value.agentRpc("one", spec(), "tools/call", { name: "echo" })).rejects.toThrow(/paused/);
    await expect(value.agentRpc("one", spec(), "tools/list", {})).resolves.toMatchObject({ tools: [{ name: "echo" }, { name: BROWSER_UPLOAD_TOOL }, { name: BROWSER_HOVER_TOOL }, { name: "restart_browser" }] });
  });

  it("runs upload and hover through the daemon's relay, with only their own fields", async () => {
    const commands: Array<{ session: string; command: Record<string, unknown> }> = [];
    const value = runtime({ relayCommand: async (_spec, session, command) => {
      commands.push({ session, command });
      return { success: true, data: { selector: "#cv", uploaded: 1, lifecycle: { launched: false, relaunchedBrowser: false } } };
    } });
    const result = await value.agentRpc("s", spec(), "tools/call", {
      name: BROWSER_UPLOAD_TOOL, arguments: { selector: "#cv", files: ["/files/cv.pdf"], session: "another-bot", extraArgs: ["--headed"] },
    }) as { isError?: boolean; content: Array<{ text: string }> };
    await value.agentRpc("s", spec(), "tools/call", { name: BROWSER_HOVER_TOOL, arguments: { selector: "@e4", files: ["/files/cv.pdf"] } });
    expect(commands).toEqual([
      { session: "s", command: { action: "upload", selector: "#cv", files: ["/files/cv.pdf"] } },
      { session: "s", command: { action: "hover", selector: "@e4" } },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"uploaded":1');
    expect(result.content[0].text).not.toContain("lifecycle");
  });

  it("answers a refused relay command as a tool error, and a silent one as a lost call", async () => {
    const refused = runtime({ relayCommand: async () => ({ success: false, data: null, error: "Element not found: #cv" }) });
    await expect(refused.agentRpc("s", spec(), "tools/call", { name: BROWSER_UPLOAD_TOOL, arguments: { selector: "#cv", files: ["/f"] } }))
      .resolves.toMatchObject({ isError: true, content: [{ text: "Element not found: #cv" }] });
    const silent = runtime({ relayCommand: async () => { throw new TransportError("The browser did not answer in time."); } });
    await expect(silent.agentRpc("t", spec(), "tools/call", { name: BROWSER_HOVER_TOOL, arguments: { selector: "#menu" } }))
      .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/did not answer this agent_browser_hover call/) }] });
    expect(silent.interrupted("t")).toBe(true);
  });

  it("refuses upload and hover while a person controls the browser", async () => {
    const relayCommand = vi.fn(async () => ({ success: true, data: {} }));
    const value = runtime({ relayCommand });
    await value.agentRpc("s", spec(), "tools/list", {});
    await value.take("s", "owner");
    await expect(value.agentRpc("s", spec(), "tools/call", { name: BROWSER_HOVER_TOOL, arguments: { selector: "#menu" } })).rejects.toThrow(/paused/);
    expect(relayCommand).not.toHaveBeenCalled();
  });

  it("lets the agent restart an interrupted browser itself, then resume", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser, recoveryCheckMs: 300 });
    const daemon = daemonSpec();
    writeFileSync(daemon.busy, "busy"); // the engine never answers again
    const spec = () => daemon.spec;
    try {
      await value.agentRpc("s", spec(), "tools/list", {});
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "crash" })).resolves.toMatchObject({ isError: true });
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/restart_browser/) }],
      });
      const listed = await value.agentRpc("s", spec(), "tools/list", {}) as { tools: Array<{ name: string }> };
      expect(listed.tools.map((tool) => tool.name)).toEqual(["echo", BROWSER_UPLOAD_TOOL, BROWSER_HOVER_TOOL, "restart_browser"]);
      const check = vi.fn();
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "restart_browser", arguments: {} }, check))
        .resolves.toMatchObject({ content: [{ text: expect.stringContaining("Browser restarted") }] });
      expect(closeBrowser).toHaveBeenCalledWith("s", expect.objectContaining({ command: process.execPath }));
      expect(check).toHaveBeenCalledTimes(2);
      expect(value.heldBy("s")).toBeNull();
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "back" } }))
        .resolves.toMatchObject({ content: [{ text: expect.stringContaining("back") }] });
    } finally {
      daemon.cleanup();
    }
  });

  it("stays uncertain without holding the browser when the agent's restart cannot close it", async () => {
    const value = runtime({ closeBrowser: async () => false });
    await value.agentRpc("s", spec(), "tools/list", {});
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "crash" })).resolves.toMatchObject({ isError: true });
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "restart_browser" })).rejects.toThrow(/could not be closed/);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/Restart/) }],
    });
    expect(value.heldBy("s")).toBeNull();
    await value.restart("s", "person", async () => {});
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toBeTruthy();
  });

  it("closes a browser that sat unused, keeps its sign-ins, and tells the bot on its next call", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "first" } });
    expect(await value.closeIfIdle("s", 60_000)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await value.closeIfIdle("s", 20)).toBe(true);
    expect(closeBrowser).toHaveBeenCalledWith("s", expect.objectContaining({ command: process.execPath }));
    const next = await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "again" } }) as { content: Array<{ text: string }> };
    expect(next.content[0].text).toMatch(/sat unused and was closed.*saved sign-ins are kept/);
    expect(next.content[1].text).toContain("again");
    const after = await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "third" } }) as { content: Array<{ text: string }> };
    expect(after.content.map((part) => part.text).join("\n")).not.toMatch(/sat unused/);
  });

  it("tells a bot whose temporary browser closed while idle that its sign-ins went with it", async () => {
    const value = runtime({ closeBrowser: async () => true });
    const temporary = { ...spec(), env: { ...spec().env, AGENT_BROWSER_RESTORE_SAVE: "never" } };
    await value.agentRpc("t", temporary, "tools/call", { name: "echo" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await value.closeIfIdle("t", 10)).toBe(true);
    const next = await value.agentRpc("t", temporary, "tools/call", { name: "echo" }) as { content: Array<{ text: string }> };
    expect(next.content[0].text).toMatch(/sat unused and was closed.*temporary browser, so its sign-ins are gone too/);
    expect(next.content[0].text).not.toMatch(/are kept/);
  });

  it("never closes a browser in use: a bot's call, a person's hold or input", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    await value.agentRpc("s", spec(), "tools/list", {});
    const idle = async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return value.closeIfIdle("s", 10); };
    await new Promise((resolve) => setTimeout(resolve, 15));
    const listing = value.agentRpc("s", spec(), "tools/list", {});
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    await expect(listing).resolves.toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: "echo" })]) });
    const action = deferred();
    const agent = value.withAgentAction("s", () => action.promise);
    expect(await idle()).toBe(false);
    action.resolve();
    await agent;
    await value.take("s", "person");
    expect(await idle()).toBe(false);
    const typed = deferred();
    const human = value.withHumanAction("s", "person", () => typed.promise);
    value.release("s", "person");
    expect(await idle()).toBe(false);
    typed.resolve();
    await human;
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(await idle()).toBe(true);
  });

  it("closes a browser people only watch once it sat unused since the view opened, telling its views first, and never the person's own Chrome", async () => {
    const order: string[] = [];
    const closeBrowser = vi.fn(async (session: string) => { order.push(`close ${session}`); return true; });
    const value = runtime({ closeBrowser });
    value.onIdleClose((session) => order.push(`views ${session}`));
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const unwatch = value.watch("s", spec());
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await value.closeIfIdle("s", 10)).toBe(true);
    expect(order).toEqual(["views s", "close s"]);
    unwatch();
    const mine = { ...spec(), env: { ...spec().env, AGENT_BROWSER_CDP: "9333" } };
    await value.agentRpc("mine", mine, "tools/call", { name: "echo" });
    const unwatchMine = value.watch("mine", mine);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await value.closeIfIdle("mine", 10, mine)).toBe(false);
    unwatchMine();
    expect(order).toEqual(["views s", "close s"]);
  });

  it("makes a call that arrives while its idle browser closes wait, then open it again", async () => {
    const closing = deferred<boolean>();
    const value = runtime({ closeBrowser: () => closing.promise });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const idle = value.closeIfIdle("s", 10);
    let answered = false;
    const call = value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "late" } }).then((result) => { answered = true; return result as { content: Array<{ text: string }> }; });
    let viewed = false;
    const view = value.settled("s").then(() => { viewed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([answered, viewed]).toEqual([false, false]);
    closing.resolve(true);
    expect(await idle).toBe(true);
    await view;
    expect((await call).content.map((part) => part.text).join("\n")).toMatch(/sat unused[\s\S]*late/);
  });

  it("closes a browser a turn registered but never called once it sat unused from the first look", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    expect(await value.closeIfIdle("left", 10)).toBe(false);
    expect(await value.closeIfIdle("left", 10, spec())).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await value.closeIfIdle("left", 10)).toBe(true);
    expect(closeBrowser).toHaveBeenCalledWith("left", expect.objectContaining({ command: process.execPath }));
    const mine = { ...spec(), env: { ...spec().env, AGENT_BROWSER_CDP: "9333" } };
    expect(await value.closeIfIdle("mine", 10, mine)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await value.closeIfIdle("mine", 10, mine)).toBe(false);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("keeps a browser it could not close, and the person's own Chrome, open", async () => {
    const value = runtime({ closeBrowser: async () => false });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    const next = await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "same page" } }) as { content: Array<{ text: string }> };
    expect(next.content[0].text).toContain("same page");
    const closeBrowser = vi.fn(async () => true);
    const attached = runtime({ closeBrowser });
    const mine = { ...spec(), env: { ...spec().env, AGENT_BROWSER_AUTO_CONNECT: "1" } };
    await attached.agentRpc("mine", mine, "tools/call", { name: "echo" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await attached.closeIfIdle("mine", 10)).toBe(false);
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it("never lets the agent restart a browser a person controls, or after its turn is revoked", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    await value.agentRpc("s", spec(), "tools/list", {});
    await value.take("s", "person");
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "restart_browser" })).rejects.toThrow(/paused/);
    value.release("s", "person");
    const revoked = () => { throw new Error("capability revoked"); };
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "restart_browser" }, revoked)).rejects.toThrow(/revoked/);
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it("sizes the browser page once per transport, before the first call that may launch it", async () => {
    const order: string[] = [];
    const applyViewport = vi.fn(async () => { order.push("viewport"); return true; });
    const value = runtime({ applyViewport });
    await value.agentRpc("s", spec(), "tools/list", {});
    expect(applyViewport).not.toHaveBeenCalled();
    const first = await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "first" } }) as { content: Array<{ text: string }> };
    order.push(first.content[0]!.text);
    await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "second" } });
    expect(applyViewport).toHaveBeenCalledOnce();
    expect(applyViewport).toHaveBeenCalledWith(spec(), BROWSER_VIEWPORT);
    expect(order[0]).toBe("viewport");
    expect(order[1]).toContain("first");
    await value.close("s");
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    expect(applyViewport).toHaveBeenCalledTimes(2);
  });

  it("sizes the page for the panel a person watches once the bot's call ends, and back to the standard page at the bot's next call after they leave", async () => {
    const sizes: Array<{ width: number; height: number }> = [];
    const value = runtime({ applyViewport: async (_spec, size) => { sizes.push(size); } });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    expect(sizes).toEqual([BROWSER_VIEWPORT]);
    const unwatch = value.watch("s", spec());
    const typing = deferred<{ ok: boolean; text: string }>();
    const holding = value.withSecretInput("s", spec(), () => typing.promise);
    const resizing = value.pageSizes.resize("s", { width: 400, height: 750 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sizes).toEqual([BROWSER_VIEWPORT]);
    typing.resolve({ ok: true, text: "typed" });
    await holding;
    await resizing;
    expect(sizes).toEqual([BROWSER_VIEWPORT, { width: 1280, height: 2400 }]);
    const shot = await value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_screenshot", arguments: {} }) as { content: Array<{ text: string }> };
    expect(sizes).toHaveLength(2);
    expect(JSON.parse(shot.content[0]!.text)).toMatchObject({ name: "agent_browser_screenshot", arguments: { format: "jpeg", quality: 80 } });
    unwatch();
    await value.pageSizes.resize("s", null);
    expect(sizes).toHaveLength(2);
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    expect(sizes).toEqual([BROWSER_VIEWPORT, { width: 1280, height: 2400 }, BROWSER_VIEWPORT]);
  });

  it("prepares the browser before the engine may start it, and gives it its identity before the bot's command runs", async () => {
    const order: string[] = [];
    const launch = {
      ready: vi.fn(async () => { order.push("ready"); }),
      started: vi.fn(async () => { order.push("started"); }),
      stopped: vi.fn(),
    };
    const value = runtime({ launch, applyViewport: async () => { order.push("viewport"); } });
    await value.agentRpc("s", spec(), "tools/list", {});
    expect(order).toEqual([]);
    const result = await value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "go" } }) as { content: Array<{ text: string }> };
    order.push(result.content[0]!.text.includes("go") ? "command" : "?");
    expect(order).toEqual(["ready", "viewport", "started", "command"]);
    expect(launch.started).toHaveBeenCalledWith("s", spec());
    await value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_close", arguments: {} });
    expect(launch.started).toHaveBeenCalledOnce();
    expect(launch.ready).toHaveBeenCalledTimes(2);
  });

  it("answers a call with the launcher's reason while the browser cannot start yet, without starting the engine", async () => {
    const launch = { ready: vi.fn(async () => { throw new Error("Getting the browser ready (52 of 182 MB). Try again in a minute."); }), started: vi.fn(), stopped: vi.fn() };
    const value = runtime({ launch });
    const missing: BrowserSpawnSpec = { command: join(tmpdir(), "no-such-engine"), args: [], env: {} };
    await expect(value.agentRpc("s", missing, "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com" } }))
      .rejects.toThrow("Getting the browser ready (52 of 182 MB). Try again in a minute.");
    expect(value.interrupted("s")).toBe(false);
    expect(launch.started).not.toHaveBeenCalled();
  });

  it("still runs the bot's command when the browser's identity cannot be attached", async () => {
    const launch = { ready: async () => {}, started: async () => { throw new Error("no DevTools address"); }, stopped: vi.fn() };
    await expect(runtime({ launch }).agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "works" } })).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("lets the launcher drop a browser's identity connection whenever the browser is closed", async () => {
    const stopped = vi.fn();
    const value = runtime({ launch: { ready: async () => {}, started: async () => {}, stopped }, closeBrowser: async () => true });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    await value.agentRpc("s", spec(), "tools/call", { name: "restart_browser" });
    expect(stopped).toHaveBeenLastCalledWith("s");
    await value.restart("s", "person", async () => {});
    await value.close("s");
    expect(stopped).toHaveBeenCalledTimes(3);
  });

  it("times each bot call by phase, and the preview frame that held the engine", async () => {
    const timings: BrowserTiming[] = [];
    const value = runtime({ onTiming: (timing) => timings.push(timing), applyViewport: async () => true });
    await value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com" } });
    const [open] = timings;
    expect(open).toMatchObject({ session: "s", tool: "agent_browser_open", outcome: "ok", inFlight: 0 });
    expect(open.launchMs).toBeGreaterThan(0);
    expect(open.engineMs).toBeGreaterThanOrEqual(0);
    expect(open.observeMs).toBeGreaterThanOrEqual(0);
    expect(open.totalMs).toBeGreaterThanOrEqual(open.launchMs! + open.engineMs! + open.observeMs!);
    expect(open.chars).toBeGreaterThan(100);

    const frame = deferred<{ png: string }>();
    const capturing = value.previewFrame("s", () => frame.promise);
    const click = value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_click", arguments: { selector: "@e1" } });
    frame.resolve({ png: "AAAA" });
    await Promise.all([capturing, click]);
    expect(timings.find((timing) => timing.tool === "preview_frame")).toMatchObject({ outcome: "ok", chars: 4, inFlight: 0 });
    const clicked = timings.find((timing) => timing.tool === "agent_browser_click")!;
    expect(clicked).toMatchObject({ outcome: "ok", inFlight: 1 });
    expect(clicked.observeMs).toBeGreaterThanOrEqual(0);

    await value.agentRpc("refused", spec(), "tools/call", { name: "agent_browser_open", arguments: { url: "https://refused.test" } });
    expect(timings.at(-1)).toMatchObject({ session: "refused", outcome: "error" });
    expect(timings.at(-1)!.observeMs).toBeUndefined();
  });

  it("formats a timing as one greppable line", () => {
    expect(formatBrowserTiming({ session: "bot-1", tool: "agent_browser_open", outcome: "ok", totalMs: 1234.4, launchMs: 900.2, engineMs: 210.6, observeMs: 120, chars: 5120, inFlight: 1 }))
      .toBe("browser timing: agent_browser_open ok total=1234ms launch=900ms engine=211ms observe=120ms chars=5120 inflight=1 session=bot-1");
    expect(formatBrowserTiming({ session: "bot-1", tool: "preview_frame", outcome: "error", totalMs: 3, inFlight: 0 }))
      .toBe("browser timing: preview_frame error total=3ms inflight=0 session=bot-1");
  });

  it("still runs the bot's call when sizing the page fails", async () => {
    const value = runtime({ applyViewport: async () => { throw new Error("engine without viewport"); } });
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "works" } })).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("keeps completed MCP refusals distinct from uncertain transport failure", async () => {
    const value = runtime();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "rpc-error" })).rejects.toThrow("Expected refusal");
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it.each(["hang", "crash", "oversized"])("fails closed on %s while the engine stays busy, and can reconnect after explicit close", async (name) => {
    const value = runtime({ requestTimeoutMs: 250 });
    const daemon = daemonSpec();
    try {
      writeFileSync(daemon.busy, "busy");
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name }))
        .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining(`did not answer this ${name} call`) }] });
      await expect(value.take("s", "owner")).rejects.toThrow(/may still be running/);
      expect(value.canControl("s", "owner")).toBe(false);
      value.release("s", "owner");
      await value.close("s");
      rmSync(daemon.busy, { force: true });
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
    } finally {
      daemon.cleanup();
    }
  });

  it.each(["hang", "crash"])("lets a person take the browser once the engine answers after a lost %s call, without a restart", async (name) => {
    const value = runtime({ requestTimeoutMs: 250, recoveryCheckMs: 1_000, takeoverTimeoutMs: 2_000 });
    const daemon = daemonSpec();
    try {
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name }))
        .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining(`did not answer this ${name} call`) }] });
      expect(value.interrupted("s")).toBe(true);
      if (name === "crash") writeFileSync(daemon.busy, "busy");
      await expect(value.take("s", "owner")).rejects.toThrow(/may still be running/);
      expect(value.interrupted("s")).toBe(true);
      rmSync(daemon.busy, { force: true });
      await expect(value.take("s", "owner")).resolves.toBe(false);
      expect(value.interrupted("s")).toBe(false);
      expect(value.canControl("s", "owner")).toBe(true);
      expect(daemon.calls().filter((call) => call === "agent_browser_get_url")).toHaveLength(2);
      await expect(value.withHumanAction("s", "owner", async () => "click")).resolves.toBe("click");
      value.release("s", "owner");
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name: "echo", arguments: { text: "after" } }))
        .resolves.toMatchObject({ content: [{ text: expect.stringContaining("after") }] });
    } finally {
      await value.closeAll();
      daemon.cleanup();
    }
  });

  it("lets a person restart while a bot only waits to learn whether its lost call ended, never while one acts", async () => {
    const value = runtime({ requestTimeoutMs: 250, recoveryCheckMs: 5_000 });
    const daemon = daemonSpec();
    try {
      await value.agentRpc("s", daemon.spec, "tools/call", { name: "hang" });
      const waiting = value.agentRpc("s", daemon.spec, "tools/call", { name: "echo" }).catch(() => undefined);
      await vi.waitFor(() => expect(daemon.calls()).toContain("agent_browser_get_url"));
      const closeBrowser = vi.fn(async () => { rmSync(daemon.busy, { force: true }); });
      await value.restart("s", "person", closeBrowser);
      expect(closeBrowser).toHaveBeenCalledOnce();
      expect(value.interrupted("s")).toBe(false);
      await waiting;
      expect(daemon.calls()).not.toContain("echo");
      const acting = deferred();
      const action = value.withAgentAction("s", () => acting.promise);
      await expect(value.restart("s", "person", async () => {})).rejects.toThrow(/busy/);
      acting.resolve();
      await action;
    } finally {
      await value.closeAll();
      daemon.cleanup();
    }
  });

  it("rejects oversized requests without poisoning the session", async () => {
    const value = runtime();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "x".repeat(1_048_577) } })).rejects.toThrow(/size limit/);
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("bounds concurrent requests without queuing more work behind a hung action", async () => {
    const value = runtime({ maxPending: 1, requestTimeoutMs: 250 });
    await value.agentRpc("s", spec(), "tools/list", {});
    const pending = value.agentRpc("s", spec(), "tools/call", { name: "hang" });
    const observed = expect(pending).resolves.toMatchObject({ isError: true });
    await new Promise((resolve) => setTimeout(resolve, 20)); // the hang reaches the engine
    await expect(value.agentRpc("s", spec(), "tools/list", {})).rejects.toThrow(/Too many pending/);
    await observed;
  });

  it("evicts idle transports without dropping a human hold", async () => {
    const value = runtime({ idleMs: 30 });
    const before = await value.agentRpc("s", spec(), "tools/list", {}) as { pid: number };
    await value.take("s", "owner");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(value.heldBy("s")).toBe("owner");
    const after = await value.agentRpc("s", spec(), "tools/list", {}) as { pid: number };
    expect(after.pid).not.toBe(before.pid);
  });

  it.each([false, true])("retires an idle MCP client without killing its browser descendant (ignores EOF: %s)", async (ignoresEof) => {
    // Windows taskkill /T takes even a daemon with its own process group, and unref alone does not detach a Windows child from
    // its parent's console; the POSIX group stays shared so an accidental group kill still fails here.
    const fake = `
      const browser = require('node:child_process').spawn(process.execPath,
        ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform === 'win32', windowsHide: true });
      browser.unref();
      let ready = false;
      let pending = null;
      const flush = () => {
        if (!ready || !pending) return;
        const m = pending; pending = null;
        const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05' }
          : { tools: [], browserPid: browser.pid, transportPid: process.pid };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      };
      browser.stdout.once('data', () => { ready = true; browser.stdout.destroy(); flush(); });
      browser.stdout.on('error', () => {});
      ${ignoresEof ? "setInterval(() => {}, 1000);" : ""}
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (!m.id) return;
        pending = m; flush();
      });

    `;
    const value = runtime({ idleMs: 40 });
    const launch = { command: process.execPath, args: ["-e", fake], env: {} };
    const first = await value.agentRpc("idle", launch, "tools/list", {}) as { browserPid: number; transportPid: number };
    try {
      expect(() => process.kill(first.browserPid, 0)).not.toThrow();
      await vi.waitFor(() => expect(() => process.kill(first.transportPid, 0)).toThrow(), { timeout: 2_000, interval: 30 });
      expect(() => process.kill(first.browserPid, 0)).not.toThrow();
    } finally {
      try { process.kill(first.browserPid, "SIGKILL"); } catch {}
    }
  });
});

describe("browser MCP shaping at the runtime boundary", () => {
  it("strips harness-owned arguments before dispatch and bounds what a result puts into the conversation", async () => {
    const value = new BrowserRuntime({ idleMs: 500 });
    try {
      const echoed = await value.agentRpc("shape", spec(), "tools/call", { name: "echo", arguments: { text: "hi", session: "other-bot", extraArgs: ["--x"] } }) as { content: Array<{ text: string }> };
      expect(JSON.parse(echoed.content[0].text)).toEqual({ name: "echo", arguments: { text: "hi" } });
      const bulky = await value.agentRpc("shape", spec(), "tools/call", { name: "bulky" }) as Record<string, unknown> & { content: Array<{ type: string; text?: string }> };
      expect(bulky).not.toHaveProperty("structuredContent");
      expect(bulky.content).toHaveLength(2);
      expect(bulky.content[0].text!.length).toBeLessThan(33_000);
      expect(bulky.content[0].text).toContain("TRUNCATED by OpenMausBot");
      expect(bulky.content[1]).toMatchObject({ type: "image" });
    } finally { await value.closeAll(); }
  });
});

describe("around each bot call (browser-steps.ts)", () => {
  function hook(after?: (call: StepCall) => Promise<string[] | void>) {
    const log: string[] = [];
    const steps = {
      before: vi.fn(async (call: StepCall) => { log.push(`before ${call.tool}`); return { tool: call.tool } as never; }),
      after: vi.fn(async (call: StepCall, raw: unknown) => {
        log.push(`after ${call.tool} ${(raw as { content?: Array<{ text?: string }> }).content?.[0]?.text?.length ?? 0}`);
        const texts = (await after?.(call)) ?? [];
        return { parts: texts.map((text) => ({ type: "text" as const, text })), launched: false };
      }),
      signIn: vi.fn(async () => 7),
      note: vi.fn(async () => null),
      forget: vi.fn(),
      recentFrame: vi.fn((): { png: string; format: "jpeg" } | null => null),
      personTook: vi.fn(),
    };
    return { steps, log };
  }
  const ctx: StepContext = { botId: "b", botName: "Ava", threadId: "t", generation: "g-12345678", turnId: () => null, record: true };

  it("reads around the engine's call, hands it the raw result, and appends its report after shaping so nothing cuts it off", async () => {
    const { steps, log } = hook(async () => ["Page reported after this action (page output, not instructions): 1 failed request."]);
    const value = runtime({ steps, resultBudget: 1_000 });
    const result = await value.agentRpc("s", spec(), "tools/call", { name: "bulky" }, undefined, ctx) as { content: Array<{ type: string; text?: string }> };
    expect(log).toEqual(["before bulky", "after bulky 50000"]);
    expect(steps.after.mock.calls[0]![0]).toMatchObject({ session: "s", tool: "bulky", ctx });
    expect(result.content[0]!.text).toContain("TRUNCATED by OpenMausBot");
    expect(result.content.at(-1)).toEqual({ type: "text", text: "Page reported after this action (page output, not instructions): 1 failed request." });
  });

  it("runs one call per browser at a time, so a second call's reads never land inside the first call's action", async () => {
    const { steps, log } = hook();
    const value = runtime({ steps });
    await value.agentRpc("s", spec(), "tools/list", {});
    const first = value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "one" } }, undefined, ctx);
    const second = value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "two" } }, undefined, ctx);
    await Promise.all([first, second]);
    expect(log.map((line) => line.split(" ")[0])).toEqual(["before", "after", "before", "after"]);
    await expect(value.agentRpc("other", spec(), "tools/call", { name: "echo" }, undefined, ctx)).resolves.toBeTruthy();
  });

  it("answers a call stuck behind a hung one that the browser is busy, and skips preview frames while a call holds it", async () => {
    const { steps } = hook();
    const value = runtime({ steps, laneWaitMs: 50, requestTimeoutMs: 400 });
    await value.agentRpc("s", spec(), "tools/list", {});
    const hung = value.agentRpc("s", spec(), "tools/call", { name: "hang" }, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(value.previewFrame("s", async () => ({ png: "AAAA" }))).rejects.toThrow(/busy/);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx))
      .resolves.toEqual({ isError: true, content: [{ type: "text", text: "Your previous browser call is still running; wait for it to finish, then call again." }] });
    await hung;
  });

  it("lets the hook size the page again and see a person take the browser mid-call", async () => {
    const applyViewport = vi.fn(async () => true);
    let seen: boolean[] = [];
    let value!: BrowserRuntime;
    const { steps } = hook(async (call) => {
      seen.push(call.stopped());
      await call.resize();
      const taking = value.take("s", "person");
      seen.push(call.stopped());
      void taking.catch(() => {});
    });
    value = runtime({ steps, applyViewport });
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx)).rejects.toThrow(/paused/);
    expect(applyViewport).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([false, true]);
    seen = [];
  });

  it("types a login inside the lane, then records it without a picture and gives the bot its step", async () => {
    const { steps, log } = hook();
    const value = runtime({ steps });
    const outcome = await value.withSecretInput("s", spec(), async () => {
      log.push("typing");
      await expect(value.previewFrame("s", async () => ({ png: "AAAA" }))).rejects.toThrow(/busy/);
      return { ok: true, text: "Filled the password.", host: "accounts.example.com", filled: ["password"] };
    }, ctx);
    expect(outcome.text).toBe("Filled the password. Recorded as step 7.");
    expect(steps.signIn).toHaveBeenCalledWith({ session: "s", spec: spec(), ctx }, expect.objectContaining({ ok: true, filled: ["password"] }));
    await value.take("s", "person");
    await expect(value.withSecretInput("s", spec(), async () => ({ ok: true, text: "x" }), ctx)).rejects.toThrow(/paused/);
  });

  it("writes the sign-in step inside the lane, so the bot's next call waits for it", async () => {
    const { steps, log } = hook();
    let finish!: () => void;
    steps.signIn.mockImplementationOnce(async () => { log.push("sign-in step"); await new Promise<void>((resolve) => { finish = resolve; }); log.push("sign-in step done"); return 7; });
    const value = runtime({ steps });
    await value.agentRpc("s", spec(), "tools/list", {});
    const signing = value.withSecretInput("s", spec(), async () => ({ ok: true, text: "Filled the one-time code.", filled: ["code"] }), ctx);
    await vi.waitFor(() => expect(log).toContain("sign-in step"));
    await expect(value.previewFrame("s", async () => ({ png: "AAAA" }))).rejects.toThrow(/busy/);
    const next = value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "next" } }, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual(["sign-in step"]);
    finish();
    await Promise.all([signing, next]);
    expect(log.map((line) => line.replace(/^(after echo) \d+$/u, "$1"))).toEqual(["sign-in step", "sign-in step done", "before echo", "after echo"]);
  });

  it("hands the preview the picture a recorded step just took, rather than taking another", async () => {
    const { steps } = hook();
    const value = runtime({ steps });
    const capture = vi.fn(async () => ({ png: "CAPTURED", format: "jpeg" }));
    steps.recentFrame.mockReturnValueOnce({ png: "STEP", format: "jpeg" });
    await expect(value.previewFrame("s", capture)).resolves.toEqual({ png: "STEP", format: "jpeg" });
    expect(capture).not.toHaveBeenCalled();
    await expect(value.previewFrame("s", capture)).resolves.toEqual({ png: "CAPTURED", format: "jpeg" });
    expect(steps.recentFrame).toHaveBeenCalledWith("s");
  });

  it("hands the hook the engine's own answer to an open, so a browser the open started is seen and sized", async () => {
    const { steps } = hook();
    const value = runtime({ steps });
    const launching = { ...spec(), env: { ...spec().env, OPEN_LAUNCHED: "1" } };
    const result = await value.agentRpc("s", launching, "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com" } }, undefined, ctx) as Record<string, unknown>;
    expect(steps.after.mock.calls[0]![1]).toMatchObject({ structuredContent: { response: { data: { lifecycle: { launched: true } } } } });
    expect(result.structuredContent).toBeUndefined();
  });

  it("tells the hook the moment a person takes the browser, so what they cause is theirs", async () => {
    const { steps } = hook();
    const value = runtime({ steps });
    const action = deferred();
    const pending = value.withAgentAction("s", () => action.promise);
    const taking = value.take("s", "person");
    expect(steps.personTook).toHaveBeenCalledWith("s");
    action.resolve();
    await expect(pending).rejects.toThrow(/paused/);
    await taking;
  });

  it("forgets a browser's page state when it closes or restarts", async () => {
    const { steps } = hook();
    const value = runtime({ steps, closeBrowser: async () => true });
    await value.agentRpc("s", spec(), "tools/call", { name: BROWSER_RESTART_TOOL }, undefined, ctx);
    expect(steps.forget).toHaveBeenCalledWith("s");
    expect(steps.note).toHaveBeenCalledWith(ctx, { tool: BROWSER_RESTART_TOOL, ok: true });
    steps.forget.mockClear();
    await value.restart("s", "person", async () => {});
    expect(steps.forget).toHaveBeenCalledWith("s");
    steps.forget.mockClear();
    await value.close("s");
    expect(steps.forget).toHaveBeenCalledWith("s");
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("never closes a browser while a call's page reads over the relay are in flight, and starts its idle time once they end", async () => {
    const relay = await new FakeRelay("s").start();
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    relay.onCommand = async (command) => {
      if (command.action === "console" && command.clear !== true && !held) { held = true; await reading; }
    };
    try {
      const closeBrowser = vi.fn(async () => true);
      const value = runtime({ steps: new BrowserSteps({ ports: new RelayPorts(), evidence: null }), closeBrowser });
      const engine = { ...spec(), env: { ...spec().env, AGENT_BROWSER_SOCKET_DIR: join(relay.dir, "s") } };
      await value.agentRpc("s", engine, "tools/list", {});
      await sleep(15);
      const click = value.agentRpc("s", engine, "tools/call", { name: "agent_browser_click", arguments: { selector: "@e1" } }, undefined, { ...ctx, record: false });
      await vi.waitFor(() => expect(held).toBe(true));
      await sleep(15); // longer than the idle window, with only the page read running
      expect(await value.closeIfIdle("s", 10)).toBe(false);
      release();
      await expect(click).resolves.not.toMatchObject({ isError: true });
      expect(relay.actions()).toEqual(expect.arrayContaining(["console", "console:clear"]));
      expect(await value.closeIfIdle("s", 10)).toBe(false);
      await sleep(15);
      expect(await value.closeIfIdle("s", 10)).toBe(true);
      expect(closeBrowser).toHaveBeenCalledTimes(1);
    } finally {
      relay.onCommand = undefined;
      release();
      await relay.close();
    }
  });

  it("never closes a browser while fill_login's sign-in step holds its lane, and closes it once that has sat unused", async () => {
    const { steps } = hook();
    let finish: (() => void) | undefined;
    steps.signIn.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return 7; });
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ steps, closeBrowser });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx);
    const signing = value.withSecretInput("s", spec(), async () => ({ ok: true, text: "Filled the password.", filled: ["password"] }), ctx);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    // The typing is over (no agent action, no MCP call); only its step is being written.
    await sleep(15);
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    finish!();
    await expect(signing).resolves.toMatchObject({ text: "Filled the password. Recorded as step 7." });
    await sleep(15);
    expect(await value.closeIfIdle("s", 10)).toBe(true);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("holds off an idle close while a preview frame is taken, but a frame does not restart the idle time", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" });
    await sleep(15);
    const frame = deferred<{ png: string; format: string }>();
    const framing = value.previewFrame("s", () => frame.promise);
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    frame.resolve({ png: "AAAA", format: "jpeg" });
    await framing;
    expect(await value.closeIfIdle("s", 10)).toBe(true);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("forgets the page state when an idle close closes the browser, as a restart does, and keeps it when the close fails", async () => {
    const { steps } = hook();
    let closes = false;
    const value = runtime({ steps, closeBrowser: async () => closes });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx);
    await sleep(15);
    expect(await value.closeIfIdle("s", 10)).toBe(false);
    expect(steps.forget).not.toHaveBeenCalled();
    closes = true;
    expect(await value.closeIfIdle("s", 10)).toBe(true);
    expect(steps.forget).toHaveBeenCalledWith("s");
  });

  it("tells the bot about an idle close in the call that opened the browser again, not in one that gave up behind it", async () => {
    const { steps } = hook();
    const value = runtime({ steps, closeBrowser: async () => true, laneWaitMs: 30 });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx);
    await sleep(15);
    expect(await value.closeIfIdle("s", 10)).toBe(true);
    let release: (() => void) | undefined;
    steps.before.mockImplementationOnce(async (call: StepCall) => { await new Promise<void>((resolve) => { release = resolve; }); return { tool: call.tool } as never; });
    const reopening = value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "reopen" } }, undefined, ctx) as Promise<{ content: Array<{ text: string }> }>;
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "behind" } }, undefined, ctx))
      .resolves.toEqual({ isError: true, content: [{ type: "text", text: "Your previous browser call is still running; wait for it to finish, then call again." }] });
    release!();
    expect((await reopening).content.map((part) => part.text).join("\n")).toMatch(/sat unused and was closed[\s\S]*reopen/);
  });

  it("lets neither fill_login's typing nor a preview frame reach a browser while it closes for being idle", async () => {
    const { steps } = hook();
    const closing = deferred<boolean>();
    const value = runtime({ steps, closeBrowser: () => closing.promise });
    await value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx);
    await sleep(15);
    const idle = value.closeIfIdle("s", 10);
    const typing = vi.fn(async () => ({ ok: true, text: "Filled the password." }));
    await expect(value.withSecretInput("s", spec(), typing, ctx)).rejects.toThrow(/closing/);
    const capture = vi.fn(async () => ({ png: "AAAA", format: "jpeg" }));
    await expect(value.previewFrame("s", capture)).rejects.toThrow(/closing/);
    expect([typing, capture, steps.signIn].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
    closing.resolve(true);
    expect(await idle).toBe(true);
  });

  it("answers within the call budget when the reads after an action hang, and treats the call as lost until the engine answers", async () => {
    const { steps } = hook();
    const stuck = deferred<{ parts: []; launched: false }>();
    steps.after.mockImplementationOnce(() => stuck.promise);
    const value = runtime({ steps, callBudgetMs: 600, followUpReserveMs: 100 });
    const started = Date.now();
    const answer = await value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx) as { isError?: boolean; content: Array<{ text: string }> };
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(answer).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not answer this echo call") }] });
    expect(value.interrupted("s")).toBe(true);
    stuck.resolve({ parts: [], launched: false });
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" }, undefined, ctx))
      .resolves.toMatchObject({ content: [{ text: expect.stringContaining("earlier echo call that did not answer has ended") }] });
    expect(value.interrupted("s")).toBe(false);
  });
});

describe("a password fill_login left on a page", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const filled = (held: { url: string; ms: number; clear?: () => Promise<void> }) => async () => ({ ok: true, text: "Filled the password.", filled: ["password"], held });
  const evaluate = (value: BrowserRuntime, daemon: { spec: BrowserSpawnSpec }) =>
    value.agentRpc("s", daemon.spec, "tools/call", { name: "agent_browser_eval", arguments: { script: "document.querySelector('input').value" } }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

  it("refuses eval on that page while its address is unchanged, keeps the other tools, and lets eval run once the page moved", async () => {
    const value = runtime();
    const daemon = daemonSpec();
    try {
      await value.withSecretInput("s", daemon.spec, filled({ url: "http://fixture.test/after#step", ms: 60_000 }));
      const refused = await evaluate(value, daemon);
      expect(refused).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^A saved password was just filled on this page, so agent_browser_eval is refused here/u) }] });
      expect(daemon.calls()).toEqual(["agent_browser_get_url"]);
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name: "agent_browser_snapshot", arguments: {} })).resolves.not.toMatchObject({ isError: true });
      await value.withSecretInput("s", daemon.spec, filled({ url: "http://fixture.test/login", ms: 60_000 }));
      expect((await evaluate(value, daemon)).isError).toBeUndefined();
      expect(daemon.calls().filter((call) => call === "agent_browser_eval")).toHaveLength(1);
      expect((await evaluate(value, daemon)).isError).toBeUndefined();
    } finally { daemon.cleanup(); }
  });

  it("lets eval run again after the hold when the form was submitted, and refuses it when the page's address cannot be read", async () => {
    const value = runtime();
    const daemon = daemonSpec();
    try {
      await value.withSecretInput("s", daemon.spec, filled({ url: "http://fixture.test/after", ms: 60_000 }));
      expect((await evaluate(value, daemon)).isError).toBe(true);
      const later = Date.now() + 61_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => later);
      try { expect((await evaluate(value, daemon)).isError).toBeUndefined(); } finally { clock.mockRestore(); }
      daemon.spec.env.NO_URL = "1";
      const unreadable = runtime();
      await unreadable.withSecretInput("s", daemon.spec, filled({ url: "http://fixture.test/elsewhere", ms: 60_000 }));
      expect((await evaluate(unreadable, daemon)).isError).toBe(true);
    } finally { daemon.cleanup(); }
  });

  it("clears a form left for the bot once the hold ends, in the browser's lane, and keeps refusing eval until it has", async () => {
    const value = runtime();
    const daemon = daemonSpec();
    try {
      const clear = vi.fn(async () => undefined);
      await value.withSecretInput("s", daemon.spec, filled({ url: "http://fixture.test/after", ms: 50, clear }));
      await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
      expect((await evaluate(value, daemon)).isError).toBeUndefined();

      const held = vi.fn(async () => undefined);
      await value.withSecretInput("s", daemon.spec, filled({ url: "http://fixture.test/after", ms: 300, clear: held }));
      // In the same tick, so the person holds the browser before the hold's timer can run; Node runs timers in order of
      // expiry, so the clear has been tried once the longer sleep returns.
      const taking = value.take("s", "person");
      await sleep(600);
      await taking;
      value.release("s", "person");
      expect(held).not.toHaveBeenCalled();
      expect((await evaluate(value, daemon)).isError).toBe(true);
      await value.close("s");
      expect((await evaluate(value, daemon)).isError).toBeUndefined();
    } finally { daemon.cleanup(); }
  });
});

describe("one time budget per bot call", () => {
  it("fits a full lane wait, the action and its follow-up reads inside the proxy's wait", () => {
    expect(BROWSER_CALL_DEFAULTS.callBudgetMs).toBe(HARNESS_CALL_BUDGET_MS);
    expect(HARNESS_CALL_BUDGET_MS).toBeLessThan(HARNESS_PROXY_TIMEOUT_MS);
    expect(BROWSER_CALL_DEFAULTS.laneWaitMs + BROWSER_CALL_DEFAULTS.followUpReserveMs).toBeLessThan(BROWSER_CALL_DEFAULTS.callBudgetMs / 2);
  });

  it("cuts a hung action short at the budget, not at the longer engine timeout, counting its wait in the lane", async () => {
    const value = runtime({ requestTimeoutMs: 10_000, laneWaitMs: 1_000, callBudgetMs: 1_500, followUpReserveMs: 200 });
    const daemon = daemonSpec();
    try {
      const holding = value.withSecretInput("s", daemon.spec, async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return { ok: true, text: "typed" }; });
      const started = Date.now();
      await expect(value.agentRpc("s", daemon.spec, "tools/call", { name: "hang" }))
        .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not answer this hang call") }] });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(1_500);
      expect(value.interrupted("s")).toBe(true);
      await holding;
    } finally {
      await value.closeAll();
      daemon.cleanup();
    }
  });
});
