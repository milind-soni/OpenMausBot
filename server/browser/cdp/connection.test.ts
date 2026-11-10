import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CdpConnection } from "./connection.ts";
import { CdpProtocolError, DriverError } from "./errors.ts";
import { methodRefusal } from "./policy.ts";
import { pipeTransport, tracingTransport, type CdpTransport, type SentCommand } from "./transport.ts";

/** A transport whose browser side the test plays. */
function fakeBrowser() {
  const sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const messageListeners: Array<(message: string) => void> = [];
  const closeListeners: Array<(reason: string) => void> = [];
  const transport: CdpTransport = {
    send: (message) => sent.push(JSON.parse(message)),
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: () => closeListeners.forEach((listener) => listener("closed")),
  };
  return {
    transport,
    sent,
    reply: (message: unknown) => messageListeners.forEach((listener) => listener(JSON.stringify(message))),
    drop: (reason: string) => closeListeners.forEach((listener) => listener(reason)),
  };
}

describe("the quiet rule", () => {
  it.each(["Runtime.enable", "Runtime.addBinding", "Console.enable", "Debugger.enable", "Profiler.enable", "HeapProfiler.enable", "Network.getAllCookies"])(
    "never lets %s out, on any kind of session",
    (method) => {
      for (const kind of ["browser", "page", "frame", "worker", "other"] as const) {
        expect(methodRefusal(kind, method, {})).toMatch(/never sent/);
      }
    },
  );

  it("evaluates only in a named context unless the call is an explicit page-world one", () => {
    expect(methodRefusal("page", "Runtime.evaluate", { expression: "1" })).toMatch(/contextId/);
    expect(methodRefusal("page", "Runtime.evaluate", { expression: "1", contextId: 7 })).toBeNull();
    expect(methodRefusal("page", "Runtime.evaluate", { expression: "1" }, { pageWorld: true })).toBeNull();
  });

  it("adds scripts to new documents only in a named world", () => {
    expect(methodRefusal("page", "Page.addScriptToEvaluateOnNewDocument", { source: "1" })).toMatch(/worldName/);
    expect(methodRefusal("page", "Page.addScriptToEvaluateOnNewDocument", { source: "1", worldName: "" })).toMatch(/worldName/);
    expect(methodRefusal("frame", "Page.addScriptToEvaluateOnNewDocument", { source: "1", worldName: "omb" })).toBeNull();
  });

  it("gives workers the identity and nothing else", () => {
    expect(methodRefusal("worker", "Emulation.setUserAgentOverride", {})).toBeNull();
    expect(methodRefusal("worker", "Runtime.runIfWaitingForDebugger", {})).toBeNull();
    expect(methodRefusal("worker", "Runtime.evaluate", { contextId: 1 })).toMatch(/allowlist/);
    expect(methodRefusal("worker", "Page.enable", {})).toMatch(/allowlist/);
  });

  it("keeps page commands off the browser session and browser commands off pages", () => {
    expect(methodRefusal("browser", "Page.navigate", {})).toMatch(/allowlist/);
    expect(methodRefusal("page", "Browser.close", {})).toMatch(/allowlist/);
    expect(methodRefusal("browser", "Target.setAutoAttach", {})).toBeNull();
    expect(methodRefusal("page", "Input.dispatchKeyEvent", {})).toBeNull();
  });

  it("refuses a forbidden method before it reaches the wire", async () => {
    const browser = fakeBrowser();
    const connection = new CdpConnection(browser.transport);
    await expect(connection.root.send("Runtime.enable")).rejects.toMatchObject({ code: "forbidden-method" });
    expect(browser.sent).toEqual([]);
  });

  it("names no forbidden method anywhere in the driver's source", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "testing") walk(path);
        } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "policy.ts") {
          files.push(path);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    const offending = files.filter((file) => /["'`](?:Runtime\.enable|Runtime\.addBinding|Console\.enable|Debugger\.\w+|Profiler\.\w+)["'`]/.test(readFileSync(file, "utf8")));
    expect(offending).toEqual([]);
  });
});

