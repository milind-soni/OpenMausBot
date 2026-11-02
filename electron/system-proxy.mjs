import http from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { openProxyTunnel } from "./proxy-transport.mjs";

const PROXY_NAMES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];
const loopback = host => /^(localhost|127\..*|\[?::1\]?)$/i.test(host);
export function bypassesProxy(url, entries) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return entries.split(",").some(value => {
    const rule = value.trim().toLowerCase();
    if (rule === "*") return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule);
    const host = (match?.[1] ?? rule).replace(/^\[|\]$/g, "").replace(/^(?:\*\.|\.)/, "");
    return Boolean(host) && (!match?.[2] || match[2] === port) && (hostname === host || hostname.endsWith(`.${host}`));
  });
}
const bounded = async operation => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Proxy configuration timed out")), 10_000); })]);
  } finally { clearTimeout(timer); }
};

export function proxyEnvironment(env, endpoint) {
  const bypass = [...new Set([env.NO_PROXY, env.no_proxy, "localhost,127.0.0.1,::1,[::1]"].filter(Boolean).join(",").split(",").map(s => s.trim()).filter(Boolean))].join(",");
  return { ...env, HTTP_PROXY: endpoint, http_proxy: endpoint, HTTPS_PROXY: endpoint, https_proxy: endpoint,
    ALL_PROXY: endpoint, all_proxy: endpoint, NO_PROXY: bypass, no_proxy: bypass, NODE_USE_ENV_PROXY: "1", OMB_DESKTOP_PROXY: endpoint };
}

