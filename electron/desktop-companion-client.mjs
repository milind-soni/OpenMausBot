// Desktop companion client.
//
// The remote device credential stays in Electron's OS-encrypted credential
// document. The renderer talks to this loopback-only relay with ordinary
// same-origin fetch/EventSource calls; the relay injects the bearer and strips
// browser-only headers before crossing the existing companion boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";

export const DESKTOP_COMPANION_FIELD = "desktopCompanionRemote";
const DEVICE_TOKEN = /^omb_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^[0-9a-f-]{36}$/i;
const PAIRING_CODE = /^\d{6}$/;
const MAX_ERROR_BYTES = 64 * 1024;

/** Keep Electron's trusted-renderer boundary and companion client marker
 * together. The former was added upstream after client mode shipped; losing
 * either argument makes the renderer unsafe or makes a live relay look local. */
export function desktopCompanionRendererArguments(localOrigin, remoteAccess) {
  return [
    `--omb-local-origin=${localOrigin}`,
    ...(remoteAccess ? ["--openmausbot-remote-client"] : []),
  ];
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const cleanLabel = (value, fallback) => {
  const label = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80);
  return label || fallback;
};

/** Pairing tokens may travel through a verified OpenMausBot HTTPS endpoint or
 * an explicit Tailscale MagicDNS name. WireGuard protects cleartext HTTP on
 * the latter; accepting LAN IPs there would silently turn the long-lived
 * bearer into plaintext Wi-Fi traffic. */
export function normalizeDesktopCompanionEndpoint(value) {
  let raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) {
    raw = /\.ts\.net(?::\d+)?\/?$/i.test(raw) ? `http://${raw}` : `https://${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  const hostname = parsed.hostname.toLowerCase();
  const tailscaleHttp = parsed.protocol === "http:" && hostname.endsWith(".ts.net");
  const managedHttps =
    parsed.protocol === "https:" && hostname.endsWith(".openmausbot.com");
  if (
    (!tailscaleHttp && !managedHttps) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  if (tailscaleHttp && !parsed.port) parsed.port = "8810";
  const port = Number(parsed.port);
  if (parsed.port && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) return "";
  return parsed.origin;
}

/** Compatibility name for code that labels the Tailscale form explicitly. */
export const normalizeTailscaleCompanionEndpoint = normalizeDesktopCompanionEndpoint;
export function desktopCompanionAccess(credentials) {
  const stored = credentials?.[DESKTOP_COMPANION_FIELD];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const endpoint = normalizeDesktopCompanionEndpoint(stored.endpoint);
  const token = typeof stored.token === "string" ? stored.token : "";
  const deviceId = typeof stored.deviceId === "string" ? stored.deviceId : "";
  if (!endpoint || !DEVICE_TOKEN.test(token) || !DEVICE_ID.test(deviceId)) return null;
  return {
    endpoint,
    token,
    deviceId,
    serverName: cleanLabel(stored.serverName, new URL(endpoint).hostname),
  };
}

export function withDesktopCompanionAccess(credentials, access) {
  const normalized = desktopCompanionAccess({ [DESKTOP_COMPANION_FIELD]: access });
  if (!normalized) throw new Error("The remote computer returned an invalid device credential");
  return { ...credentials, [DESKTOP_COMPANION_FIELD]: normalized };
}

export function withoutDesktopCompanionAccess(credentials) {
  const next = { ...credentials };
  delete next[DESKTOP_COMPANION_FIELD];
  return next;
}

async function errorMessage(response) {
  const text = (await response.text()).slice(0, MAX_ERROR_BYTES);
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  } catch {}
  return `The remote computer answered HTTP ${response.status}`;
}

export async function pairDesktopCompanion({
  endpoint: rawEndpoint,
  code: rawCode,
  deviceName,
  fetchImpl = fetch,
  requestId = randomUUID(),
}) {
  const endpoint = normalizeDesktopCompanionEndpoint(rawEndpoint);
  if (!endpoint) {
    throw new Error("Enter the OpenMausBot HTTPS companion address or full Tailscale name ending in .ts.net");
  }
  const code = String(rawCode ?? "").trim();
  if (!PAIRING_CODE.test(code)) throw new Error("Enter the six-digit code shown on the other computer");
  const response = await fetchImpl(`${endpoint}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      deviceName: cleanLabel(deviceName, "Desktop companion"),
      pairRequestId: requestId,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json();
  const access = {
    endpoint,
    token: body?.token,
    deviceId: body?.device?.id,
    serverName: body?.serverName,
  };
  const normalized = desktopCompanionAccess({ [DESKTOP_COMPANION_FIELD]: access });
  if (!normalized) throw new Error("The remote computer returned an invalid pairing response");
  return normalized;
}

function isLoopbackHost(host) {
  if (!host) return false;
  const value = String(host).trim().toLowerCase();
  let hostname = value;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return false;
    hostname = value.slice(1, close);
  } else {
    const first = value.indexOf(":");
    if (first >= 0 && first === value.lastIndexOf(":")) hostname = value.slice(0, first);
  }
  if (hostname === "localhost" || hostname === "localhost.") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
}

function allowedOrigin(origin, host) {
  if (!origin) return true;
  if (!isLoopbackHost(host)) return false;
  try {
    const parsed = new URL(String(origin));
    const expected = new URL(`http://${host}`);
    return parsed.protocol === "http:" && parsed.origin === expected.origin;
  } catch {
    return false;
  }
}

