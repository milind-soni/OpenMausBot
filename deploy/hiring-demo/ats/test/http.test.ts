import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server.ts";
import { seedFiles } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "desk-http-"));
mkdirSync(join(root, "data"));
copyFileSync(seedFiles().seedPath, join(root, "data", "seed.json"));
const app = await startServer({ rootDir: root, port: 0 });
after(() => app.close());

const get = (path: string) => fetch(`${app.url}${path}`);
const post = (path: string) => fetch(`${app.url}${path}`, { method: "POST" });

test("binds loopback only", () => {
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("state omits pending and script", async () => {
  const state = await (await get("/api/state")).json();
  assert.ok(Array.isArray(state.requirements) && state.requirements.length === 19);
  assert.equal("pending" in state, false);
  assert.equal("script" in state, false);
});

test("SSE streams a desk event", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${app.url}/api/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const seen = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += new TextDecoder().decode(value);
      if (text.includes("client_email_received")) return text;
    }
  })();
  await post("/api/demo/reset");
  const r = await post("/api/demo/client-email");
  assert.equal(r.status, 200);
  const text = await seen;
  ctrl.abort();
  assert.match(text, /event: desk\ndata: \{.*"name":"client_email_received"/);
});

test("client-email endpoint delivers once then 409", async () => {
  await post("/api/demo/reset");
  const first = await post("/api/demo/client-email");
  assert.equal(first.status, 200);
  assert.match((await first.json()).email_id, /^EM-\d{4}$/);
  const second = await post("/api/demo/client-email");
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already delivered/);
});

test("morning endpoint delivers once then 409", async () => {
  await post("/api/demo/reset");
  const first = await post("/api/demo/morning");
  assert.equal((await first.json()).email_ids.length, 2);
  assert.equal((await post("/api/demo/morning")).status, 409);
});

test("reset endpoint restores seed", async () => {
  await post("/api/demo/client-email");
  const res = await post("/api/demo/reset");
  assert.deepEqual(await res.json(), { ok: true });
  const state = await (await get("/api/state")).json();
  assert.equal(state.emails.length, 0);
  assert.equal(state.flags.clientEmailDelivered, false);
});

test("SAMPLE doc page", async () => {
  const state = await (await get("/api/state")).json();
  const ana = state.candidates.find((c: { name: string }) => c.name === "Ana Souza");
  const res = await get(`/docs/${ana.id}/ead`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /SAMPLE/);
  assert.match(html, /not a real document/);
  assert.match(html, /Ana Souza/);
});

test("resume page escapes HTML and works for vendor consultants before import", async () => {
  const consultant = "CAN-0401";
  const res = await get(`/docs/${consultant}/resume`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Java Consultant/);
  assert.equal((await get("/docs/CAN-9999/resume")).status, 404);
  assert.equal((await get("/docs/CAN-0001/passport")).status, 404);
});

test("serves the UI", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Desk ATS/);
});

test("MCP endpoint answers", async () => {
  const res = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /deskats/);
});

test("board endpoint returns entries ranked by keyword with candidate summaries", async () => {
  const res = await get("/api/board/REQ-1041");
  assert.equal(res.status, 200);
  const board = await res.json();
  assert.equal(board.req_id, "REQ-1041");
  assert.ok(board.entries.length >= 3);
  const scores = board.entries.map((e: { keywordScore: number }) => e.keywordScore);
  assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a));
  assert.equal(typeof board.entries[0].name, "string");
  assert.equal((await get("/api/board/REQ-9999")).status, 404);
});

test("state and config paths come from ATS_STATE and ATS_CONFIG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-env-"));
  mkdirSync(join(dir, "data"));
  copyFileSync(seedFiles().seedPath, join(dir, "data", "seed.json"));
  const statePath = join(dir, "elsewhere-state.json");
  const configPath = join(dir, "elsewhere-config.json");
  writeFileSync(configPath, JSON.stringify({ webhookUrl: null }));
  process.env.ATS_STATE = statePath;
  process.env.ATS_CONFIG = configPath;
  try {
    const srv = await startServer({ rootDir: dir, port: 0 });
    await fetch(`${srv.url}/api/demo/reset`, { method: "POST" });
    assert.ok(existsSync(statePath));
    await srv.close();
  } finally {
    delete process.env.ATS_STATE;
    delete process.env.ATS_CONFIG;
  }
});
