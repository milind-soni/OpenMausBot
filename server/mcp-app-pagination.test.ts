import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { AppConnections } from "./mcp-app-connections.ts";
import { McpRpcError } from "./mcp-http.ts";

const managers: AppConnections[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function catalog(page: (cursor: string | undefined) => unknown) {
  const cursors: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(204).end(); return; }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const frame = JSON.parse(body) as { id?: number; method: string; params?: { cursor?: string } };
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "catalog-fixture", version: "1" } };
    if (frame.method === "tools/list") {
      cursors.push(frame.params?.cursor);
      result = page(frame.params?.cursor);
    }
    const response = result instanceof McpRpcError
      ? { error: { code: result.code, message: result.detail } }
      : { result };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...response }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const observed: unknown[] = [];
  const manager = new AppConnections({ onTools: (_name, _spec, tools) => observed.push(tools) });
  managers.push(manager);
  const spec = { type: "http" as const, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: {} };
  return { cursors, observed, tools: () => manager.tools("fixture", spec, AbortSignal.timeout(5_000)) };
}

describe("MCP app catalog cursors", () => {
  it("continues an empty first page with an empty cursor and caches the complete catalog", async () => {
    const tool = { name: "available_after_cursor", inputSchema: { type: "object" } };
    const fixture = await catalog((cursor) => cursor === undefined ? { tools: [], nextCursor: "" } : { tools: [tool] });
    const result = await fixture.tools();
    expect(result).toEqual([tool]);
    expect(fixture.cursors).toEqual([undefined, ""]);
    expect(fixture.observed).toEqual([[tool]]);
    expect(await fixture.tools()).toBe(result);
    expect(fixture.cursors).toHaveLength(2);
  });

  it("continues through an empty middle page without interpreting either cursor", async () => {
    const fixture = await catalog((cursor) => cursor === undefined
      ? { tools: [{ name: "first" }], nextCursor: "opaque:/?=a+b 雪" }
      : cursor === "" ? { tools: [{ name: "last" }] } : { tools: [], nextCursor: "" });
    expect(await fixture.tools()).toEqual([{ name: "first" }, { name: "last" }]);
    expect(fixture.cursors).toEqual([undefined, "opaque:/?=a+b 雪", ""]);
  });

  it("propagates an error after an empty cursor and retries instead of caching a partial list", async () => {
    let failures = 0;
    const fixture = await catalog((cursor) => {
      if (cursor === undefined) return { tools: [{ name: "first" }], nextCursor: "" };
      if (failures++ === 0) return new McpRpcError(-32603, "continuation failed");
      return { tools: [{ name: "last" }] };
    });
    await expect(fixture.tools()).rejects.toThrow("continuation failed");
    expect(fixture.observed).toEqual([]);
    expect(await fixture.tools()).toEqual([{ name: "first" }, { name: "last" }]);
    expect(fixture.cursors).toEqual([undefined, "", undefined, ""]);
  });

  it("passes an empty cursor through the real command-server connection", async () => {
    const source = `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const frame=JSON.parse(line);
        if(frame.id===undefined) return;
        const result=frame.method==='initialize'
          ? {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'stdio-fixture',version:'1'}}
          : frame.params?.cursor===undefined
            ? {tools:[],nextCursor:''}
            : {tools:[{name:frame.params.cursor===''?'correct_empty_cursor':'wrong_cursor'}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result})+'\\n');
      });`;
    const manager = new AppConnections();
    managers.push(manager);
    const tools = await manager.tools("fixture", { command: process.execPath, args: ["-e", source], env: {} }, AbortSignal.timeout(5_000));
    expect(tools).toEqual([{ name: "correct_empty_cursor" }]);
  });

  it("keeps ordinary pagination and its repeated-cursor bound", async () => {
    const fixture = await catalog((cursor) => ({ tools: [{ name: cursor === undefined ? "first" : "last" }], nextCursor: "repeat" }));
    expect(await fixture.tools()).toEqual([{ name: "first" }, { name: "last" }]);
    expect(fixture.cursors).toEqual([undefined, "repeat"]);
  });

  it("stops at an omitted cursor even when the page is empty", async () => {
    const fixture = await catalog(() => ({ tools: [] }));
    expect(await fixture.tools()).toEqual([]);
    expect(fixture.cursors).toEqual([undefined]);
    expect(fixture.observed).toEqual([[]]);
  });

  it("preserves the 100-page bound for an unending catalog", async () => {
    let page = 0;
    const fixture = await catalog(() => ({ tools: [{ name: String(page) }], nextCursor: String(++page) }));
    expect(await fixture.tools()).toHaveLength(100);
    expect(fixture.cursors).toHaveLength(100);
  });
});
