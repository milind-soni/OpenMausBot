import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { probeMcpServer } from "./mcp-probe.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

const fakeServer = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

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

  it("times out a server that never lists its tools", async () => {
    const fake = await startFakeHttpMcp({ silentTools: true });
    try {
      await expect(probeMcpServer({ type: "http", url: fake.url, headers: {}, enabled: false }, 300))
        .resolves.toEqual({ ok: false, error: "The server did not answer in time." });
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
