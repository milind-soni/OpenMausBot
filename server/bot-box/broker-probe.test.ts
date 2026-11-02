import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeMcpServer } from "../mcp-probe.ts";
import type { StoredRemoteMcpServer } from "../mcp-registry.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { openCredentialBroker, type CredentialBroker } from "./broker.ts";
import { brokeredServer, brokerPath, type BrokerPath } from "./broker-probe.ts";

const HEADERS = { Authorization: "Bearer team-orders", "CF-Access-Client-Id": "5c1d0e9a.access", "CF-Access-Client-Secret": "0f9e8d7c6b5a4938271605" };

// The broker listens on a unix socket, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("testing a URL server the way a boxed turn reaches it", () => {
  let dir = "", credentials: CredentialBroker | undefined, server: FakeHttpMcp | undefined;
  afterEach(async () => {
    await credentials?.close();
    await server?.close();
    credentials = undefined; server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  async function broker(): Promise<BrokerPath> {
    dir = mkdtempSync(join(tmpdir(), "omb-broker-probe-"));
    credentials = await openCredentialBroker({ socketPath: join(dir, "b.sock") });
    return { broker: { port: 18080, mintForThread: credentials.mintForThread, revokeThread: credentials.revokeThread }, socketPath: credentials.socketPath };
  }
  const spec = (url: string): StoredRemoteMcpServer => ({ type: "http", url, headers: HEADERS, enabled: true }) as StoredRemoteMcpServer;

  it("goes through the broker, which adds the server's headers at exactly its address, and ends the grant after", async () => {
    server = await startFakeHttpMcp({ exactPath: true, tools: [{ name: "lookup_order" }], requireHeaders: HEADERS });
    const path = await broker();
    const brokered = brokeredServer(path, "orders", spec(server.url));
    expect(brokered.url, "the test's address names no header").toMatch(/^http:\/\/127\.0\.0\.1:18080\/b\/omb_t0_[a-f0-9]{48}\/mcp-orders$/);
    try {
      expect(await probeMcpServer(spec(server.url), undefined, undefined, { via: { url: brokered.url, fetch: brokered.fetch } })).toMatchObject({ ok: true, tools: [{ name: "lookup_order" }] });
    } finally {
      await brokered.done();
    }
    expect(credentials!.stats().forwarded, "every request went through the broker").toBeGreaterThanOrEqual(2);
    expect(server.seenPaths.every((seen) => seen.split("?")[0] === "/mcp")).toBe(true);
    const token = /\/b\/([^/]+)\//.exec(brokered.url)![1]!;
    expect(credentials!.lookup(token, "mcp-orders")).toMatchObject({ ok: false, error: "unknown_token" });
  });

  it("reads a server the broker can't reach as unreachable, as a direct test does", async () => {
    server = await startFakeHttpMcp({});
    const url = server.url;
    await server.close();
    server = undefined;
    const brokered = brokeredServer(await broker(), "gone", spec(url));
    try {
      expect(await probeMcpServer(spec(url), undefined, undefined, { via: { url: brokered.url, fetch: brokered.fetch } }))
        .toEqual({ ok: false, error: "Could not reach this address. Check the URL and your network.", reason: "unreachable" });
    } finally {
      await brokered.done();
    }
  });

  it("is the broker where turns are boxed, and nothing where they aren't", () => {
    const off = { broker: () => null, brokerSocket: () => null };
    expect(brokerPath(off)).toBeNull();
    const on = { broker: () => ({ port: 18080, mintForThread: () => { throw new Error("unused"); }, revokeThread: () => {} }), brokerSocket: () => "/tmp/b.sock" };
    expect(brokerPath(on)).toMatchObject({ socketPath: "/tmp/b.sock" });
  });
});
