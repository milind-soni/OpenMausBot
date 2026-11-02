import { app, BrowserWindow, session, net } from "electron";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { startSystemProxy } from "../electron/system-proxy.mjs";
import { openProxyTunnel } from "../electron/proxy-transport.mjs";
import { createSystemProxyResolver, readWindowsProxyConfig } from "../electron/system-proxy-resolver.mjs";

const home = process.env.OMB_PROXY_SMOKE_HOME;
assert.ok(home, "Run through scripts/run-system-proxy-smoke.mjs");
app.setPath("userData", home);
const servers = [];
const sockets = new Set();
let manager;
const phase = name => console.log(JSON.stringify({ phase: name }));
const listen = async server => {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

async function verify() {
try {
  phase("starting");
  await app.whenReady();
  phase("electron-ready");
  const actual = await readWindowsProxyConfig();
  console.log(JSON.stringify({ windowsConfigRead: true, autoDetect: actual.autoDetect, pacConfigured: Boolean(actual.pacUrl), manualProxyConfigured: Boolean(actual.proxy) }));
  let connections = 0;
  const tlsHome = process.env.OMB_PROXY_SMOKE_TLS;
  assert.ok(tlsHome);
  const certificate = readFileSync(join(tlsHome, "cert.pem"), "utf8");
  const tlsPort = await listen(https.createServer({ cert: certificate, key: readFileSync(join(tlsHome, "key.pem")) }, (_req, res) => {
    res.write("secure-");
    setTimeout(() => res.end("fixture"), 10);
  }));
  const upstream = http.createServer();
  upstream.on("request", (_req, res) => { connections++; res.end("fixture"); });
  upstream.on("connect", (_req, socket, head) => {
    connections++;
    if (_req.url === `mcp.proxy-fixture.test:${tlsPort}`) {
      const target = connect({ host: "127.0.0.1", port: tlsPort }, () => {
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
        if (head.length) target.write(head);
        target.pipe(socket).pipe(target);
      });
      sockets.add(target);
      target.on("error", () => socket.destroy());
      target.on("close", () => socket.destroy());
      socket.on("close", () => target.destroy());
      return;
    }
    socket.write("HTTP/1.1 200 OK\r\n\r\n");
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture"));
  });
  const port = await listen(upstream);
  let route = `PROXY 127.0.0.1:${port}`;
  let pacUnavailable = false;
  const pacPort = await listen(http.createServer((_req, res) => {
    if (_req.url === "/unavailable.pac" || pacUnavailable) { res.writeHead(503).end(); return; }
    res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig", "cache-control": "no-store" });
    if (_req.url === "/invalid.pac") { res.end("invalid PAC syntax {{{"); return; }
    if (_req.url === "/throw.pac") { res.end('function FindProxyForURL(url, host) { throw new Error("fixture"); }'); return; }
    res.end(`function FindProxyForURL(url, host) { return ${JSON.stringify(route)}; }`);
  }));
  const resolver = session.fromPartition("proxy-smoke-resolver");
  const settings = { autoDetect: false, pacUrl: `http://127.0.0.1:${pacPort}/proxy.pac`, proxy: `127.0.0.1:${port}`, bypass: "" };
  const strictResolver = createSystemProxyResolver({ session: resolver, platform: "win32", readWindows: async () => settings });
  manager = await startSystemProxy({ session: strictResolver, env: {}, request: options => net.request(options) });
  phase("relay-ready");
  app.on("login", manager.login);
  const client = session.fromPartition("proxy-smoke-client");
  await manager.configureSession(client);
  phase("native-fetch");
  assert.equal(await (await client.fetch("http://fixture.proxy-smoke.test/model", { signal: AbortSignal.timeout(10000) })).text(), "fixture");
  assert.equal(connections, 1);
  client.setCertificateVerifyProc((details, callback) => {
    const expected = new X509Certificate(certificate).fingerprint256;
    const actual = new X509Certificate(details.certificate.data).fingerprint256;
    callback(details.hostname === "mcp.proxy-fixture.test" && expected === actual ? 0 : -3);
  });
  assert.equal(await (await client.fetch(`https://mcp.proxy-fixture.test:${tlsPort}/model`, { signal: AbortSignal.timeout(10000) })).text(), "secure-fixture");
  phase("native-https");
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, session: client } });
  await window.loadURL("http://fixture.proxy-smoke.test/renderer");
  assert.equal(await window.webContents.executeJavaScript("fetch('/model').then(response => response.text())"), "fixture");
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  phase("sandboxed-renderer");
  route = "PROXY 127.0.0.1:1; DIRECT";
  await manager.refresh();
  const failed = await client.fetch("http://fixture.proxy-smoke.test/auth");
  assert.equal(failed.status, 502);
  assert.equal(manager.status().state, "unavailable");
  route = `PROXY 127.0.0.1:${port}`;
  await manager.refresh();
  assert.equal(await (await client.fetch("http://fixture.proxy-smoke.test/model")).text(), "fixture");
  let directConnections = 0;
  const directPort = await listen(http.createServer((_req, res) => { directConnections++; res.end("unexpected direct"); }));
  pacUnavailable = true;
  await manager.refresh();
  await assert.rejects(openProxyTunnel({ hostname: "fixture.proxy-smoke.test", port: String(directPort), address: "127.0.0.1" }, new URL(manager.endpoint)));
  assert.equal(directConnections, 0);
  phase("reject-PAC-reload-failure");
  pacUnavailable = false;
  await manager.refresh();
  assert.equal(await (await client.fetch("http://fixture.proxy-smoke.test/model")).text(), "fixture");
  for (const path of ["unavailable.pac", "invalid.pac", "throw.pac"]) {
    settings.pacUrl = `http://127.0.0.1:${pacPort}/${path}`;
    await manager.refresh();
    phase(`reject-${path}`);
    await assert.rejects(openProxyTunnel({ hostname: "fixture.proxy-smoke.test", port: String(directPort), address: "127.0.0.1" }, new URL(manager.endpoint)));
    assert.equal(directConnections, 0);
  }
  settings.pacUrl = `http://127.0.0.1:${pacPort}/proxy.pac`;
  route = "DIRECT";
  await manager.refresh();
  const direct = await openProxyTunnel({ hostname: "fixture.proxy-smoke.test", port: String(directPort), address: "127.0.0.1" }, new URL(manager.endpoint));
  const reply = once(direct, "data");
  direct.write("GET / HTTP/1.1\r\nHost: fixture.proxy-smoke.test\r\nConnection: close\r\n\r\n");
  direct.resume();
  assert.match((await reply)[0].toString(), /unexpected direct/);
  direct.destroy();
  assert.equal(directConnections, 1);
  phase("intentional-direct");
  settings.pacUrl = null;
  settings.proxy = `127.0.0.1:${port}`;
  await manager.refresh();
  assert.equal(await (await client.fetch("http://fixture.proxy-smoke.test/model")).text(), "fixture");
  settings.proxy = null;
  await manager.refresh();
  assert.equal(await strictResolver.resolveProxy("http://fixture.proxy-smoke.test/"), "DIRECT");
  console.log(JSON.stringify({ ok: true, platform: process.platform, electron: process.versions.electron, checks: ["windows-config-read", "PAC", "native-fetch", "native-https", "sandboxed-renderer", "proxy-authentication", "switch", "failure", "recovery", "PAC-reload-failure", "PAC-download-failure", "PAC-syntax-failure", "PAC-runtime-failure", "intentional-DIRECT", "manual-proxy", "proxy-off"], unexpectedDirectConnections: directConnections - 1 }));
  window.destroy();
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
} finally {
  manager?.close();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
}
}

void verify();
