// A Mac app opened from Finder or the Dock never gets the shell's proxy variables, so on a network that only reaches the
// internet through a proxy set in System Settings, the server's HTTPS calls (ChatGPT sign-in, model APIs) fail.
import { execFile } from "node:child_process";

const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
/** Node's env proxy, unlike curl, does not exempt loopback, and matches an IPv6 host only bracketed ("[::1]"). */
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** The HTTPS proxy at the top level of `scutil --proxy`, with its exceptions, or null when it is off or half set.
 * Only HTTPS: on Node 24 a plain http:// request through an env proxy hangs, so http:// stays direct. No PAC or SOCKS. */
export function macProxyFromScutil(output) {
  const top = {};
  const exceptions = [];
  let depth = 0;
  let inExceptions = false;
  for (const raw of String(output ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "}") {
      depth -= 1;
      if (depth === 1) inExceptions = false;
      continue;
    }
    const match = /^(\S+) : (.*)$/.exec(line);
    if (line.endsWith("{")) {
      if (depth === 1 && match?.[1] === "ExceptionsList") inExceptions = true;
      depth += 1;
      continue;
    }
    if (!match) continue;
    if (depth === 1) top[match[1]] = match[2].trim();
    else if (depth === 2 && inExceptions && match[2].trim()) exceptions.push(match[2].trim());
  }
  const host = top.HTTPSProxy;
  const port = Number(top.HTTPSPort);
  if (top.HTTPSEnable !== "1" || !host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { https: `http://${host.includes(":") ? `[${host}]` : host}:${port}`, exceptions };
}

/** Node's proxy matcher skips CIDR ("169.254/16", macOS's default exception) but honours an IPv4 range, so convert. */
export function cidrAsRange(entry) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){0,3})\/(\d{1,2})$/.exec(entry);
  if (!match) return entry;
  const octets = match[1].split(".").map(Number);
  const bits = Number(match[2]);
  if (octets.some((octet) => octet > 255) || bits > 32) return entry;
  while (octets.length < 4) octets.push(0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const start = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  const dotted = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");
  return `${dotted(start)}-${dotted(end)}`;
}

function scutilProxy() {
  return new Promise((resolve) => {
    execFile("/usr/sbin/scutil", ["--proxy"], { timeout: 2_000, encoding: "utf8" }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

/** The env the server child needs to use the Mac's system HTTPS proxy: nothing off a Mac, when the environment already
 * names a proxy (it always wins), without a system proxy, or when scutil fails. A NO_PROXY already set is kept. */
export async function systemProxyEnvironment({ platform = process.platform, env = process.env, read = scutilProxy } = {}) {
  if (platform !== "darwin" || PROXY_ENV.some((name) => env[name])) return {};
  const proxy = macProxyFromScutil(await read());
  if (!proxy) return {};
  const own = [env.NO_PROXY, env.no_proxy].flatMap((list) => (list ?? "").split(",")).map((entry) => entry.trim()).filter(Boolean);
  if (own.includes("*")) return {}; // The person bypasses the proxy for every host; fetch honours "*" only as the whole value.
  const bypass = [...new Set([...own, ...proxy.exceptions.map(cidrAsRange), ...LOOPBACK])].join(",");
  return { HTTPS_PROXY: proxy.https, https_proxy: proxy.https, NO_PROXY: bypass, no_proxy: bypass, NODE_USE_ENV_PROXY: "1" };
}

/** The last lookup, read without waiting when a server child launches: an await between startServerOn's shutdown check
 * and its fork would let a recovery restart and an environment switch both fork a child. */
export function createSystemProxyCache(lookup = systemProxyEnvironment) {
  let latest = {};
  let started = 0;
  return {
    latest: () => latest,
    async refresh() {
      const generation = ++started;
      const found = await lookup();
      if (generation === started) latest = found;
    },
  };
}
