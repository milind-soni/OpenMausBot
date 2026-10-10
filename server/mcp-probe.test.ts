import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_REMOTE_MCP_BYTES } from "./mcp-http.ts";
import { probeMcpServer } from "./mcp-probe.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth } from "./testing/fake-oauth-server.ts";
import { whopLikeCatalog } from "./testing/whop-like-catalog.ts";

/** 425 tools in about the 1,207,608 bytes Whop's real tools/list measured. */
function whopSizedCatalog() {
  const base = JSON.stringify(whopLikeCatalog(425)).length;
  const tools = whopLikeCatalog(425, Math.ceil((1_207_608 - base) / 425) - 1);
  const bytes = Buffer.byteLength(JSON.stringify(tools));
  expect(bytes).toBeGreaterThan(1_048_576);
  expect(bytes).toBeLessThan(1_300_000);
  return tools;
}

const fakeServer = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

/** Let real I/O (sockets, child pipes) run while timers are faked. Bounded
 * by real time, not a count of turns: a loaded CI runner can need far more
 * turns for the same round trips (Date is not faked here). */
async function untilReal(condition: () => boolean, limitMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!condition() && Date.now() - started < limitMs) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

/** Settles `pending` into a readable state without awaiting it. */
function watch<T>(pending: Promise<T>): { done: boolean; value?: T } {
  const state: { done: boolean; value?: T } = { done: false };
  void pending.then((value) => { state.done = true; state.value = value; });
  return state;
}

afterEach(() => { vi.useRealTimers(); });

describe("custom MCP probe", () => {
  it("performs an MCP handshake and returns the bounded public tool list", async () => {
    await expect(probeMcpServer({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      env: {},
      enabled: false,
    }, 2_000)).resolves.toEqual({
      ok: true,
      tools: [{ name: "read_notes", description: "Read saved notes" }],
    });
  });

  it("times out a server that never completes initialization", async () => {
    await expect(probeMcpServer({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      env: { FAKE_MCP_MODE: "silent" },
      enabled: false,
    }, 100)).resolves.toEqual({ ok: false, error: "The server did not answer in time." });
  });

  it("lists a command's Whop-sized catalog and says how many tools it has", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-probe-big-"));
    try {
      const file = join(dir, "tools.json");
      writeFileSync(file, JSON.stringify(whopSizedCatalog()));
      const result = await probeMcpServer({
        command: process.execPath, args: ["--experimental-strip-types", fakeServer], env: { FAKE_MCP_TOOLS_FILE: file }, enabled: false,
      }, 15_000);
      expect(result).toMatchObject({ ok: true, total: 425 });
      expect(result.ok && result.tools).toHaveLength(100);
    } finally { await removeTempDir(dir); }
  });

  it("gives a command 8 seconds by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const probe = watch(probeMcpServer({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      env: { FAKE_MCP_MODE: "silent" },
      enabled: false,
    }));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(probe.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await untilReal(() => probe.done);
    expect(probe.value).toEqual({ ok: false, error: "The server did not answer in time." });
  });

  it("stops a probe when its caller disconnects", async () => {
    const controller = new AbortController();
    const pending = probeMcpServer({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      env: { FAKE_MCP_MODE: "silent" },
      enabled: false,
    }, 2_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: "Connection test was cancelled." });
  });

  it("does not expose native spawn details", async () => {
    const result = await probeMcpServer({
      command: "/definitely/missing/openmaus-mcp",
      args: [],
      env: { SECRET_TOKEN: "never-render-this" },
      enabled: false,
    }, 100);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(result)).not.toContain("never-render-this");
    expect(JSON.stringify(result)).not.toContain("/definitely/missing");
  });

  it("redacts a configured value even if a server echoes it in tool metadata", async () => {
    const result = await probeMcpServer({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      env: { FAKE_MCP_DESCRIPTION: "token=very-secret-value" },
      enabled: false,
    }, 2_000);
    expect(result).toEqual({
      ok: true,
      tools: [{ name: "read_notes", description: "[redacted]" }],
    });
    expect(JSON.stringify(result)).not.toContain("very-secret-value");
  });
});