function json(res, status, body) {
  if (res.headersSent) return res.destroy();
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "private, no-store",
  });
  res.end(text);
}

function serveStatic(req, res, staticDir) {
  if (req.method !== "GET") return json(res, 404, { error: "no route" });
  const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const resolved = path.resolve(staticDir, relative);
  const root = path.resolve(staticDir) + path.sep;
  const file = resolved.startsWith(root) ? resolved : path.join(staticDir, "index.html");
  let data;
  let served = file;
  try {
    data = fs.readFileSync(file);
  } catch {
    served = path.join(staticDir, "index.html");
    try {
      data = fs.readFileSync(served);
    } catch {
      return json(res, 503, { error: "The desktop UI is not built" });
    }
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(served)] ?? "application/octet-stream",
    "content-length": data.length,
    "cache-control": path.extname(served) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  res.end(data);
}

export function desktopCompanionProxyTarget(endpoint, requestUrl) {
  const incoming = new URL(requestUrl ?? "/", "http://loopback.invalid");
  const target = new URL(`${incoming.pathname}${incoming.search}`, endpoint);
  if (target.origin !== new URL(endpoint).origin) throw new Error("Invalid remote request target");
  return target;
}

export function proxyDesktopCompanionApi(req, res, access) {
  const target = desktopCompanionProxyTarget(access.endpoint, req.url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = {
    accept: String(req.headers.accept ?? "*/*"),
    authorization: `Bearer ${access.token}`,
  };
  for (const name of ["content-type", "content-length", "last-event-id"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const upstream = request(target, { method: req.method, headers }, (remote) => {
    upstream.setTimeout(0);
    const responseHeaders = {};
    for (const name of ["content-type", "content-length", "content-disposition", "cache-control"]) {
      const value = remote.headers[name];
      if (value !== undefined) responseHeaders[name] = value;
    }
    res.writeHead(remote.statusCode ?? 502, responseHeaders);
    remote.pipe(res);
    remote.on("error", () => res.destroy());
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("The remote computer did not answer")));
  upstream.on("error", (error) => {
    if (res.headersSent) return res.destroy();
    json(res, 502, { error: error.message || "Could not reach the remote computer" });
  });
  res.once("close", () => upstream.destroy());
  req.pipe(upstream);
}

function websocketHeaders(req, authorization) {
  if (req.method !== "GET" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  const headers = { authorization, connection: "Upgrade", upgrade: "websocket" };
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function writeUpgrade(socket, response) {
  const lines = [];
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = response.headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`
      + `${lines.join("\r\n")}\r\n\r\n`,
  );
}

export function proxyDesktopCompanionUpgrade(req, socket, head, access, activeSockets = new Set()) {
  let target;
  try {
    target = desktopCompanionProxyTarget(access.endpoint, req.url);
  } catch {
    socket.destroy();
    return;
  }
  if (!target.pathname.startsWith("/vps-viewer/")) return socket.destroy();
  const headers = websocketHeaders(req, `Bearer ${access.token}`);
  if (!headers) return socket.destroy();
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = request(target, { method: "GET", headers });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("The remote viewer did not answer")));
  upstream.once("upgrade", (response, remote, remoteHead) => {
    upstream.setTimeout(0);
    remote.setTimeout(0);
    writeUpgrade(socket, response);
    activeSockets.add(socket);
    activeSockets.add(remote);
    const release = () => {
      activeSockets.delete(socket);
      activeSockets.delete(remote);
    };
    socket.once("close", release);
    remote.once("close", release);
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    socket.pipe(remote).pipe(socket);
  });
  upstream.once("response", (response) => {
    response.resume();
    socket.destroy();
  });
  upstream.once("error", () => socket.destroy());
  socket.once("close", () => upstream.destroy());
  upstream.end();
}

function listen(server, port) {
  return new Promise((resolve) => {
    const onError = (error) => {
      server.off("listening", onListening);
      resolve({ ok: false, error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startDesktopCompanionRelay({
  access,
  staticDir,
  ports = [8798, 18_798, 28_798],
}) {
  const normalized = desktopCompanionAccess({ [DESKTOP_COMPANION_FIELD]: access });
  if (!normalized) throw new Error("The saved remote computer credential is invalid");
  for (const port of ports) {
    const activeSockets = new Set();
    const server = createServer((req, res) => {
      if (!isLoopbackHost(req.headers.host) || !allowedOrigin(req.headers.origin, req.headers.host)) {
        return json(res, 403, { error: "forbidden: loopback client required" });
      }
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith("/api/") || pathname.startsWith("/vps-viewer/")) {
        return proxyDesktopCompanionApi(req, res, normalized);
      }
      return serveStatic(req, res, staticDir);
    });
    server.on("upgrade", (req, socket, head) => {
      if (!isLoopbackHost(req.headers.host) || !allowedOrigin(req.headers.origin, req.headers.host)) {
        return socket.destroy();
      }
      proxyDesktopCompanionUpgrade(req, socket, head, normalized, activeSockets);
    });
    const result = await listen(server, port);
    if (result.ok) return {
      server,
      port,
      access: normalized,
      close() {
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        server.close();
      },
    };
    server.close();
    if (result.error?.code !== "EADDRINUSE") throw result.error;
  }
  throw new Error("Every desktop companion relay port is already in use");
}
