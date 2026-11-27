#!/usr/bin/env node
// A command MCP server with an MCP App (io.modelcontextprotocol/ui), for tests: newline-delimited JSON-RPC
// over stdio, with no dependencies.
//
// Tools:
//   show_board   model and app, read-only, with a UI (ui://fake-app/board.html,
//                also under the deprecated flat key); answers text,
//                structuredContent and _meta. `{ large: <bytes> }` pads
//                structuredContent; `{ text: <chars> }` pads the text.
//   paint_board  model and app, NOT read-only: outside Full access an app's
//                call to it needs the person's Allow
//   save_board   app only (`visibility: ["app"]`), not destructive
//   wipe_board   app only, destructiveHint
//   peek_board   model only (`visibility: ["model"]`): its view may not call it
//   plain_echo   no UI
// Resources: ui://fake-app/board.html (text/html;profile=mcp-app) with a CSP
// asking for one good and one bad domain, prefersBorder and a permission.
//
// Environment:
//   FAKE_APP_STRICT=1     refuse an initialize that carries capabilities
//                         .extensions, as a strictly typed server does
//   FAKE_APP_ADAPT=1      list `_meta.ui` only to a client that advertised
//                         the UI extension (the SDK's getUiCapability)
//   FAKE_APP_LOG=<file>   append every frame received, one JSON per line
//   FAKE_APP_HTML_BYTES   pad the view's HTML to this many bytes
//   FAKE_APP_MIME         answer resources/read with this mime type
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const APP_MIME = "text/html;profile=mcp-app";
const EXTENSION = "io.modelcontextprotocol/ui";
const BOARD_URI = "ui://fake-app/board.html";

type Frame = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

