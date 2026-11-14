import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { chromeDataDirs, createChromeDoor, MAX_HEAD, parseDevtoolsActivePort, rewriteHandshake } from "./device-chrome.mjs";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

// A stand-in for Chrome: upgrades only its own browser path. `seen` records every request, upgrade or not, and `bytes`
// every byte any connection delivered, so "never reaches Chrome" means nothing arrived at all.
async function fakeChrome({ onUpgrade } = {}) {
  const seen = [];
  const state = { bytes: 0 };
  const wss = new WebSocketServer({ noServer: true });
  const record = (req) => seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
  const server = createHttpServer((req, res) => { record(req); res.statusCode = 404; res.end(); });
  server.on("connection", (socket) => socket.on("data", (data) => { state.bytes += data.length; }));
  server.on("upgrade", (req, socket, head) => {
    record(req);
    if (req.url !== "/devtools/browser/REAL-ID") { socket.resume(); socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return; }
    socket.resume(); // http stops reading once it emits `upgrade`; keep counting
    if (onUpgrade) { onUpgrade(socket); return; }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(data.toString())));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, state, port: server.address().port, close: () => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); server.close(); } };
}

// A regression should fail a test, not hang the file.
const bounded = (promise, what, ms = 5000) => Promise.race([promise, delay(ms).then(() => assert.fail(`timed out waiting for ${what}`))]);

