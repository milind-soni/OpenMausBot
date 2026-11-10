import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_REMOTE_MCP_BYTES } from "./mcp-http.ts";
import { probeMcpServer, SIGN_IN_CHECK_TOOL } from "./mcp-probe.ts";
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

const spawned = vi.hoisted(() => [] as Array<{ opts: { cwd?: unknown; box?: unknown } }>);
vi.mock("./procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => { spawned.push({ opts: args[2] }); return actual.spawnCli(...args); } };
});

const fakeServer = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

/** Bounded by real time, not a count of turns: a loaded CI runner can need far more turns for the same round trips. */
async function untilReal(condition: () => boolean, limitMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!condition() && Date.now() - started < limitMs) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

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

  it("starts a command as a bot's turn would: in the box, its configured environment vouched for, and from the bot's folder when it is one bot's", async () => {
    const server = { command: process.execPath, args: ["--experimental-strip-types", fakeServer], env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_synthetic" }, enabled: false };
    const opts = async (options: Parameters<typeof probeMcpServer>[3]) => {
      spawned.length = 0;
      await expect(probeMcpServer(server, 5_000, undefined, options)).resolves.toMatchObject({ ok: true });
      return spawned[0]!.opts;
    };
    const anyBot = await opts({ asBot: {} });
    expect(anyBot.box).toEqual({ allowEnv: ["OP_SERVICE_ACCOUNT_TOKEN"] });
    expect(anyBot).not.toHaveProperty("cwd");
    const folder = mkdtempSync(join(tmpdir(), "omb-probe-bot-"));
    try {
      expect(await opts({ asBot: { id: "ada", cwd: folder } })).toMatchObject({ cwd: folder, box: { botId: "ada", allowEnv: ["OP_SERVICE_ACCOUNT_TOKEN"] } });
    } finally { await removeTempDir(folder); }
    const plain = await opts({});
    expect(plain).not.toHaveProperty("box");
    expect(plain.cwd).toBe(process.cwd());
  });

  it("times out a server that never completes initialization", async () => {
    await expect(probeMcpServer({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      env: { FAKE_MCP_MODE: "silent" },
      enabled: false,
    }, 100)).resolves.toEqual({ ok: false, error: "The server did not answer in time.", reason: "timeout" });
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
    expect(probe.value).toEqual({ ok: false, error: "The server did not answer in time.", reason: "timeout" });
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

  it("says the keys were refused, with the status, on a 401 or 403 that offers no sign-in, never echoing a value", async () => {
    const fake = await startFakeHttpMcp({ requireHeader: { name: "Authorization", value: "Bearer right" } });
    const gateway = await startFakeHttpMcp({ requireHeaders: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "right" } });
    try {
      const result = await probeMcpServer({ type: "http", url: fake.url, headers: { Authorization: "Bearer wrong-token" }, enabled: false }, 2_000);
      expect(result).toEqual({ ok: false, error: "The server didn't accept the keys (HTTP 401). Check the header values.", reason: "keys", status: 401 });
      expect(JSON.stringify(result)).not.toContain("wrong-token");
      const gated = await probeMcpServer({ type: "http", url: gateway.url, headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "wrong-secret" }, enabled: false }, 2_000);
      expect(gated).toEqual({ ok: false, error: "The server didn't accept the keys (HTTP 403). Check the header values.", reason: "keys", status: 403 });
      expect(JSON.stringify(gated)).not.toContain("wrong-secret");
    } finally {
      await fake.close();
      await gateway.close();
    }
  });

  it("says the keys were refused when a server answers an MCP unauthorized error with HTTP 200", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; }).on("end", () => {
        const id = (JSON.parse(body) as { id?: unknown }).id;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "Unauthorized: invalid API key" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      await expect(probeMcpServer({ type: "http", url, headers: { "X-Api-Key": "k" }, enabled: false }, 2_000))
        .resolves.toEqual({ ok: false, error: "The server didn't accept the keys. Check the header values.", reason: "keys" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
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

  describe("a server that lists tools before anyone signs in", () => {
    const buy = { name: "buy", description: "Buy something" };
    const anonymous = (url: string) => ({ type: "http" as const, url, headers: {}, enabled: false });
    const protectedResource = (issuer: string) => ({ resource: "unused", authorization_servers: [issuer] });
    const openidOnly = (origin: string) => ({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      code_challenge_methods_supported: ["S256"],
    });

    it("needs a sign-in when it refuses tool calls behind a protected-resource document, and runs no real tool", async () => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({ guard: "tools/call", acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools: [buy] });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000))
          .resolves.toEqual({ ok: false, auth: "required", error: "This server needs you to sign in." });
        expect(fake.refusedCalls).toEqual([{ name: SIGN_IN_CHECK_TOOL, arguments: {} }]);
        expect(fake.calls).toEqual([]);
      } finally {
        await fake.close();
        await oauth.close();
      }
    });

    describe("a server that answers an unknown tool before it asks who is calling, as Gmail's MCP server does", () => {
      const read = { name: "get_thread", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", required: ["threadId"] } };
      const asked = { tryReadOnlyTool: true };

      it("needs a sign-in, found with one read-only tool that has nothing to work on, and nothing runs", async () => {
        const oauth = await startFakeOAuth();
        const fake = await startFakeHttpMcp({ guard: "listed-tools", acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools: [buy, read] });
        try {
          await expect(probeMcpServer(anonymous(fake.url), 8_000, undefined, asked))
            .resolves.toEqual({ ok: false, auth: "required", error: "This server needs you to sign in." });
          expect(fake.refusedCalls).toEqual([{ name: "get_thread", arguments: {} }]);
          expect(fake.calls).toEqual([]);
        } finally {
          await fake.close();
          await oauth.close();
        }
      });

      it("calls no real tool in a check nobody asked for", async () => {
        const oauth = await startFakeOAuth();
        const fake = await startFakeHttpMcp({ guard: "listed-tools", acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools: [read] });
        try {
          await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toMatchObject({ ok: true });
          expect(fake.refusedCalls).toEqual([]);
        } finally {
          await fake.close();
          await oauth.close();
        }
      });

      it.each([
        ["not marked read-only", { name: "trash", inputSchema: { type: "object", required: ["id"] } }],
        ["marked read-only and destructive", { name: "purge", annotations: { readOnlyHint: true, destructiveHint: true }, inputSchema: { type: "object", required: ["id"] } }],
        ["read-only but able to run with no arguments", { name: "list_labels", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }],
      ])("never calls a tool %s", async (_label, tool) => {
        const oauth = await startFakeOAuth();
        const fake = await startFakeHttpMcp({ guard: "listed-tools", acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools: [tool] });
        try {
          await expect(probeMcpServer(anonymous(fake.url), 8_000, undefined, asked)).resolves.toMatchObject({ ok: true });
          expect(fake.refusedCalls).toEqual([]);
          expect(fake.calls).toEqual([]);
        } finally {
          await fake.close();
          await oauth.close();
        }
      });

      it("stays connected when sign-in is optional and the read-only tool only complains about its arguments", async () => {
        const oauth = await startFakeOAuth();
        const fake = await startFakeHttpMcp({
          tools: [read],
          wellKnown: { "/.well-known/oauth-protected-resource/mcp": protectedResource(oauth.issuer) },
          callError: (params) => ({ code: -32602, message: `Bad arguments for ${(params as { name: string }).name}` }),
        });
        try {
          await expect(probeMcpServer(anonymous(fake.url), 8_000, undefined, asked)).resolves.toMatchObject({ ok: true });
        } finally {
          await fake.close();
          await oauth.close();
        }
      });
    });

    it("finds the protected-resource document without a www-authenticate hint", async () => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({
        guard: "tools/call", acceptBearer: oauth.isValid, tools: [buy],
        wellKnown: { "/.well-known/oauth-protected-resource/mcp": protectedResource(oauth.issuer) },
      });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toMatchObject({ ok: false, auth: "required" });
      } finally {
        await fake.close();
        await oauth.close();
      }
    });

    it("is not flagged at the call stage by a host that only serves openid-configuration", async () => {
      const fake = await startFakeHttpMcp({
        guard: "tools/call", acceptBearer: () => false, tools: [buy],
        wellKnown: { "/.well-known/openid-configuration": openidOnly },
      });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toEqual({ ok: true, tools: [buy] });
      } finally {
        await fake.close();
      }
    });

    it("still asks for a sign-in when that same host refuses initialize", async () => {
      const fake = await startFakeHttpMcp({
        guard: "every-request", acceptBearer: () => false, tools: [buy],
        wellKnown: { "/.well-known/openid-configuration": openidOnly },
      });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toMatchObject({ ok: false, auth: "required" });
      } finally {
        await fake.close();
      }
    });

    it("stays connected when sign-in is optional and the unknown tool is a JSON-RPC error", async () => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({
        tools: [buy],
        wellKnown: { "/.well-known/oauth-protected-resource/mcp": protectedResource(oauth.issuer) },
        callError: () => ({ code: -32602, message: `Tool ${SIGN_IN_CHECK_TOOL} not found` }),
      });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toEqual({ ok: true, tools: [buy] });
      } finally {
        await fake.close();
        await oauth.close();
      }
    });

    it.each([
      ["a Bearer", { Authorization: "Bearer valid" }],
      ["an API key", { "X-Api-Key": "k" }],
    ])("sends no check and looks up no sign-in when the probe carries %s", async (_label, headers) => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({
        guard: "tools/call", acceptBearer: (authorization) => authorization === "Bearer valid", wwwAuthenticate: oauth.challenge, tools: [buy],
      });
      try {
        await expect(probeMcpServer({ type: "http", url: fake.url, headers, enabled: false }, 8_000)).resolves.toEqual({ ok: true, tools: [buy] });
        expect(fake.refusedCalls).toEqual([]);
        expect(fake.calls).toEqual([]);
        expect(fake.seenPaths.filter((path) => path.startsWith("/.well-known/"))).toEqual([]);
      } finally {
        await fake.close();
        await oauth.close();
      }
    });

    it("counts an empty header value as no credentials", async () => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({ guard: "tools/call", acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools: [buy] });
      try {
        await expect(probeMcpServer({ type: "http", url: fake.url, headers: { Authorization: "" }, enabled: false }, 8_000))
          .resolves.toMatchObject({ ok: false, auth: "required" });
      } finally {
        await fake.close();
        await oauth.close();
      }
    });

    it("stays connected when the check is held past its bound", async () => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({ tools: [buy], callDelayMs: 8_000, wwwAuthenticate: oauth.challenge });
      try {
        const started = Date.now();
        await expect(probeMcpServer(anonymous(fake.url), 30_000)).resolves.toEqual({ ok: true, tools: [buy] });
        expect(Date.now() - started).toBeLessThan(7_000);
      } finally {
        await fake.close();
        await oauth.close();
      }
    }, 15_000);

    it("stays connected when a gateway answers the check with 403", async () => {
      const fake = await startFakeHttpMcp({ guard: "tools/call", requireHeaders: { "x-gate": "open" }, tools: [buy] });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toEqual({ ok: true, tools: [buy] });
      } finally {
        await fake.close();
      }
    });

    it("stays connected when the server answers the check with HTTP 400", async () => {
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; }).on("end", () => {
          const frame = JSON.parse(body || "{}") as { id?: unknown; method?: string };
          if (frame.method === "tools/call") return void res.writeHead(400).end("bad request");
          if (frame.method === undefined) return void res.writeHead(202).end();
          const result = frame.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "raw", version: "1" } }
            : { tools: [buy] };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await expect(probeMcpServer(anonymous(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), 8_000))
          .resolves.toEqual({ ok: true, tools: [buy] });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("never calls a tool the server really lists under the check's name", async () => {
      const oauth = await startFakeOAuth();
      const fake = await startFakeHttpMcp({
        guard: "tools/call", acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge, tools: [buy, { name: SIGN_IN_CHECK_TOOL }],
      });
      try {
        await expect(probeMcpServer(anonymous(fake.url), 8_000)).resolves.toMatchObject({ ok: true });
        expect(fake.refusedCalls).toEqual([]);
        expect(fake.calls).toEqual([]);
      } finally {
        await fake.close();
        await oauth.close();
      }
    });
  });

  it("times out a server that never lists its tools", async () => {
    const fake = await startFakeHttpMcp({ silentTools: true });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }, 300))
        .resolves.toEqual({ ok: false, error: "The server did not answer in time.", reason: "timeout" });
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
      expect(probe.value).toEqual({ ok: false, error: "The server did not answer in time.", reason: "timeout" });
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
      .resolves.toEqual({ ok: false, error: "Could not reach this address. Check the URL and your network.", reason: "unreachable" });
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