let advertised = false;
const send = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const answer = (id: Frame["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
const refuse = (id: Frame["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

/** "Paint it red" calls paint_board, which needs the person's Allow outside Full access; "Save board" calls
 * save_board, app-only, which never asks. */
const BOARD_SCRIPT = [
  "var seq=0,waiting={};",
  "function ask(method,params){return new Promise(function(resolve){var id=++seq;waiting[id]=resolve;parent.postMessage({jsonrpc:'2.0',id:id,method:method,params:params||{}},'*');});}",
  "function el(id){return document.getElementById(id);}",
  "addEventListener('message',function(e){var m=e.data;if(e.source!==parent||!m||m.jsonrpc!=='2.0')return;",
  "if(m.id!==undefined&&waiting[m.id]){var done=waiting[m.id];delete waiting[m.id];done(m);return;}",
  "if(m.method==='ui/notifications/tool-result')el('status').textContent='Result: '+JSON.stringify(m.params.structuredContent||null);",
  "if(m.method==='ui/resource-teardown'&&m.id!==undefined)parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*');});",
  "function show(m){el('out').textContent=m.error?'Error '+m.error.code+': '+m.error.message:'OK: '+JSON.stringify(m.result.content);}",
  "el('paint').onclick=function(){ask('tools/call',{name:'paint_board',arguments:{color:'red'}}).then(show);};",
  "el('save').onclick=function(){ask('tools/call',{name:'save_board',arguments:{state:'saved'}}).then(show);};",
  "ask('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'fake-board',version:'1'},appCapabilities:{}}).then(function(){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');});",
].join("");

function boardHtml(): string {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Board</title></head><body><h1>Fake board</h1><p id="status">Waiting for the result</p><button id="paint">Paint it red</button> <button id="save">Save board</button><pre id="out"></pre><script>${BOARD_SCRIPT}</script></body></html>`;
  const target = Number(process.env.FAKE_APP_HTML_BYTES ?? 0);
  return target > page.length ? page.replace("</body>", `<!--${"x".repeat(target - page.length - 7)}--></body>`) : page;
}

const UI = { resourceUri: BOARD_URI };
function tools() {
  const ui = (extra: Record<string, unknown> = {}) => (!process.env.FAKE_APP_ADAPT || advertised ? { _meta: { ui: { ...UI, ...extra }, "ui/resourceUri": BOARD_URI } } : {});
  const appOnly = (extra: Record<string, unknown> = {}) => (!process.env.FAKE_APP_ADAPT || advertised ? { _meta: { ui: { ...UI, visibility: ["app"], ...extra } } } : {});
  return [
    { name: "show_board", title: "Show board", description: "Show the board", inputSchema: { type: "object", properties: { cards: { type: "number" }, large: { type: "number" }, text: { type: "number" } } },
      annotations: { readOnlyHint: true }, ...ui() },
    { name: "paint_board", title: "Paint board", description: "Paint the board a color", inputSchema: { type: "object", properties: { color: { type: "string" } }, required: ["color"] }, ...ui() },
    { name: "save_board", title: "Save board", description: "Save the board (view only)", inputSchema: { type: "object", properties: { state: { type: "string" } } }, ...appOnly() },
    { name: "wipe_board", title: "Wipe board", description: "Wipe the board (view only)", inputSchema: { type: "object" }, annotations: { destructiveHint: true }, ...appOnly() },
    { name: "peek_board", title: "Peek at board", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, ...(!process.env.FAKE_APP_ADAPT || advertised ? { _meta: { ui: { visibility: ["model"] } } } : {}) },
    { name: "plain_echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  ];
}

function call(params: Record<string, unknown>) {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  switch (params.name) {
    case "show_board": {
      const cards = typeof args.cards === "number" ? args.cards : 3;
      const pad = typeof args.large === "number" ? "p".repeat(args.large) : undefined;
      const text = typeof args.text === "number" ? "t".repeat(args.text) : `Board with ${cards} cards`;
      return { content: [{ type: "text", text }], structuredContent: { cards, ...(pad ? { pad } : {}) }, _meta: { "fake-app/at": "2026-10-14T00:00:00Z" } };
    }
    case "paint_board": return { content: [{ type: "text", text: `Painted ${String(args.color)}` }] };
    case "save_board": return { content: [{ type: "text", text: "Saved" }], structuredContent: { saved: true } };
    case "wipe_board": return { content: [{ type: "text", text: "Wiped" }] };
    case "peek_board": return { content: [{ type: "text", text: "3 cards" }] };
    case "plain_echo": return { content: [{ type: "text", text: String(args.text ?? "") }] };
    default: return undefined;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let frame: Frame;
  try { frame = JSON.parse(line) as Frame; } catch { return; }
  if (process.env.FAKE_APP_LOG) appendFileSync(process.env.FAKE_APP_LOG, `${JSON.stringify(frame)}\n`);
  if (frame.id === undefined || typeof frame.method !== "string") return;
  const params = frame.params ?? {};
  switch (frame.method) {
    case "initialize": {
      const capabilities = (params.capabilities ?? {}) as Record<string, unknown>;
      if (process.env.FAKE_APP_STRICT && capabilities.extensions !== undefined) {
        return refuse(frame.id, -32602, "Invalid message format: Unrecognized field 'extensions' at capabilities.extensions, not marked as ignorable");
      }
      advertised = Boolean((capabilities.extensions as Record<string, unknown> | undefined)?.[EXTENSION]);
      return answer(frame.id, { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fake-app", title: "Fake App", version: "1" } });
    }
    case "ping": return answer(frame.id, {});
    case "tools/list": return answer(frame.id, { tools: tools() });
    case "tools/call": {
      const result = call(params);
      return result ? answer(frame.id, result) : refuse(frame.id, -32602, `Unknown tool: ${String(params.name)}`);
    }
    case "resources/list":
      return answer(frame.id, { resources: [{ uri: BOARD_URI, name: "Board", mimeType: APP_MIME }] });
    case "resources/read":
      if (params.uri !== BOARD_URI) return refuse(frame.id, -32002, "Resource not found");
      return answer(frame.id, { contents: [{
        uri: BOARD_URI, mimeType: process.env.FAKE_APP_MIME ?? APP_MIME, text: boardHtml(),
        _meta: { ui: { csp: { connectDomains: ["https://api.fake-app.example"], resourceDomains: ["https://cdn.fake-app.example", "https://bad.example/path"] }, prefersBorder: true, permissions: { clipboardWrite: {} } } },
      }] });
    default: return refuse(frame.id, -32601, `Method not found: ${frame.method}`);
  }
});
