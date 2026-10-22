import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOX_BROKER_PORT, type BoxBroker } from "./box.ts";
import { brokerRemoteMcp, forgetBrokeredMcp, mcpGrantName } from "./broker-mcp.ts";
import { openCredentialBroker, type CredentialBroker } from "./broker.ts";

const custom = {
  notion: { type: "http" as const, url: "https://mcp.notion.example/mcp", headers: { authorization: "Bearer notion-secret" } },
  files: { command: "npx", args: ["files-mcp"], env: { FILES_TOKEN: "stdio-secret" } },
};

describe("remote MCP servers through the broker", () => {
  let dir: string, credentials: CredentialBroker;
  afterEach(async () => { await credentials?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); forgetBrokeredMcp(); });
  // The broker listens on a unix socket, which Windows refuses at a file path; the box runs only on a Linux Cloud home
  // (detect.ts says "not-linux" anywhere else), so Windows gets "off" below.
  const withBroker = it.skipIf(process.platform === "win32");
  const broker = async (): Promise<BoxBroker> => {
    dir = mkdtempSync(join(tmpdir(), "omb-bmcp-"));
    credentials = await openCredentialBroker({ socketPath: join(dir, "b.sock") });
    return { port: BOX_BROKER_PORT, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revokeThread: credentials.revokeThread, lookup: credentials.lookup };
  };

  withBroker("moves a URL server's headers to the broker and leaves stdio servers alone", async () => {
    const out = brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, await broker());
    expect(out.files).toEqual(custom.files);
    const notion = out.notion as { type: string; url: string; headers: Record<string, string> };
    expect(notion.type).toBe("http");
    expect(notion.headers).toEqual({});
    const match = /^http:\/\/127\.0\.0\.1:18080\/b\/(omb_t0_[a-f0-9]{48})\/mcp-notion$/.exec(notion.url);
    expect(match).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain("notion-secret");
    expect(credentials.lookup(match![1]!, "mcp-notion")).toMatchObject({ ok: true, botId: "b1", threadId: "t1", grant: { upstream: "https://mcp.notion.example/mcp", headers: { authorization: "Bearer notion-secret" } } });
    expect(credentials.lookup(match![1]!, "mcp-files").ok).toBe(false);
  });

  withBroker("the same conversation keeps its token across turns; another conversation or changed headers get a new one", async () => {
    const b = await broker();
    const url = (servers: Record<string, unknown>) => (servers.notion as { url: string }).url;
    const first = url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b));
    expect(url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, b))).toBe(first);
    expect(url(brokerRemoteMcp(custom, { botId: "b1", threadId: "t2" }, b))).not.toBe(first);
    const changed = { ...custom, notion: { ...custom.notion, headers: { authorization: "Bearer rotated" } } };
    expect(url(brokerRemoteMcp(changed, { botId: "b1", threadId: "t1" }, b))).not.toBe(first);
    credentials.revokeThread("t1");
    expect(url(brokerRemoteMcp(changed, { botId: "b1", threadId: "t1" }, b))).not.toBe(first);
    expect(credentials.stats().tokens).toBe(2);
  });

  it("off: the servers come back untouched", () => {
    expect(brokerRemoteMcp(custom, { botId: "b1", threadId: "t1" }, null)).toBe(custom);
    expect(mcpGrantName("My Server!")).toBe("mcp-my-server-");
  });
});
