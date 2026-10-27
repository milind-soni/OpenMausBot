import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { BlockList, createServer, connect as tcpConnect } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

import { createDeviceEgress, deviceRefusal, homeAddresses } from "./device-egress.mjs";
import { linkUrl, runDeviceLink } from "./device-link.mjs";
import { createLinkMux, MAX_CHUNK, MAX_STREAMS, STREAM_WINDOW } from "./device-link-protocol.mjs";

const { WebSocketServer } = createRequire(import.meta.url)("ws");

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

// This computer: a LAN address, a public IPv6 address on its home network's /64, and the public IPv4 My Cloud sees.
const interfaces = {
  en0: [
    { address: "192.168.1.20", cidr: "192.168.1.20/24", family: "IPv4", internal: false },
    { address: "2a02:1200:5:6::20", cidr: "2a02:1200:5:6::20/64", family: "IPv6", internal: false },
  ],
  utun3: [{ address: "203.0.113.200", cidr: "0.0.0.0/0", family: "IPv4", internal: false }],
};
const SEEN_AS = "198.51.100.44";
const lists = () => ({ own: (() => { const own = new BlockList(); for (const entry of Object.values(interfaces).flat()) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4"); return own; })(), home: homeAddresses(interfaces, SEEN_AS) });

test("the computer opens only web ports, only on the public internet: never itself, its home network, link-local, metadata or reserved", () => {
  const refused = (port, ...addresses) => deviceRefusal(port, addresses, lists());
  for (const port of [22, 25, 8080, 8443, 8799, 3000]) assert.equal(refused(port, "93.184.215.14"), "port", `port ${port}`);
  assert.equal(refused(443, "93.184.215.14"), null);
  assert.equal(refused(80, "2606:2800:21f:cb07:6820:80da:af6b:8b2c"), null);
  const home = {
    "127.0.0.1": "loopback", "::1": "loopback", "::ffff:127.0.0.1": "mapped loopback", "10.0.0.8": "LAN", "172.16.4.4": "LAN",
    "192.168.1.1": "the router", "100.64.3.3": "carrier-grade NAT (Tailscale)", "fd7a:115c:a1e0::1": "unique local (Tailscale)", "fdaa::3": "Fly's 6PN",
    "192.168.1.20": "this computer", "203.0.113.200": "this computer's VPN address",
    "2a02:1200:5:6::99": "another device on the home's public IPv6 network", [SEEN_AS]: "the home's own public address",
    "::ffff:198.51.100.44": "the home's public address, mapped",
    "64:ff9b::c0a8:101": "NAT64 of the router", "64:ff9b::7f00:1": "NAT64 of loopback", "2002:c0a8:101::1": "6to4 of the router",
  };
  for (const [address, what] of Object.entries(home)) assert.equal(refused(443, address), "home-network", what);
  assert.equal(refused(443, "169.254.10.1"), "link-local");
  assert.equal(refused(443, "fe80::1"), "link-local");
  for (const address of ["169.254.169.254", "fd00:ec2::254", "100.100.100.200", "64:ff9b::a9fe:a9fe"]) assert.equal(refused(443, address), "metadata", address);
  for (const address of ["0.0.0.0", "224.0.0.251", "198.18.0.1", "::", "ff02::1", "not-an-address"]) assert.equal(refused(443, address), "reserved", address);
  assert.equal(refused(443, "64:ff9b::5db8:d70e"), null, "NAT64 of a public address stays public");
  assert.equal(refused(443, "93.184.215.14", "10.0.0.8"), "home-network", "every address must pass, not just the first");
  assert.equal(deviceRefusal(443, ["203.0.113.200"], { own: new BlockList(), home: homeAddresses(interfaces, null) }), null,
    "a VPN's catch-all route is not a network of devices; only what this computer holds or sits on is home");
});

test("the computer looks names up itself, refuses before connecting, and connects only to the addresses it checked", async () => {
  const connects = [];
  const resolved = new Map([["lan.test", [{ address: "192.168.1.1", family: 4 }]], ["public.test", [{ address: "93.184.215.14", family: 4 }]],
    ["mixed.test", [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.8", family: 4 }]]]);
  const looked = [];
  let fail = null;
  const egress = createDeviceEgress({
    interfaces: () => interfaces, seenAs: () => SEEN_AS,
    resolve: async (host) => { looked.push(host); return resolved.get(host) ?? []; },
    connect: (options) => {
      connects.push(options);
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
      setImmediate(() => fail ? socket.emit("error", Object.assign(new Error("no"), { code: fail })) : socket.emit("connect"));
      return socket;
    },
  });
  assert.deepEqual(await egress.open({ host: "lan.test", port: 443 }), { refused: "home-network" });
  assert.deepEqual(await egress.open({ host: "mixed.test", port: 443 }), { refused: "home-network" });
  assert.deepEqual(await egress.open({ host: "localhost", port: 443 }), { refused: "home-network" });
  assert.deepEqual(await egress.open({ host: "app.localhost.", port: 80 }), { refused: "home-network" });
  assert.deepEqual(await egress.open({ host: "public.test", port: 8080 }), { refused: "port" });
  assert.deepEqual(await egress.open({ host: SEEN_AS, port: 443 }), { refused: "home-network" });
  assert.deepEqual(await egress.open({ host: "nowhere.test", port: 443 }), { failed: "unreachable" });
  assert.deepEqual(looked, ["lan.test", "mixed.test", "nowhere.test"], "a refused port or a local name is never looked up");
  assert.equal(connects.length, 0, "nothing refused was ever connected");
  const opened = await egress.open({ host: "public.test", port: 443 });
  assert.ok(opened.socket);
  assert.equal(connects.length, 1);
  // The socket's own lookup hands back only the checked address: a name that now resolves elsewhere changes nothing.
  const answers = [];
  connects[0].lookup("public.test", { all: true }, (_error, addresses) => answers.push(addresses));
  assert.deepEqual(answers, [[{ address: "93.184.215.14", family: 4 }]]);
  fail = "ECONNREFUSED";
  assert.deepEqual(await egress.open({ host: "public.test", port: 443 }), { failed: "refused" });
  fail = "EHOSTUNREACH";
  assert.deepEqual(await egress.open({ host: "public.test", port: 80 }), { failed: "unreachable" });
  const silent = createDeviceEgress({ interfaces: () => interfaces, resolve: async () => [{ address: "93.184.215.14", family: 4 }], connectMs: 50,
    connect: () => new Duplex({ read() {}, write(_c, _e, done) { done(); } }) });
  assert.deepEqual(await silent.open({ host: "slow.test", port: 443 }), { failed: "timeout" });
});

/** Two muxes joined back to back, as a link carries them. */
function linked({ accept, window, maxStreams, openMs } = {}) {
  let cloud, device;
  const frames = { toDevice: 0, toCloud: 0 };
  cloud = createLinkMux({ send: (frame) => { frames.toDevice++; setImmediate(() => device.receive(frame)); }, window, maxStreams, openMs });
  device = createLinkMux({ send: (frame) => { frames.toCloud++; setImmediate(() => cloud.receive(frame)); }, accept, window, maxStreams });
  return { cloud, device, frames };
}

/** A local TCP server whose connections all end with the test, passing or not. */
async function localServer(t, onConnection = () => {}) {
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); onConnection(socket); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server;
}

async function echoServer(t) {
  return (await localServer(t, (socket) => socket.pipe(socket))).address().port;
}

/** A local pair of sockets: one end goes into the mux, the test reads and writes the other. */
async function socketPair(t) {
  let take;
  const accepted = new Promise((resolve) => { take = resolve; });
  const server = await localServer(t, (socket) => take(socket));
  const near = tcpConnect(server.address().port, "127.0.0.1");
  near.on("error", () => {});
  t.after(() => near.destroy());
  await new Promise((resolve) => near.once("connect", resolve));
  return { near, far: await accepted };
}

test("a stream through the link carries bytes both ways and ends on either side", async (t) => {
  const port = await echoServer(t);
  const { cloud, device } = linked({ accept: async () => ({ socket: tcpConnect(port, "127.0.0.1") }) });
  t.after(() => { cloud.close(); device.close(); });
  const opened = await cloud.open({ host: "example.test", port: 443 });
  assert.ok(opened.join, JSON.stringify(opened));
  const { near, far } = await socketPair(t);
  opened.join(far, [Buffer.from("early ")]);
  near.write("and later");
  let echoed = "";
  near.on("data", (chunk) => { echoed += chunk; });
  await until(() => echoed === "early and later", "the echo");
  near.destroy();
  await until(() => cloud.size === 0, "the stream to be gone on My Cloud's side");
});

/** A socket whose writes finish only when the test lets them: what the mux handed it and is still waiting on. */
function slowSocket() {
  const listeners = new Map();
  const socket = {
    taken: 0, waiting: [],
    on(event, listener) { listeners.set(event, listener); return socket; },
    write(bytes, done) { socket.taken += bytes.length; socket.waiting.push(done); return false; },
    pause() {}, resume() {}, end() {}, destroy() { listeners.get("close")?.(); },
    finish() { const waiting = socket.waiting; socket.waiting = []; for (const done of waiting) done(); },
  };
  return socket;
}

test("each side sends only what the other has room for: a reader that stops never makes the other end buffer more than a window", async (t) => {
  const slow = slowSocket();
  const { cloud, device } = linked({ accept: async () => ({ socket: slow }) });
  t.after(() => { cloud.close(); device.close(); });
  const opened = await cloud.open({ host: "example.test", port: 443 });
  const { near, far } = await socketPair(t);
  opened.join(far, []);
  const sent = Buffer.alloc(4 * STREAM_WINDOW, 1);
  near.write(sent);
  await delay(300);
  assert.ok(slow.taken <= STREAM_WINDOW, `the computer took ${slow.taken} bytes with none written through, over its ${STREAM_WINDOW}-byte window`);
  assert.ok(slow.taken >= STREAM_WINDOW - MAX_CHUNK, `only ${slow.taken} bytes arrived: the window was not used`);
  for (const deadline = Date.now() + 10_000; slow.taken < sent.length && Date.now() < deadline;) { slow.finish(); await delay(10); }
  assert.equal(slow.taken, sent.length, "every byte arrives once room comes back");
  near.destroy();
});

test("a sender never goes past the room it has, whatever size the page's writes come in", async (t) => {
  const slow = slowSocket();
  const { cloud, device } = linked({ accept: async () => ({ socket: slow }) });
  t.after(() => { cloud.close(); device.close(); });
  const opened = await cloud.open({ host: "example.test", port: 443 });
  // Writes of an odd size, so the window runs out in the middle of one.
  const page = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  opened.join(page, []);
  for (let sent = 0; sent < 2 * STREAM_WINDOW; sent += 7000) page.push(Buffer.alloc(7000, 2));
  await delay(300);
  assert.equal(slow.taken, STREAM_WINDOW, "exactly a window went across, not a byte more");
  page.destroy();
});

test("a peer that ignores flow control loses the stream, and a credit for bytes never sent does too", async (t) => {
  const port = await echoServer(t);
  const sent = [];
  const device = createLinkMux({ send: (frame) => sent.push(frame), accept: async () => ({ socket: tcpConnect(port, "127.0.0.1") }) });
  t.after(() => device.close());
  device.receive(JSON.stringify({ t: "open", id: 7, host: "example.test", port: 443 }));
  await until(() => sent.some((frame) => typeof frame === "string" && frame.includes('"opened"')), "the stream to open");
  const frame = (bytes) => { const header = Buffer.alloc(4); header.writeUInt32BE(7); return Buffer.concat([header, Buffer.alloc(bytes)]); };
  for (let i = 0; i < STREAM_WINDOW / MAX_CHUNK; i++) device.receive(frame(MAX_CHUNK));
  assert.equal(device.size, 1, "a full window is fine");
  device.receive(frame(1));
  assert.equal(device.size, 0, "one byte past the window ends the stream");
  assert.ok(sent.some((entry) => entry === JSON.stringify({ t: "close", id: 7 })));
  device.receive(JSON.stringify({ t: "open", id: 8, host: "example.test", port: 443 }));
  await until(() => sent.some((entry) => entry === JSON.stringify({ t: "opened", id: 8 })), "the second stream to open");
  device.receive(JSON.stringify({ t: "credit", id: 8, bytes: 1 }));
  assert.equal(device.size, 0, "room beyond a window is a peer not counting");
});

test("a refusal, a failure, a full link and a link that ends all answer at once: nothing waits", async () => {
  const { cloud } = linked({ accept: async ({ host }) => host === "lan.test" ? { refused: "home-network" } : host === "down.test" ? { failed: "unreachable" } : new Promise(() => {}), maxStreams: 3 });
  assert.deepEqual(await cloud.open({ host: "lan.test", port: 443 }), { refused: "home-network" });
  assert.deepEqual(await cloud.open({ host: "down.test", port: 443 }), { failed: "unreachable" });
  const hanging = [cloud.open({ host: "slow.test", port: 443 }), cloud.open({ host: "slow.test", port: 443 }), cloud.open({ host: "slow.test", port: 443 })];
  assert.deepEqual(await cloud.open({ host: "slow.test", port: 443 }), { failed: "busy" });
  cloud.close();
  assert.deepEqual(await Promise.all(hanging), [{ gone: true }, { gone: true }, { gone: true }], "a link that ends sends every waiting connection another way");
  assert.deepEqual(await cloud.open({ host: "example.test", port: 443 }), { gone: true });
  const silent = createLinkMux({ send: () => {}, openMs: 50 });
  assert.deepEqual(await silent.open({ host: "example.test", port: 443 }), { gone: true }, "no answer in time: the link is not carrying anything");
  assert.equal(MAX_STREAMS, 128);
});

/** My Cloud's end of a link for tests: a ws server that greets, answers pings, and opens streams on request. */
async function cloudEnd(t, { greet = true, answerPings = true } = {}) {
  const http = createHttpServer();
  const wss = new WebSocketServer({ server: http });
  const sessions = [];
  wss.on("connection", (ws, req) => {
    const mux = createLinkMux({ send: (frame) => ws.send(frame) });
    const session = { ws, mux, headers: req.headers };
    sessions.push(session);
    if (greet) ws.send(JSON.stringify({ t: "hello", seenAs: SEEN_AS }));
    ws.on("message", (data, binary) => {
      if (!binary && data.toString() === JSON.stringify({ t: "ping" })) { if (answerPings) ws.send(JSON.stringify({ t: "pong" })); return; }
      mux.receive(binary ? data : data.toString());
    });
    ws.on("close", () => mux.close());
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); http.close(); });
  return { url: `ws://127.0.0.1:${http.address().port}/api/shared-computers/c/link`, sessions };
}

test("the link signs in like the poll, takes My Cloud's word for this computer's public address, and ends when asked", async (t) => {
  const end = await cloudEnd(t);
  const stop = new AbortController();
  let opened = 0;
  const connects = [];
  const running = runDeviceLink({ url: end.url, headers: { cookie: "omb_session=s", "x-omb-computer-secret": "a".repeat(64) }, signal: stop.signal, onOpen: () => opened++, openMs: 100,
    egress: { interfaces: () => ({}), resolve: async () => [{ address: SEEN_AS, family: 4 }], connect: (options) => { connects.push(options); return tcpConnect(1, "127.0.0.1"); } } });
  await until(() => end.sessions.length === 1 && opened === 1, "the link to open");
  assert.equal(end.sessions[0].headers.cookie, "omb_session=s");
  assert.equal(end.sessions[0].headers["x-omb-computer-secret"], "a".repeat(64));
  await delay(250); // past the opening limit: a link that opened is not ended by it
  assert.deepEqual(await end.sessions[0].mux.open({ host: "home-router.test", port: 443 }), { refused: "home-network" }, "the home's own public address is home");
  assert.equal(connects.length, 0);
  stop.abort();
  assert.deepEqual(await running, { code: 1000, reason: "stopped" });
  assert.equal(linkUrl("https://omb-u-1.fly.dev", "/api/shared-computers/c/link"), "wss://omb-u-1.fly.dev/api/shared-computers/c/link");
  assert.equal(linkUrl("http://127.0.0.1:9", "/x"), "ws://127.0.0.1:9/x");
});

test("a My Cloud that stops answering ends the link here within the silence limit, so nothing hangs on it", async (t) => {
  const end = await cloudEnd(t, { answerPings: false, greet: false });
  const started = Date.now();
  const ended = await runDeviceLink({ url: end.url, pingMs: 30, silentMs: 120, egress: { interfaces: () => ({}) } });
  assert.deepEqual(ended, { code: 1006, reason: "silent" });
  assert.ok(Date.now() - started < 2000, "ended promptly");
});

test("a link whose opening never finishes gives up within the opening limit, so lending dials again instead of waiting", async (t) => {
  // My Cloud's address takes the connection and never answers the upgrade: a half-dead proxy or a machine mid-restart.
  const held = new Set();
  const mute = createServer((socket) => { held.add(socket); socket.on("error", () => {}); });
  await new Promise((resolve) => mute.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of held) socket.destroy(); mute.close(); });
  const started = Date.now();
  const ended = await Promise.race([
    runDeviceLink({ url: `ws://127.0.0.1:${mute.address().port}/link`, openMs: 150, egress: { interfaces: () => ({}) } }),
    delay(3000).then(() => "still waiting"),
  ]);
  assert.deepEqual(ended, { code: 1006, reason: "timeout" });
  assert.ok(Date.now() - started < 2000, "gave up promptly");
});

test("a link that cannot open says so at once, with the close code My Cloud gave", async (t) => {
  const http = createHttpServer((_req, res) => res.end());
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => ws.close(4001, "asleep"));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => { wss.close(); http.close(); });
  assert.deepEqual(await runDeviceLink({ url: `ws://127.0.0.1:${http.address().port}/link`, egress: { interfaces: () => ({}) } }), { code: 4001, reason: "asleep" });
  const refusing = createHttpServer((_req, res) => { res.writeHead(403).end(); });
  refusing.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"));
  await new Promise((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  t.after(() => refusing.close());
  assert.equal((await runDeviceLink({ url: `ws://127.0.0.1:${refusing.address().port}/link`, egress: { interfaces: () => ({}) } })).code, 1006);
});

test("a Chrome stream reaches the computer as { chrome: true } and never carries a host or port", async (t) => {
  const targets = [];
  const sent = [];
  let device;
  const cloud = createLinkMux({ send: (frame) => { sent.push(frame); setImmediate(() => device.receive(frame)); } });
  device = createLinkMux({ send: (frame) => setImmediate(() => cloud.receive(frame)), accept: async (target) => { targets.push(target); return { failed: "no-chrome" }; } });
  t.after(() => { cloud.close(); device.close(); });
  assert.deepEqual(await cloud.open({ chrome: true }), { failed: "no-chrome" });
  assert.deepEqual(targets, [{ chrome: true }]);
  assert.deepEqual(JSON.parse(sent[0]), { t: "open", id: 1, chrome: true });
  assert.deepEqual(await cloud.open({ host: "example.test", port: 443 }), { failed: "no-chrome" });
  assert.deepEqual(targets[1], { host: "example.test", port: 443 });
});

test("the computer opens a Chrome stream only while it lends Chrome, and a web stream only while it lends its internet connection", async (t) => {
  const end = await cloudEnd(t);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const echo = await echoServer(t);
  let grant = { internet: false, chrome: false };
  const streams = [];
  const running = runDeviceLink({ url: end.url, signal: stop.signal, lends: () => grant, onStream: (target, result) => streams.push({ target, result }),
    egress: { interfaces: () => ({}), resolve: async () => [{ address: "93.184.215.14", family: 4 }], connect: () => tcpConnect(echo, "127.0.0.1") },
    chrome: { open: async () => ({ socket: tcpConnect(echo, "127.0.0.1") }) } });
  await until(() => end.sessions.length === 1, "the link to open");
  const { mux } = end.sessions[0];
  assert.deepEqual(await mux.open({ chrome: true }), { refused: "not-lent" });
  assert.deepEqual(await mux.open({ host: "example.com", port: 443 }), { refused: "not-lent" });
  assert.equal(streams.length, 2, "onStream hears refusals too");
  grant = { internet: false, chrome: true };
  assert.deepEqual(await mux.open({ host: "example.com", port: 443 }), { refused: "not-lent" }, "lending Chrome does not lend the internet connection");
  const opened = await mux.open({ chrome: true });
  assert.ok(opened.join, JSON.stringify(opened));
  const { near, far } = await socketPair(t);
  opened.join(far);
  let echoed = "";
  near.on("data", (chunk) => { echoed += chunk; });
  near.write("hello chrome");
  await until(() => echoed === "hello chrome", "the echo");
  near.destroy();
  stop.abort();
  await running;
});
