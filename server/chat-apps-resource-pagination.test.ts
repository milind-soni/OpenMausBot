import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { APP_MIME, type AppDocument, type AppPayload } from "../shared/app.ts";
import { createChatApps } from "./chat-apps.ts";
import { createChatAppsMcp, type ChatAppsMcpStore } from "./chat-apps-mcp.ts";
import type { BotRecord, Message } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type Json = Record<string, unknown>;
const URI = "ui://catalog/board.html";
const UI = { prefersBorder: false, csp: { connectDomains: ["https://api.board.example"], resourceDomains: ["https://cdn.board.example", "https://bad.example/path"] } };
const entry = { uri: URI, name: "Board", mimeType: APP_MIME, _meta: { ui: UI } };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function fixture(page: (params: Json, index: number) => Json, readUi?: Json) {
  const params: Json[] = [];
  let reads = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const frame = JSON.parse(raw) as { id?: number; method: string; params?: Json };
    if (frame.id === undefined) { response.writeHead(202).end(); return; }
    let result: Json;
    if (frame.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { resources: {} }, serverInfo: { name: "catalog-fixture", version: "1" } };
    else if (frame.method === "resources/read") {
      reads += 1;
      result = { contents: [{ uri: URI, mimeType: APP_MIME, text: "<h1>Catalog board</h1>", ...(readUi ? { _meta: { ui: readUi } } : {}) }] };
    } else if (frame.method === "resources/list") {
      params.push(frame.params ?? {});
      result = page(frame.params ?? {}, params.length - 1);
    } else result = {};
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...(result.error ? { error: result.error } : { result }) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const spec = { type: "http" as const, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, headers: {} };
  const dataDir = mkdtempSync(join(tmpdir(), "omb-resource-pages-"));
  cleanup.push(() => removeTempDir(dataDir));
  const rows: Message[] = [];
  const bot = { id: "bot-board", name: "Board", color: "blue", threadId: "thread-board", approvalMode: "ask" } as unknown as BotRecord;
  const store = {
    bot: () => bot, botByThread: () => bot, groupByThread: () => undefined,
    messagesFor: () => rows, projectBotForTask: () => bot,
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      const row = { ...message, id: `m${rows.length + 1}`, at: 1 } as Message;
      rows.push(row);
      return row;
    },
    patchMessage: () => null,
  } as ChatAppsMcpStore;
  const apps = createChatApps({ store: store as never, dataDir, sweeps: false, references: () => [] });
  const mcp = createChatAppsMcp({
    store, apps, storedServers: () => ({ board: { ...spec, enabled: true } }), mountedServers: () => ({ board: spec }),
    oauth: { authState: () => "none", accessToken: async () => null, requireSignIn: () => {} }, startupProbes: false, log: () => {},
  });
  cleanup.push(() => { mcp.close(); apps.close(); });
  const request = vi.spyOn(mcp.connections, "request");
  const record = async () => {
    const id = `m${rows.length + 1}`;
    expect(await mcp.recordMcpAppCall({ bot, threadId: bot.threadId, input: {
      server: "board", definition: { name: "show_board", _meta: { ui: { resourceUri: URI } } },
      call: { arguments: {} }, result: { content: [{ type: "text", text: "Board ready" }] },
    } })).toEqual({ ok: true, messageId: id });
    const row = rows.at(-1)! as Message & { app: AppPayload };
    const doc = apps.appDocument(bot.threadId, id)!;
    expect(doc.srcdoc).toContain("<h1>Catalog board</h1>");
    expect(row.app.blocked).toBeUndefined();
    return { app: row.app, doc };
  };
  return { record, params, request, reads: () => reads };
}

function expectMetadata({ app, doc }: { app: AppPayload; doc: AppDocument }) {
  expect(app.border).toBe(false);
  expect(app.network).toEqual({ connect: ["https://api.board.example"], resources: ["https://cdn.board.example"], refused: ["https://bad.example/path"] });
  expect(doc.csp).toContain("connect-src https://api.board.example");
  expect(doc.csp).toContain("https://cdn.board.example");
  expect(doc.csp).not.toContain("https://bad.example");
}

it.each(["next page+/=🦊", ""])("finds app metadata after an opaque %j cursor over real HTTP", async (cursor) => {
  const f = await fixture((_params, index) => index === 0 ? { resources: [{ uri: "ui://other/page.html" }], nextCursor: cursor } : { resources: [entry] });
  expectMetadata(await f.record());
  expect(f.params).toEqual([{}, { cursor }]);
});

it("searches through empty pages, ignores other resources' metadata, and shares one deadline", async () => {
  const f = await fixture((_params, index) => index === 0 ? { resources: [], nextCursor: "one" } : index === 1 ? { resources: [{ ...entry, uri: "ui://other/page.html" }], nextCursor: "two" } : { resources: [entry] });
  expectMetadata(await f.record());
  expect(f.params).toEqual([{}, { cursor: "one" }, { cursor: "two" }]);
  const signals = f.request.mock.calls.filter((call) => call[2] === "resources/list").map((call) => call[4]);
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal === signals[0])).toBe(true);
});

it("stops at a matching first-page resource and reuses the successful resource cache", async () => {
  const f = await fixture(() => ({ resources: [entry], nextCursor: "unused" }));
  expectMetadata(await f.record());
  expectMetadata(await f.record());
  expect(f.params).toEqual([{}]);
  expect(f.reads()).toBe(1);
});

it("keeps metadata from resources/read authoritative without listing", async () => {
  const f = await fixture(() => ({ resources: [] }), UI);
  expectMetadata(await f.record());
  expect(f.params).toEqual([]);
});

it.each([
  { resources: [{ ...entry, uri: "ui://other/page.html" }] },
  { resources: "malformed", nextCursor: "ignored" },
  { error: { code: -32601, message: "Listing unsupported" } },
])("keeps the readable document with default restrictions when listing returns %j", async (page) => {
  const f = await fixture(() => page);
  const { app, doc } = await f.record();
  expect(app.border).toBe(true);
  expect(app.network).toEqual({ connect: [], resources: [] });
  expect(doc.csp).toContain("connect-src 'none'");
  expect(f.params).toEqual([{}]);
});

it("terminates a repeated cursor without discarding the readable page", async () => {
  const f = await fixture(() => ({ resources: [], nextCursor: "repeat" }));
  expect((await f.record()).app.network).toEqual({ connect: [], resources: [] });
  expect(f.params).toEqual([{}, { cursor: "repeat" }]);
});

it("caps an unending sequence of distinct cursors", async () => {
  const f = await fixture((_params, index) => ({ resources: [], nextCursor: `page-${index + 1}` }));
  expect((await f.record()).app.network).toEqual({ connect: [], resources: [] });
  expect(f.params).toHaveLength(100);
  expect(f.params.at(-1)).toEqual({ cursor: "page-99" });
});

it("keeps the document usable when a later metadata page fails", async () => {
  const f = await fixture((_params, index) => index === 0 ? { resources: [], nextCursor: "next" } : { error: { code: -32603, message: "Catalog unavailable" } });
  expect((await f.record()).app.network).toEqual({ connect: [], resources: [] });
  expect(f.params).toEqual([{}, { cursor: "next" }]);
});