describe("remote MCP probe", () => {
  const tools = [{ name: "read_notes", description: "Read saved notes" }];

  it("connects over streamable HTTP, sends the headers, and lists tools", async () => {
    const fake = await startFakeHttpMcp({ requireHeader: { name: "Authorization", value: "Bearer tok-docs" } });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: { Authorization: "Bearer tok-docs" }, enabled: false }, 2_000))
        .resolves.toEqual({ ok: true, tools });
      expect(fake.seenHeaders[0]?.authorization).toBe("Bearer tok-docs");
      // the handshake is complete before the tools are asked for
      expect(fake.seenHeaders.length).toBeGreaterThanOrEqual(3);
    } finally {
      await fake.close();
    }
  });

  it("reads a tools list the server streams back as events", async () => {
    const fake = await startFakeHttpMcp({ answer: "event-stream" });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }, 2_000)).resolves.toEqual({ ok: true, tools });
    } finally {
      await fake.close();
    }
  });

  it("speaks the older SSE transport", async () => {
    const fake = await startFakeHttpMcp({ transport: "sse" });
    try {
      await expect(probeMcpServer({ type: "sse", url: fake.url, headers: {}, enabled: false }, 2_000)).resolves.toEqual({ ok: true, tools });
    } finally {
      await fake.close();
    }
  });

  it("reports the status of a refusal without echoing the header value", async () => {
    const fake = await startFakeHttpMcp({ requireHeader: { name: "Authorization", value: "Bearer right" } });
    try {
      const result = await probeMcpServer({ type: "http", url: fake.url, headers: { Authorization: "Bearer wrong-token" }, enabled: false }, 2_000);
      expect(result).toEqual({ ok: false, error: "The server answered HTTP 401. Check the address and headers." });
      expect(JSON.stringify(result)).not.toContain("wrong-token");
    } finally {
      await fake.close();
    }
  });

  it("says a server needs sign-in when its 401 points at an OAuth server", async () => {
    const oauth = await startFakeOAuth();
    const fake = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
    try {
      const started = Date.now();
      const result = await probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }, 8_000);
      expect(result).toEqual({ ok: false, auth: "required", error: "This server needs you to sign in." });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await fake.close();
      await oauth.close();
    }
  });

  it("times out a server that never lists its tools", async () => {
    const fake = await startFakeHttpMcp({ silentTools: true });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }, 300))
        .resolves.toEqual({ ok: false, error: "The server did not answer in time." });
    } finally {
      await fake.close();
    }
  });

  it("waits for a URL server that takes 10 seconds to list its tools", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = await startFakeHttpMcp({ toolsDelayMs: 10_000 });
    try {
      const probe = watch(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }));
      await untilReal(() => fake.delayedToolsLists === 1);
      // well past the 8 seconds a command gets
      await vi.advanceTimersByTimeAsync(10_000);
      await untilReal(() => probe.done);
      expect(probe.value).toEqual({ ok: true, tools });
    } finally {
      await fake.close();
    }
  });

  it("gives a URL server 30 seconds by default, then says it did not answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = await startFakeHttpMcp({ silentTools: true });
    try {
      const probe = watch(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }));
      await untilReal(() => fake.seenHeaders.length >= 3);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(probe.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await untilReal(() => probe.done);
      expect(probe.value).toEqual({ ok: false, error: "The server did not answer in time." });
    } finally {
      await fake.close();
    }
  });

  it("stops a URL probe when its caller disconnects", async () => {
    const fake = await startFakeHttpMcp({ silentTools: true });
    try {
      const controller = new AbortController();
      const pending = probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }, undefined, controller.signal);
      await untilReal(() => fake.seenHeaders.length >= 3);
      controller.abort();
      await expect(pending).resolves.toEqual({ ok: false, error: "Connection test was cancelled." });
    } finally {
      await fake.close();
    }
  });

  it("accepts Whop's 1.2 MB tools list and says how many tools it has", async () => {
    const fake = await startFakeHttpMcp({ tools: whopSizedCatalog() });
    try {
      const result = await probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false });
      expect(result).toMatchObject({ ok: true, total: 425 });
      expect(result.ok && result.tools.slice(0, 2).map((tool) => tool.name)).toEqual(["stats_get", "payments_list_refunded"]);
      expect(result.ok && result.tools).toHaveLength(100);
    } finally {
      await fake.close();
    }
  });

  it("still refuses a tools list past the 32 MB cap", async () => {
    const fake = await startFakeHttpMcp({ tools: [{ name: "absurd", description: "x".repeat(MAX_REMOTE_MCP_BYTES + 1), inputSchema: { type: "object" } }] });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }))
        .resolves.toEqual({ ok: false, error: "The server did not return a valid MCP tools list." });
    } finally {
      await fake.close();
    }
  });

  it("says when the address cannot be reached", async () => {
    await expect(probeMcpServer({ type: "http", url: "http://127.0.0.1:9/mcp", headers: {}, enabled: false }, 2_000))
      .resolves.toEqual({ ok: false, error: "Could not reach this address. Check the URL and your network." });
  });

  it("redacts a header value a server echoes in tool metadata", async () => {
    const fake = await startFakeHttpMcp({ description: "token=very-secret-value" });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: { "X-Token": "very-secret-value" }, enabled: false }, 2_000))
        .resolves.toEqual({ ok: true, tools: [{ name: "read_notes", description: "token=[redacted]" }] });
    } finally {
      await fake.close();
    }
  });
});
