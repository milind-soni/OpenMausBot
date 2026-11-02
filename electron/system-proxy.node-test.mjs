import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSystemProxy, proxyEnvironment, bypassesProxy } from "./system-proxy.mjs";
import { openProxyTunnel } from "./proxy-transport.mjs";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}

function request(endpoint, url, auth = true) {
  const proxy = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: proxy.hostname, port: proxy.port, path: url, headers: auth ? {
      "proxy-authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`,
    } : {} }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

test("authenticated relay serves HTTP and CONNECT without leaking proxy credentials", async t => {
  let headers;
  const port = await listen(t, http.createServer((req, res) => { headers = req.headers; res.end("fixture"); }));
  const manager = await startSystemProxy({ session: { forceReloadProxyConfig: async () => {}, resolveProxy: async () => "DIRECT" }, env: {} });
  t.after(manager.close);
  const url = `http://127.0.0.1:${port}/test`;
  assert.equal((await request(manager.endpoint, url, false)).status, 407);
  assert.deepEqual(await request(manager.endpoint, url), { status: 200, body: "fixture" });
  assert.equal(headers["proxy-authorization"], undefined);
  const socket = await openProxyTunnel({ hostname: "127.0.0.1", port: String(port) }, new URL(manager.endpoint));
  t.after(() => socket.destroy());
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  const data = once(socket, "data");
  socket.resume();
  assert.match((await data)[0].toString(), /fixture/);
});

