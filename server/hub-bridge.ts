// /hub/*: the multi-agent-hub console (:8890) and its scheduler (:8790), reachable from inside OpenMausBot.
//
// Each handler has one hard-coded upstream. No caller-supplied URL is ever fetched, so this cannot be
// pointed at another host (SSRF); the only variable part is a path, and that path is normalised here.
// Everything degrades to { ok: false } when the hub is down: OpenMausBot itself never waits on it.
import { Buffer } from "node:buffer";
import { PASS, type RouteHandler } from "./routes/table.ts";

const CONSOLE = "http://127.0.0.1:8890";
const SCHEDULER = "http://127.0.0.1:8790/mcp";
/** A hub that is not answering in three seconds is reported as down, not waited on. */
const PROBE_MS = 3_000;
/** A check-in run really does the work, so it is given longer than a probe. */
const RUN_MS = 120_000;

/** The console's check-in endpoints, keyed by the part after `/checkin`. */
const CHECKIN_ROUTES: Record<string, "GET" | "POST"> = {
  "/status": "GET",
  "/projects": "GET",
  "/run": "POST",
  "/history/clear": "POST",
  "/config": "POST",
};

/** The console UI calls these absolute paths, so the embedded page keeps working under /hub/ui/. */
const CHECKIN_PREFIXES = ["/hub/checkin/", "/api/checkin/"] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

interface Upstream {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** One request to the console; null means it could not be reached (refused, timed out, DNS, ...). */
async function askConsole(method: "GET" | "POST", path: string, body?: string, timeoutMs = PROBE_MS): Promise<Upstream | null> {
  try {
    const response = await fetch(`${CONSOLE}${path}`, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      // Omitted entirely rather than passed as undefined: a GET that carries a body field is invalid, and the
      // quota relay added here only ever GETs.
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  } catch {
    return null;
  }
}

/** True when something is listening: any HTTP answer, even a 404, means the service is up. */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_MS) });
    await response.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** `/hub/ui/…` maps to the console's own root; anything that could escape it is refused before fetching. */
function staticPathFor(path: string): string | null {
  const rest = path.slice("/hub/ui".length);
  if (rest === "" || rest === "/") return "/";
  if (!rest.startsWith("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes("..") || decoded.includes("\0") || decoded.includes("\\")) return null;
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(decoded)) return null;
  return decoded;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

export function createHubBridgeRoutes(): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/hub/") && !path.startsWith("/api/checkin/")) return PASS;

    // A trailing slash keeps the console page's relative asset URLs under /hub/ui/.
    if (method === "GET" && path === "/hub/ui") {
      res.writeHead(302, { location: "/hub/ui/", "cache-control": "no-store" });
      res.end();
      return;
    }

    if (method === "GET" && path === "/hub/health") {
      const [consoleOk, schedulerOk] = await Promise.all([reachable(`${CONSOLE}/`), reachable(SCHEDULER)]);
      return json(res, 200, { console: { ok: consoleOk, url: CONSOLE }, scheduler: { ok: schedulerOk, url: SCHEDULER } });
    }

    // The console already aggregates each worker's remaining allowance; the daily page reads it through here so the
    // phone never needs a second origin (and a second sign-in) to see quotas.
    if (method === "GET" && path === "/hub/quota") {
      const upstream = await askConsole("GET", "/api/quota", undefined, 8_000);
      if (!upstream) return json(res, 502, { ok: false, error: "console_unreachable" });
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "content-length": String(upstream.body.length), "cache-control": "no-store" });
      res.end(upstream.body);
      return;
    }

    if (method === "GET" && (path === "/hub/ui/" || path.startsWith("/hub/ui/"))) {
      const upstreamPath = staticPathFor(path);
      if (!upstreamPath) return json(res, 400, { ok: false, error: "bad_path" });
      const upstream = await askConsole("GET", upstreamPath);
      if (!upstream) return json(res, 502, { ok: false, error: "console_unreachable" });
      const type = TYPES[extensionOf(upstreamPath)] ?? upstream.headers.get("content-type") ?? "application/octet-stream";
      const headers: Record<string, string> = { "content-type": type, "content-length": String(upstream.body.length), "cache-control": "no-store" };
      // The console's own policy, if it ever sends one, is forwarded untouched; framing must stay allowed for the iframe.
      const csp = upstream.headers.get("content-security-policy");
      if (csp) headers["content-security-policy"] = csp;
      res.writeHead(upstream.status, headers);
      res.end(upstream.body);
      return;
    }

    const wanted = CHECKIN_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!wanted) return PASS;
    const checkin = path.slice(path.indexOf("/checkin/") + "/checkin".length);
    const expected = CHECKIN_ROUTES[checkin];
    if (!expected) return PASS;
    if (method !== expected) return json(res, 405, { ok: false, error: "method_not_allowed" });

    if (method === "GET") {
      const upstream = await askConsole("GET", `/api/checkin${checkin}`);
      if (!upstream) return json(res, 502, { ok: false, error: "console_unreachable" });
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "content-length": String(upstream.body.length), "cache-control": "no-store" });
      res.end(upstream.body);
      return;
    }

    // The run body is passed through as sent ({ platform: "all" | "<name>" }); an empty body stays empty JSON.
    let body = "{}";
    try {
      const sent = await readBody(req, 64 * 1024);
      if (sent !== undefined && sent !== null) body = JSON.stringify(sent);
    } catch {
      return json(res, 400, { ok: false, error: "bad_body" });
    }
    const upstream = await askConsole("POST", `/api/checkin${checkin}`, body, checkin === "/run" ? RUN_MS : PROBE_MS);
    if (!upstream) return json(res, 502, { ok: false, error: "console_unreachable" });
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "content-length": String(upstream.body.length), "cache-control": "no-store" });
    res.end(upstream.body);
  };
}