const withDir = async (text, body) => {
  const dir = await mkdtemp(join(tmpdir(), "chrome-door-"));
  try { if (text !== null) await writeFile(join(dir, "DevToolsActivePort"), text); return await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("reads DevToolsActivePort: a port and Chrome's browser path, nothing else", () => {
  assert.deepEqual(parseDevtoolsActivePort("9222\n/devtools/browser/abc-1\n"), { port: 9222, path: "/devtools/browser/abc-1" });
  for (const text of ["", "0\n/devtools/browser/x", "70000\n/devtools/browser/x", "9222\n/json/new", "9222\n/devtools/browser/../x"]) assert.equal(parseDevtoolsActivePort(text), null, JSON.stringify(text));
});

test("looks only in Chrome's own folders, in agent-browser's order", () => {
  assert.deepEqual(chromeDataDirs({ platform: "darwin", home: "/U" }), ["/U/Library/Application Support/Google/Chrome", "/U/Library/Application Support/Google/Chrome Canary", "/U/Library/Application Support/BraveSoftware/Brave-Browser"]);
  assert.deepEqual(chromeDataDirs({ platform: "win32", localAppData: "C:\\L" }), ["C:\\L\\Google\\Chrome\\User Data", "C:\\L\\Google\\Chrome SxS\\User Data", "C:\\L\\BraveSoftware\\Brave-Browser\\User Data"]);
  assert.deepEqual(chromeDataDirs({ platform: "linux", home: "/h" }), ["/h/.config/google-chrome", "/h/.config/google-chrome-unstable", "/h/.config/BraveSoftware/Brave-Browser"]);
  for (const platform of ["win32", "darwin", "linux"]) assert.deepEqual(chromeDataDirs({ platform }), [], `${platform} without its base folder`);
});

test("rewrites only a WebSocket upgrade to Chrome's browser or a page, with Chrome's own host and no Origin", () => {
  const target = { port: 9222, path: "/devtools/browser/REAL-ID" };
  const head = (line, ...rest) => [line, "Host: 127.0.0.1:5555", "Origin: https://evil.test", ...rest].join("\r\n");
  const upgrade = ["Upgrade: websocket", "Connection: Upgrade"];
  assert.equal(rewriteHandshake(head("GET /devtools/browser/TOKEN HTTP/1.1", ...upgrade), target),
    "GET /devtools/browser/REAL-ID HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  assert.match(rewriteHandshake(head("GET /devtools/browser?x=1 HTTP/1.1", "upgrade: WebSocket", "connection: keep-alive, Upgrade"), target), /^GET \/devtools\/browser\/REAL-ID HTTP/);
  assert.match(rewriteHandshake(head("GET /devtools/page/AB12 HTTP/1.1", ...upgrade), target), /^GET \/devtools\/page\/AB12 HTTP/);
  assert.equal(rewriteHandshake(head("GET /json/new?https://x HTTP/1.1", ...upgrade), target), null);
  assert.equal(rewriteHandshake(head("POST /devtools/browser/x HTTP/1.1", ...upgrade), target), null);
  assert.equal(rewriteHandshake(head("GET /devtools/browser/x HTTP/1.1"), target), null);
  assert.equal(rewriteHandshake(head("GET /devtools/browser/x HTTP/1.1", "Upgrade: websocket"), target), null, "no Connection: upgrade");
  assert.equal(rewriteHandshake(head("GET /devtools/browser/x HTTP/1.1", "Upgrade: websocket", "Connection: close"), target), null, "Connection without upgrade");
  assert.equal(rewriteHandshake(head("GET /devtools/browser/x HTTP/1.1", ...upgrade, "X-A: 1\nOrigin: https://evil.test"), target), null, "a bare LF inside a line");
  assert.equal(rewriteHandshake(head("GET /devtools/browser/x HTTP/1.1", ...upgrade, "X-A: 1\rOrigin: https://evil.test"), target), null, "a bare CR inside a line");
});

test("a door to a running Chrome upgrades end to end and passes frames unchanged", async (t) => {
  const chrome = await fakeChrome();
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const opened = await createChromeDoor({ dirs: [dir] }).open();
    assert.ok(opened.socket);
    const local = createServer((client) => { client.pipe(opened.socket); opened.socket.pipe(client); });
    await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${local.address().port}/devtools/browser/TOKEN`, { origin: "https://evil.test" });
    const reply = await new Promise((resolve, reject) => { ws.on("open", () => ws.send('{"id":1,"method":"Browser.getVersion"}')); ws.on("message", (d) => resolve(d.toString())); ws.on("error", reject); });
    assert.equal(reply, '{"id":1,"method":"Browser.getVersion"}');
    assert.deepEqual(chrome.seen, [{ url: "/devtools/browser/REAL-ID", host: `127.0.0.1:${chrome.port}`, origin: undefined }]);
    ws.terminate(); local.close();
  });
});

test("a request that is not a WebSocket upgrade gets 403 and never reaches Chrome", async (t) => {
  const chrome = await fakeChrome();
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await new Promise((resolve) => socket.write("GET /json/new?https://x HTTP/1.1\r\nHost: a\r\n\r\n", resolve));
    await bounded(closed, "closed");
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.deepEqual(chrome.seen, []);
    assert.equal(chrome.state.bytes, 0);
  });
});

test("an oversized head is dropped", async (t) => {
  const chrome = await fakeChrome();
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    socket.on("error", () => {});
    socket.write(Buffer.alloc(MAX_HEAD + 1, 0x61));
    await until(() => socket.destroyed, "the guard to be destroyed");
    await delay(50);
    assert.deepEqual(chrome.seen, []);
    assert.equal(chrome.state.bytes, 0);
  });
});

test("no DevToolsActivePort, or a stale one whose port refuses, is no-chrome", async () => {
  await withDir(null, async (dir) => assert.deepEqual(await createChromeDoor({ dirs: [dir] }).open(), { failed: "no-chrome" }));
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await withDir(`${port}\n/devtools/browser/REAL-ID\n`, async (dir) => assert.deepEqual(await createChromeDoor({ dirs: [dir] }).open(), { failed: "no-chrome" }));
});

const UPGRADE = "GET /devtools/browser/TOKEN HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

test("a second request pipelined behind the upgrade never reaches Chrome", async (t) => {
  const chrome = await fakeChrome({ onUpgrade: (socket) => { socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); } });
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    socket.on("data", () => {});
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(`${UPGRADE}GET /json/list HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    await bounded(closed, "closed");
    await delay(100);
    assert.deepEqual(chrome.seen.map((r) => r.url), ["/devtools/browser/REAL-ID"]);
    assert.equal(chrome.state.bytes, UPGRADE.replace("TOKEN", "REAL-ID").length - "Host: a".length + `Host: 127.0.0.1:${chrome.port}`.length);
  });
});

test("when Chrome answers anything but 101, held bytes are not sent and the guard ends after delivering the answer", async (t) => {
  const chrome = await fakeChrome();
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/NOT-REAL\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(UPGRADE);
    const second = new Promise((resolve) => socket.write("GET /json/list HTTP/1.1\r\nHost: x\r\n\r\n", resolve));
    await bounded(closed, "closed");
    await bounded(second, "second");
    await delay(100); // anything wrongly sent after the answer would land by now
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 404 /);
    assert.equal(chrome.seen.length, 1, "only the upgrade, never the held request");
    assert.equal(chrome.state.bytes, UPGRADE.replace("TOKEN", "NOT-REAL").length - "Host: a".length + `Host: 127.0.0.1:${chrome.port}`.length, "only the head reached Chrome, never the held request");
  });
});

test("bytes Chrome sends just before it closes still arrive when the guard was paused", async (t) => {
  const chrome = await fakeChrome({ onUpgrade: (socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nTAIL") });
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    const ended = new Promise((resolve) => socket.on("end", resolve));
    socket.pause();
    socket.write(UPGRADE);
    await delay(150);
    socket.resume();
    await bounded(ended, "ended");
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 101 [\s\S]*TAIL$/);
  });
});

test("ending the guard before the head is complete closes it and Chrome's side", async (t) => {
  const chrome = await fakeChrome();
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    socket.resume();
    const ended = new Promise((resolve) => socket.on("end", resolve));
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await new Promise((resolve) => socket.write("GET /devtools/browser/x HTT", resolve));
    socket.end();
    await bounded(ended, "ended");
    await bounded(closed, "closed");
    assert.deepEqual(chrome.seen, []);
    assert.equal(chrome.state.bytes, 0);
  });
});

test("Chrome closing before it answers closes the guard, with later writes still pending", async (t) => {
  const chrome = await fakeChrome({ onUpgrade: (socket) => socket.end() });
  t.after(() => chrome.close());
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    socket.resume();
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(UPGRADE);
    socket.write("one");
    socket.write("two");
    socket.end();
    await bounded(closed, "the guard to close");
  });
});