test("PAC routes change without changing child endpoint; failure never falls back to DIRECT", async t => {
  let route;
  let connections = 0;
  const sockets = new Set();
  const upstream = http.createServer();
  upstream.on("request", (_req, res) => { connections++; res.end("remote"); });
  upstream.on("connect", (req, client) => {
    sockets.add(client);
    connections++;
    client.write("HTTP/1.1 200 OK\r\n\r\n");
    client.on("data", () => client.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nremote"));
  });
  const port = await listen(t, upstream);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  route = `PROXY 127.0.0.1:${port}; DIRECT`;
  let refreshed = 0;
  const manager = await startSystemProxy({ env: {}, session: { forceReloadProxyConfig: async () => { refreshed++; }, resolveProxy: async () => route } });
  t.after(manager.close);
  const endpoint = manager.endpoint;
  assert.deepEqual(await request(endpoint, "http://fixture.invalid/test"), { status: 200, body: "remote" });
  assert.equal(connections, 1);
  route = "PROXY 127.0.0.1:1; DIRECT";
  await manager.refresh();
  assert.equal((await request(endpoint, "http://fixture.invalid/test")).status, 502);
  assert.equal(manager.status().state, "unavailable");
  assert.equal(manager.endpoint, endpoint);
  route = `PROXY 127.0.0.1:${port}`;
  await manager.refresh();
  assert.equal((await request(endpoint, "http://fixture.invalid/test")).status, 200);
  assert.ok(refreshed >= 3);
});

test("invalid PAC and refresh errors fail closed", async t => {
  let fail = false;
  const manager = await startSystemProxy({ env: {}, session: {
    forceReloadProxyConfig: async () => { if (fail) throw new Error("secret"); },
    resolveProxy: async () => "invalid",
  } });
  t.after(manager.close);
  assert.equal((await request(manager.endpoint, "http://fixture.invalid/")).status, 502);
  fail = true;
  await manager.refresh();
  assert.equal((await request(manager.endpoint, "http://fixture.invalid/")).status, 502);
  assert.doesNotMatch(JSON.stringify(manager.status()), /secret/);
});

test("child environment preserves bypass entries and covers both casing conventions", () => {
  const env = proxyEnvironment({ NO_PROXY: "corp.local", no_proxy: "other.local" }, "http://relay");
  assert.equal(env.HTTPS_PROXY, env.https_proxy);
  assert.equal(env.NO_PROXY, env.no_proxy);
  for (const host of ["corp.local", "other.local", "localhost", "127.0.0.1", "::1", "[::1]"]) assert.ok(env.NO_PROXY.split(",").includes(host));
});

test("environment bypass matching respects suffixes, ports and IPv6", () => {
  assert.equal(bypassesProxy(new URL("https://api.corp.test/"), ".corp.test:443"), true);
  assert.equal(bypassesProxy(new URL("http://api.corp.test/"), ".corp.test:443"), false);
  assert.equal(bypassesProxy(new URL("https://evilcorp.test/"), "corp.test"), false);
  assert.equal(bypassesProxy(new URL("http://[::1]:8080/"), "[::1]:8080"), true);
});

test("explicit environment settings override system discovery", async t => {
  const upstream = http.createServer((_req, res) => res.end("fixed"));
  const port = await listen(t, upstream);
  const manager = await startSystemProxy({ env: { http_proxy: `http://127.0.0.1:${port}` }, session: {
    forceReloadProxyConfig: async () => { throw new Error("must not read system"); },
    resolveProxy: async () => { throw new Error("must not resolve system"); },
  } });
  t.after(manager.close);
  assert.deepEqual(await request(manager.endpoint, "http://fixture.invalid/"), { status: 200, body: "fixed" });
  assert.equal(manager.status().source, "environment");
});

test("an established stream survives proxy changes without replay", async t => {
  const upstream = http.createServer();
  let opened;
  let connections = 0;
  upstream.on("connect", (_req, socket) => { connections++; opened = socket; socket.write("HTTP/1.1 200 OK\r\n\r\n"); });
  const port = await listen(t, upstream);
  let route = `PROXY 127.0.0.1:${port}`;
  const manager = await startSystemProxy({ env: {}, session: { forceReloadProxyConfig: async () => {}, resolveProxy: async () => route } });
  t.after(manager.close);
  const socket = await openProxyTunnel({ hostname: "fixture.invalid", port: "443" }, new URL(manager.endpoint));
  t.after(() => { socket.destroy(); opened?.destroy(); });
  route = "PROXY 127.0.0.1:1";
  await manager.refresh();
  const data = once(socket, "data");
  opened.write("stream continues");
  socket.resume();
  assert.equal((await data)[0].toString(), "stream continues");
  assert.equal(connections, 1);
});

test("browser gate preserves checked IPs while PAC sees the original destination", async t => {
  const { openGate } = await import("../server/browser/egress/gate.ts");
  const upstream = http.createServer();
  let authority;
  let destination;
  upstream.on("connect", (req, socket) => { authority = req.url; socket.end("HTTP/1.1 200 OK\r\n\r\n"); });
  const port = await listen(t, upstream);
  const manager = await startSystemProxy({ env: {}, session: {
    forceReloadProxyConfig: async () => {}, resolveProxy: async url => { destination = url; return `PROXY 127.0.0.1:${port}`; },
  } });
  t.after(manager.close);
  const previous = process.env.OMB_DESKTOP_PROXY;
  process.env.OMB_DESKTOP_PROXY = manager.endpoint;
  t.after(() => { if (previous === undefined) delete process.env.OMB_DESKTOP_PROXY; else process.env.OMB_DESKTOP_PROXY = previous; });
  const gate = await openGate({ resolve: async () => [{ address: "203.0.113.7", family: 4 }], decide: async () => null });
  t.after(() => gate.close());
  const socket = await openProxyTunnel({ hostname: "fixture.invalid", port: "443" }, new URL(`socks5://127.0.0.1:${gate.port}`));
  t.after(() => socket.destroy());
  assert.equal(authority, "203.0.113.7:443");
  assert.equal(destination, "https://fixture.invalid/");
});

test("SOCKS5 upstream negotiates a destination and carries bytes", async t => {
  const socks = net.createServer(socket => {
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", data => {
        assert.equal(data[3], 3);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        socket.once("data", chunk => socket.end(chunk));
      });
    });
  });
  const port = await listen(t, socks);
  const socket = await openProxyTunnel({ hostname: "fixture.invalid", port: "443" }, new URL(`socks5://127.0.0.1:${port}`));
  t.after(() => socket.destroy());
  const data = once(socket, "data");
  socket.write("hello");
  socket.resume();
  assert.equal((await data)[0].toString(), "hello");
});

