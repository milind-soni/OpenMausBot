import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime, TransportError, browserRuntimeEnv, type BrowserSpawnSpec } from "./browser-runtime.ts";

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
let initialized = false;
let rpcTimeoutCalls = 0;
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') { initialized = true; return; }
  let result;
  if (m.method === 'initialize') result = { protocolVersion:'2024-11-05',capabilities:{tools:{}} };
  else if (m.method === 'tools/list') result = { tools:[{name:'echo'}],pid:process.pid,initialized };
  else if (m.params.name === 'hang') return;
  else if (m.params.name === 'crash') process.exit(23);
  else if (m.params.name === 'oversized') { process.stdout.write('x'.repeat(16777217)); return; }
  else if (m.params.name === 'bulky') result = { content:[{type:'text',text:'x'.repeat(50000)},{type:'image',data:'AAAA',mimeType:'image/png'}], structuredContent:{ huge: 'y'.repeat(200000) } };
  else if (m.params.name === 'rpc-error') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'Expected refusal'}})+'\\n'); return; }
  else if (m.params.name === 'rpc-timeout') { rpcTimeoutCalls += 1; if (rpcTimeoutCalls === 1) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'request timed out'}})+'\\n'); return; } result = { content:[{type:'text',text:'engine answered a repeat rpc-timeout call'}] }; }
  else result = { content:[{type:'text',text:JSON.stringify(m.params)}],pid:process.pid };
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`;
const spec = (): BrowserSpawnSpec => ({ command: process.execPath, args: ["-e", FAKE_MCP], env: { PATH: process.env.PATH } });

describe("server-owned browser MCP runtime", () => {
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
  it("does not assume an MCP timeout stopped an accepted daemon action", async () => {
    const value = runtime({ requestTimeoutMs: 60 });
    // Advance only the deliberately hung request's deadline. Real subprocess
    // startup/stdio remain live, so a loaded runner cannot time out a healthy
    // recovery echo merely because its 60 ms scheduling window elapsed.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await expect(value.agentRpc("s", spec(), "tools/list", {})).resolves.toMatchObject({ initialized: true });
      const pending = value.agentRpc("s", spec(), "tools/call", { name: "hang" });
      const observed = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await observed;
      // The real daemon detaches from its MCP parent. Transport exit is not
      // proof that a navigation or submission stopped; do not replay it.
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).rejects.toThrow(/Restart/);
      await expect(value.take("s", "owner")).rejects.toThrow(/Restart/);
      await value.restart("s", "owner", async () => {});
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "back" } }))
        .resolves.toMatchObject({ content: [{ text: expect.stringContaining("back") }] });
      await value.take("s", "owner");
      expect(value.canControl("s", "owner")).toBe(true);
    } finally {
      // Process-tree cleanup polls real child exits with timers of its own.
      vi.useRealTimers();
      await value.closeAll();
    }
  });

  it("surfaces an engine-reported JSON-RPC timeout instead of retrying it", async () => {
    // Only a TransportError timeout may be retried: its timer already killed
    // that child, so the next attempt starts a fresh transport. This engine
    // answers "request timed out" over a live transport, which is the engine
    // refusing rather than the plumbing failing; retrying would re-ask the
    // same wedged engine for the whole window.
    const value = runtime();
    // The fixture times out only the first rpc-timeout call and answers any
    // repeat distinctly, so a retry would resolve instead of reject: the
    // rejection below is proof the first timeout stayed the final outcome.
    const failure = value.agentRpc("s", spec(), "tools/call", { name: "rpc-timeout" });
    await expect(failure).rejects.toThrow(/request timed out/);
    await expect(failure).rejects.not.toBeInstanceOf(TransportError);
  });

  it("still refuses an agent after a human's own interrupted command, browser alive", async () => {
    // The other half of the contract: this uncertainty is NOT self-resolving,
    // because the browser is still running and may act again.
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
    await expect(value.agentRpc("one", spec(), "tools/list", {})).resolves.toMatchObject({ tools: [{ name: "echo" }] });
  });

  it("keeps completed MCP refusals distinct from uncertain transport failure", async () => {
    const value = runtime();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "rpc-error" })).rejects.toThrow("Expected refusal");
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it.each(["hang", "crash", "oversized"])("fails closed on %s, and can reconnect after explicit close", async (name) => {
    const value = runtime({ requestTimeoutMs: 250 });
    await expect(value.agentRpc("s", spec(), "tools/call", { name })).rejects.toThrow(/Browser/);
    await expect(value.take("s", "owner")).rejects.toThrow(/may still be running/);
    expect(value.canControl("s", "owner")).toBe(false);
    value.release("s", "owner");
    await value.close("s");
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
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
    const observed = expect(pending).rejects.toThrow(/timed out/);
    await Promise.resolve();
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
    // Windows taskkill /T includes even a daemon with its own process group.
    // This inert descendant models that ownership boundary on every platform.
    // unref alone does not detach a Windows child from its parent's console.
    // Keep the POSIX group shared so an accidental group kill still fails here.
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
      try { process.kill(first.browserPid, "SIGKILL"); } catch { /* fixture exited */ }
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
      expect(bulky.content[0].text).toContain("trimmed this tool result");
      expect(bulky.content[1]).toMatchObject({ type: "image" });
    } finally { await value.closeAll(); }
  });
});