describe("CdpConnection", () => {
  it("cleans up a command whose transport throws and allows the next command", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser();
    const send = browser.transport.send;
    const failure = new Error("pipe write failed");
    browser.transport.send = () => { throw failure; };
    const connection = new CdpConnection(browser.transport);
    try {
      await expect(connection.root.send("Browser.getVersion")).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
      browser.transport.send = send;
      const next = connection.root.send("Browser.getVersion");
      browser.reply({ id: browser.sent[0].id, result: { product: "Chrome/1" } });
      await expect(next).resolves.toEqual({ product: "Chrome/1" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connection.close();
      vi.useRealTimers();
    }
  });

  it("cleans up a command that cannot be serialized", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser();
    const connection = new CdpConnection(browser.transport);
    const params: Record<string, unknown> = {};
    params.cycle = params;
    try {
      await expect(connection.root.send("Browser.getVersion", params)).rejects.toBeInstanceOf(TypeError);
      expect(browser.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connection.close();
      vi.useRealTimers();
    }
  });

  it("matches answers to calls and errors to their method", async () => {
    const browser = fakeBrowser();
    const connection = new CdpConnection(browser.transport);
    const version = connection.root.send("Browser.getVersion");
    const navigate = connection.root.send("Target.createTarget", { url: "about:blank" });
    browser.reply({ id: browser.sent[1]!.id, error: { code: -32000, message: "nope" } });
    browser.reply({ id: browser.sent[0]!.id, result: { product: "Chrome/153" } });
    await expect(version).resolves.toEqual({ product: "Chrome/153" });
    await expect(navigate).rejects.toBeInstanceOf(CdpProtocolError);
    await expect(navigate).rejects.toThrow(/Target.createTarget: nope/);
  });

  it("creates a child session before its first event, and routes events by session", async () => {
    const browser = fakeBrowser();
    const connection = new CdpConnection(browser.transport);
    const seen: string[] = [];
    connection.root.on("Target.attachedToTarget", (params) => {
      const child = connection.session(String(params.sessionId))!;
      expect(child.kind).toBe("page");
      expect(child.parent).toBe(connection.root);
      child.on("Page.loadEventFired", () => seen.push("child load"));
    });
    connection.root.on("Page.loadEventFired", () => seen.push("root load"));
    browser.reply({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } } });
    browser.reply({ method: "Page.loadEventFired", params: {}, sessionId: "S1" });
    expect(seen).toEqual(["child load"]);
    const child = connection.session("S1")!;
    void child.send("Page.enable");
    expect(browser.sent.at(-1)).toMatchObject({ method: "Page.enable", sessionId: "S1" });
  });

  it("fails a detached session's calls instead of leaving them waiting", async () => {
    const browser = fakeBrowser();
    const connection = new CdpConnection(browser.transport);
    browser.reply({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "iframe" } } });
    const child = connection.session("S1")!;
    expect(child.kind).toBe("frame");
    const pending = child.send("Page.enable");
    browser.reply({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await expect(child.send("Page.enable")).rejects.toMatchObject({ code: "closed" });
  });

  it("times a call out, and fails every call when the browser goes away", async () => {
    const browser = fakeBrowser();
    const connection = new CdpConnection(browser.transport, { defaultTimeoutMs: 20 });
    await expect(connection.root.send("Browser.getVersion")).rejects.toMatchObject({ code: "timeout" });
    const waiting = connection.root.send("Browser.getVersion", {}, { timeoutMs: 0 });
    const event = connection.root.waitFor("Target.targetCreated", { timeoutMs: 5_000 });
    browser.drop("the browser closed its pipe");
    await expect(waiting).rejects.toBeInstanceOf(DriverError);
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(event).rejects.toMatchObject({ code: "closed" });
    expect(connection.closed).toBe(true);
  });
});

describe("transports", () => {
  it("splits the pipe at NUL bytes, across reads and within one", () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const transport = pipeTransport(toChrome, fromChrome);
    const received: string[] = [];
    transport.onMessage((message) => received.push(message));
    fromChrome.write(Buffer.from('{"id":1,"result":{"a":"é'));
    fromChrome.write(Buffer.from('"}}\0{"id":2}\0{"id"'));
    fromChrome.write(Buffer.from(":3}\0"));
    expect(received).toEqual(['{"id":1,"result":{"a":"é"}}', '{"id":2}', '{"id":3}']);
    const written: Buffer[] = [];
    toChrome.on("data", (chunk: Buffer) => written.push(chunk));
    transport.send('{"id":4}');
    expect(Buffer.concat(written).toString()).toBe('{"id":4}\0');
  });

  it("reports the pipe closing once", () => {
    const fromChrome = new PassThrough();
    const transport = pipeTransport(new PassThrough(), fromChrome);
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));
    fromChrome.end();
    fromChrome.destroy();
    transport.onClose((reason) => reasons.push(`late: ${reason}`));
    return new Promise<void>((resolve) => setImmediate(() => {
      expect(reasons).toHaveLength(2);
      expect(reasons[1]).toMatch(/^late: /);
      resolve();
    }));
  });

  it("records each command on its way out, with its session", () => {
    const browser = fakeBrowser();
    const recorded: SentCommand[] = [];
    const connection = new CdpConnection(tracingTransport(browser.transport, (sent) => recorded.push(sent)));
    void connection.root.send("Target.getTargets");
    browser.reply({ method: "Target.attachedToTarget", params: { sessionId: "S9", targetInfo: { targetId: "T9", type: "page" } } });
    void connection.session("S9")!.send("Runtime.evaluate", { expression: "1", contextId: 3 });
    expect(recorded).toEqual([
      { method: "Target.getTargets", sessionId: null, params: {} },
      { method: "Runtime.evaluate", sessionId: "S9", params: { expression: "1", contextId: 3 } },
    ]);
  });
});