test("server fetch, HTTP and WebSocket clients inherit the authenticated relay", async t => {
  const upstream = http.createServer();
  let connections = 0;
  upstream.on("request", (_req, res) => { connections++; res.end("fixture"); });
  const sockets = new Set();
  upstream.on("connect", (_req, socket) => {
    sockets.add(socket);
    connections++;
    socket.write("HTTP/1.1 200 OK\r\n\r\n");
    let data = "";
    socket.on("data", chunk => {
      data += chunk;
      if (!data.includes("\r\n\r\n")) return;
      if (/upgrade: websocket/i.test(data)) {
        const key = /sec-websocket-key: (.+)\r\n/i.exec(data)[1];
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.concat([Buffer.from([0x81, 7]), Buffer.from("fixture")]));
        data = "";
      } else socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture");
    });
  });
  const port = await listen(t, upstream);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const manager = await startSystemProxy({ env: {}, session: { forceReloadProxyConfig: async () => {}, resolveProxy: async () => `PROXY 127.0.0.1:${port}` } });
  t.after(manager.close);
  const source = `
    await import('./server/desktop-network.ts');
    const http = await import('node:http');
    const response = await fetch('http://fixture.invalid/model', { signal: AbortSignal.timeout(5000) });
    if (await response.text() !== 'fixture') throw new Error('fetch failed');
    await new Promise((resolve, reject) => {
      http.get('http://fixture.invalid/auth', res => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => body === 'fixture' ? resolve() : reject(new Error('http failed')));
      }).on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://fixture.invalid/socket');
      socket.addEventListener('error', reject);
      socket.addEventListener('message', event => { event.data === 'fixture' ? resolve() : reject(new Error('websocket failed')); });
    });
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { env: { ...process.env, ...manager.environment }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  assert.equal(connections, 3);
});

test("HTTPS model streaming and pinned custom agents keep certificate verification", async t => {
  const { makeTestTls, TEST_TLS_HOST } = await import("../server/testing/test-tls.ts");
  const dir = mkdtempSync(join(tmpdir(), "omb-proxy-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certificate = makeTestTls(dir);
  if (!certificate) { t.skip("openssl is unavailable"); return; }
  const port = await listen(t, https.createServer(certificate, (_req, res) => {
    res.write("fix");
    setTimeout(() => res.end("ture"), 10);
  }));
  const upstream = http.createServer();
  const sockets = new Set();
  let tunnels = 0;
  upstream.on("connect", (_req, client, head) => {
    tunnels++;
    const target = net.connect({ host: "127.0.0.1", port }, () => {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      if (head.length) target.write(head);
      target.pipe(client).pipe(target);
    });
    sockets.add(client); sockets.add(target);
    client.on("close", () => target.destroy());
    target.on("close", () => client.destroy());
    target.on("error", () => client.destroy());
  });
  const proxyPort = await listen(t, upstream);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const manager = await startSystemProxy({ env: {}, session: { forceReloadProxyConfig: async () => {}, resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}` } });
  t.after(manager.close);
  const source = `
    await import('./server/desktop-network.ts');
    const url = new URL(${JSON.stringify(`https://${TEST_TLS_HOST}:${port}/model`)});
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (await response.text() !== 'fixture') throw new Error('HTTPS stream failed');
    const { desktopRequestAgent } = await import('./server/desktop-proxy-tunnel.ts');
    const { get } = await import('node:https');
    const agent = await desktopRequestAgent(url, [{ address: '127.0.0.1' }]);
    await new Promise((resolve, reject) => {
      get(url, { agent }, res => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => body === 'fixture' ? resolve() : reject(new Error('pinned TLS failed')));
      }).on('error', reject);
    });
    agent.destroy();
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { env: {
    ...process.env, ...manager.environment, NODE_EXTRA_CA_CERTS: certificate.certPath,
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  assert.equal((await once(child, "exit"))[0], 0, errors);
  assert.equal(tunnels, 2);
});
