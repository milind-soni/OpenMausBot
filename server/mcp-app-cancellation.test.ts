import { getEventListeners, once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { AppConnections, type AppClient } from "./mcp-app-connections.ts";
import { McpHttpError, McpRpcError } from "./mcp-http.ts";

const spec = { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: {} };
const freshSignal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClient() {
  const client = {
    closed: false, extensions: "ok" as const, serverInfo: { name: "fixture" },
    request: vi.fn(async (_method: string, _params: unknown, signal: AbortSignal) => {
      if (signal.aborted) throw new McpHttpError("network", "aborted");
      return { ok: true };
    }),
    close: vi.fn(async () => { client.closed = true; }),
  };
  return client;
}

async function remoteFixture(holdInitialization = false) {
  const initialization = deferred<void>();
  const releaseInitialization = deferred<void>();
  const slowCall = deferred<void>();
  const state = { initializes: 0, deletes: 0, slowResponse: undefined as ServerResponse | undefined };
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { state.deletes++; res.writeHead(200).end(); return; }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const frame = JSON.parse(body) as { id?: number; method: string; params?: { uri?: string } };
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    if (frame.method === "initialize") {
      state.initializes++;
      initialization.resolve();
      if (holdInitialization) await releaseInitialization.promise;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" }).end(JSON.stringify({
        jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } },
      }));
    } else if (frame.params?.uri === "ui://slow") {
      state.slowResponse = res;
      slowCall.resolve();
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connections = new AppConnections();
  return {
    state, initialization, releaseInitialization, slowCall, connections,
    server: { type: "http" as const, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: {} },
    async close() {
      releaseInitialization.resolve();
      connections.closeAll();
      state.slowResponse?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("MCP app request cancellation", () => {
  it("does not open a connection for an already cancelled request", async () => {
    const client = fakeClient();
    const open = vi.fn(async () => client);
    const connections = new AppConnections({ open });
    try {
      await expect(connections.request("app", spec, "resources/read", {}, AbortSignal.abort())).rejects.toThrow("aborted");
      expect(open).not.toHaveBeenCalled();
      expect(connections.size).toBe(0);
    } finally { connections.closeAll(); }
  });

  it("cancels a caller waiting for real HTTP initialization while another caller can finish", async () => {
    const fixture = await remoteFixture(true);
    const controller = new AbortController();
    const pending = fixture.connections.request("app", fixture.server, "resources/read", {}, controller.signal);
    const outcome = pending.then(() => "resolved", (error: Error) => error.message);
    let other: Promise<unknown> | undefined;
    try {
      await fixture.initialization.promise;
      other = fixture.connections.request("app", fixture.server, "resources/read", {}, freshSignal());
      controller.abort();
      expect(await Promise.race([outcome, setImmediate().then(() => "still waiting")])).toBe("aborted");
      fixture.releaseInitialization.resolve();
      await expect(other).resolves.toEqual({ ok: true });
      expect(fixture.state.initializes).toBe(1);
      expect(fixture.state.deletes).toBe(0);
      expect(fixture.connections.size).toBe(1);
    } finally {
      fixture.releaseInitialization.resolve();
      await Promise.allSettled([pending, other]);
      await fixture.close();
    }
  });

  it("keeps the real HTTP session reusable after cancelling an in-flight call", async () => {
    const fixture = await remoteFixture();
    const controller = new AbortController();
    const pending = fixture.connections.request("app", fixture.server, "resources/read", { uri: "ui://slow" }, controller.signal);
    const failed = expect(pending).rejects.toBeInstanceOf(Error);
    try {
      await fixture.slowCall.promise;
      controller.abort();
      await failed;
      await expect(fixture.connections.request("app", fixture.server, "resources/read", { uri: "ui://next" }, freshSignal())).resolves.toEqual({ ok: true });
      expect(fixture.state.initializes).toBe(1);
      expect(fixture.state.deletes).toBe(0);
      expect(fixture.connections.size).toBe(1);
    } finally { await fixture.close(); }
  });

  it("removes the opening listener after success and ignores later cancellation", async () => {
    const client = fakeClient();
    const open = vi.fn(async () => client);
    const connections = new AppConnections({ open });
    const controller = new AbortController();
    try {
      await expect(connections.request("app", spec, "resources/read", {}, controller.signal)).resolves.toEqual({ ok: true });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      controller.abort();
      await expect(connections.request("app", spec, "resources/read", {}, freshSignal())).resolves.toEqual({ ok: true });
      expect(open).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();
    } finally { connections.closeAll(); }
  });

  it("observes an opening failure after its only caller cancelled without an unhandled rejection", async () => {
    const opening = deferred<AppClient>();
    const connections = new AppConnections({ open: () => opening.promise });
    const controller = new AbortController();
    const pending = connections.request("app", spec, "resources/read", {}, controller.signal);
    const outcome = pending.then(() => "resolved", (error: Error) => error.message);
    try {
      controller.abort();
      expect(await Promise.race([outcome, setImmediate().then(() => "still waiting")])).toBe("aborted");
      opening.reject(new Error("handshake failed"));
      await setImmediate();
      expect(connections.size).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      opening.reject(new Error("fixture cleanup"));
      await pending.catch(() => {});
      connections.closeAll();
    }
  });

  it("preserves JSON-RPC failures without closing the connection", async () => {
    const client = fakeClient();
    const error = new McpRpcError(-32602, "invalid params");
    client.request.mockRejectedValueOnce(error);
    const connections = new AppConnections({ open: async () => client });
    try {
      await expect(connections.request("app", spec, "resources/read", {}, freshSignal())).rejects.toBe(error);
      expect(client.close).not.toHaveBeenCalled();
      await expect(connections.request("app", spec, "resources/read", {}, freshSignal())).resolves.toEqual({ ok: true });
    } finally { connections.closeAll(); }
  });

  it("still retires transport failures and opens a replacement", async () => {
    const first = fakeClient();
    const second = fakeClient();
    first.request.mockRejectedValueOnce(new McpHttpError("network", "disconnected"));
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const connections = new AppConnections({ open });
    try {
      await expect(connections.request("app", spec, "resources/read", {}, freshSignal())).rejects.toThrow("disconnected");
      expect(first.close).toHaveBeenCalledTimes(1);
      await expect(connections.request("app", spec, "resources/read", {}, freshSignal())).resolves.toEqual({ ok: true });
      expect(open).toHaveBeenCalledTimes(2);
    } finally { connections.closeAll(); }
  });

  it("removes the listener and permits retry when initialization fails", async () => {
    const error = new Error("handshake failed");
    const open = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(fakeClient());
    const connections = new AppConnections({ open });
    const signal = freshSignal();
    try {
      await expect(connections.request("app", spec, "resources/read", {}, signal)).rejects.toBe(error);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
      expect(connections.size).toBe(0);
      await expect(connections.request("app", spec, "resources/read", {}, freshSignal())).resolves.toEqual({ ok: true });
      expect(open).toHaveBeenCalledTimes(2);
    } finally { connections.closeAll(); }
  });
});