export async function startSystemProxy({ session, env = process.env, interval = 5000, request: nativeRequest }) {
  const original = { ...env };
  const explicit = PROXY_NAMES.some(name => original[name]);
  const secret = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`omb:${secret}`).toString("base64")}`;
  let status = { source: explicit ? "environment" : "system", state: "initializing" };
  let refreshing;
  let refreshFailed = false;
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const refresh = () => refreshing ??= (async () => {
    try { if (!explicit) await bounded(session.forceReloadProxyConfig()); refreshFailed = false; }
    catch { refreshFailed = true; status = { ...status, state: "unavailable", reason: "System proxy configuration unavailable" }; }
  })().finally(() => { refreshing = undefined; });
  await refresh();
  const route = async url => {
    if (refreshing) await refreshing;
    if (loopback(url.hostname)) return null;
    if (refreshFailed) throw new Error("System proxy configuration unavailable");
    let result;
    if (explicit) {
      if (bypassesProxy(url, [original.no_proxy, original.NO_PROXY].filter(Boolean).join(","))) return null;
      const value = (url.protocol === "https:" ? original.https_proxy || original.HTTPS_PROXY : original.http_proxy || original.HTTP_PROXY) || original.all_proxy || original.ALL_PROXY;
      result = value ? new URL(value.includes("://") ? value : `http://${value}`) : null;
    } else {
      const resolved = await bounded(session.resolveProxy(url.href));
      const first = resolved.split(";")[0].trim();
      if (first === "DIRECT") result = null;
      else {
        const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(.+)$/.exec(first);
        if (!match) throw new Error("Unsupported system proxy route");
        result = new URL(`${match[1] === "HTTPS" ? "https" : match[1] === "SOCKS" ? "socks4" : match[1] === "SOCKS5" ? "socks5" : "http"}://${match[2]}`);
      }
    }
    if (result && !["http:", "https:", "socks4:", "socks5:"].includes(result.protocol)) throw new Error("Unsupported proxy protocol");
    if (result?.protocol.startsWith("socks") && result.username) throw new Error("SOCKS authentication is unsupported");
    return result;
  };
  const open = async (url, address) => {
    try {
      const proxy = await route(url);
      if (address && !isIP(address)) throw new Error("Invalid pinned destination");
      const socket = track(await openProxyTunnel({ hostname: address || url.hostname.replace(/^\[|\]$/g, ""), port: url.port || (url.protocol === "https:" ? "443" : "80") }, proxy));
      status = { source: status.source, state: proxy ? "proxy" : "direct" };
      return socket;
    } catch {
      status = { source: status.source, state: "unavailable", reason: "Proxy connection failed; check system proxy and authentication" };
      throw new Error(status.reason);
    }
  };
  const permitted = req => req.headers["proxy-authorization"] === authorization;
  const server = http.createServer(async (req, res) => {
    if (!permitted(req)) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="OpenMausBot"' }).end(); return; }
    try {
      const url = new URL(req.url);
      if (url.origin === "http://omb-proxy-auth.invalid") { res.writeHead(204).end(); return; }
      if (url.protocol !== "http:") throw new Error("Invalid proxy request");
      const proxy = await route(url);
      const forward = proxy && ["http:", "https:"].includes(proxy.protocol);
      const socket = forward
        ? track(await openProxyTunnel({ hostname: proxy.hostname.replace(/^\[|\]$/g, ""), port: proxy.port || (proxy.protocol === "https:" ? "443" : "80"), secure: proxy.protocol === "https:" }, null))
        : await open(url);
      const headers = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      delete headers["omb-target-ip"];
      delete headers["omb-target-url"];
      if (forward && proxy.username) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
      headers.connection = "close";
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const request = http.request(url, { method: req.method, path: forward ? url.href : `${url.pathname}${url.search}`, headers, agent }, response => {
        status = { source: status.source, state: response.statusCode === 407 ? "unavailable" : proxy ? "proxy" : "direct" };
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      request.on("error", () => res.destroy());
      res.on("close", () => request.destroy());
      req.pipe(request);
      socket.resume();
    } catch { status = { source: status.source, state: "unavailable" }; res.writeHead(502).end("Proxy connection unavailable"); }
  });
  server.on("connection", track);
  server.on("upgrade", async (req, client, head) => {
    if (!permitted(req)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="OpenMausBot"\r\n\r\n'); return; }
    try {
      const url = new URL(req.url);
      if (!["http:", "ws:"].includes(url.protocol)) throw new Error("Invalid WebSocket proxy request");
      url.protocol = "http:";
      const upstream = await open(url);
      if (client.destroyed) { upstream.destroy(); return; }
      const headers = Object.entries(req.headers).filter(([name]) => !["proxy-authorization", "proxy-connection"].includes(name));
      upstream.write(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      upstream.resume();
    } catch { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); }
  });
  server.on("connect", async (req, client, head) => {
    if (!permitted(req)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="OpenMausBot"\r\n\r\n'); return; }
    try {
      const url = new URL(`https://${req.url}`);
      if (req.headers["omb-target-url"]) {
        const originalUrl = new URL(req.headers["omb-target-url"]);
        if (!["http:", "https:"].includes(originalUrl.protocol) || originalUrl.hostname !== url.hostname || Number(originalUrl.port || (originalUrl.protocol === "https:" ? 443 : 80)) !== Number(url.port || 443)) throw new Error("Invalid tunnel route");
        url.href = originalUrl.href;
      } else if (url.port === "80") url.protocol = "http:";
      const upstream = await open(url, req.headers["omb-target-ip"]);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      upstream.resume();
    } catch { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `http://omb:${secret}@127.0.0.1:${server.address().port}`;
  const timer = setInterval(() => { void refresh(); }, interval);
  timer.unref();
  const configureSession = async target => {
    await target.setProxy({ mode: "fixed_servers", proxyRules: `http=127.0.0.1:${server.address().port};https=127.0.0.1:${server.address().port}`, proxyBypassRules: "localhost;127.0.0.1;[::1]" });
    if (!nativeRequest) return;
    await new Promise((resolve, reject) => {
      const req = nativeRequest({ url: "http://omb-proxy-auth.invalid/", session: target });
      const timer = setTimeout(() => { req.abort(); reject(new Error("Proxy authentication timed out")); }, 10000);
      req.on("login", (info, callback) => {
        if (info.isProxy && info.host === "127.0.0.1" && info.port === server.address()?.port) callback("omb", secret);
        else callback();
      });
      req.on("error", error => { clearTimeout(timer); reject(error); });
      req.on("response", response => {
        response.on("data", () => {});
        response.on("end", () => {
          clearTimeout(timer);
          if (response.statusCode === 204) resolve();
          else reject(new Error("Proxy authentication failed"));
        });
      });
      req.end();
    });
  };
  const login = (event, _contents, _request, authInfo, callback) => {
    if (authInfo.isProxy && authInfo.host === "127.0.0.1" && authInfo.port === server.address()?.port) {
      event.preventDefault();
      callback("omb", secret);
    }
  };
  return { endpoint, configureSession, login, environment: proxyEnvironment(original, endpoint), refresh, status: () => ({ ...status }),
    close: () => { clearInterval(timer); for (const socket of sockets) socket.destroy(); server.close(); } };
}
