// The loopback door into the browser surface for the bot's own process.
//
// A bot's tools run inside its agent CLI, which the harness spawned — two
// processes away from the Electron main process that owns the views. The
// harness already talks to Electron-owned things through private bootstrap
// state: packaged builds send this host's descriptor over utilityProcess IPC;
// separate dev processes use a private descriptor file. This host is that
// door for the browser: bound to 127.0.0.1 on an ephemeral
// port, bearer-token gated, JSON in / JSON out, one route per verb.
//
// It exposes only the surface's verbs — never the app window, never the
// renderer, never a debugging port on OpenMausBot itself. The manager is
// looked up per request: windows come and go (macOS keeps the app alive
// with none open), the host and its token outlive them.
"use strict";

const http = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CAPABILITIES = 1_024;
const MAX_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000;
const OPERATIONS = new Set([
  "state",
  "navigate",
  "back",
  "forward",
  "snapshot",
  "click",
  "hover",
  "drag",
  "fill",
  "type",
  "press",
  "scroll",
  "select",
  "wait",
  "read",
  "screenshot",
]);
const BOT_ROUTE = /^\/v1\/bots\/([A-Za-z0-9_-]{1,120})\/([a-z]+)$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
// Empty = per-bot, "guest" = throwaway, mixed case = an exact read-only
// partition identity migrated from #567. Never normalize this value.
const PROFILE_PARTITION_ID = /^[A-Za-z0-9_-]{0,40}$/;
const CAPABILITY_ROUTE = /^\/v1\/capabilities\/(register|revoke|clear)$/;

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const isString = (value) => Object.prototype.toString.call(value) === "[object String]";

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (rejected) return;
      // Decode once after joining bytes: an arbitrary TCP chunk boundary may
      // split a multi-byte UTF-8 character.
      const raw = Buffer.concat(chunks, size).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && Object.prototype.toString.call(parsed) === "[object Object]" ? parsed : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function tokenMatches(received, expected) {
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const got = Buffer.from(received, "hex");
  const want = Buffer.from(expected, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Map a verb + body onto the manager; the body's field names are the tool
 * argument names the proxy uses, kept in one place here. */
async function perform(manager, botId, operation, body) {
  // Every host request is pinned to the exact profile authenticated by its
  // capability. Never fall through to whichever profile the UI left active.
  const profile = String(body.profile);
  switch (operation) {
    case "state":
      return manager.agentState?.(botId, profile) ?? manager.state(botId, profile);
    case "navigate":
      return manager.navigate(botId, body.url, profile);
    case "back":
      return manager.back(botId, profile);
    case "forward":
      return manager.forward(botId, profile);
    case "snapshot":
      return manager.snapshot(botId, profile);
    case "click":
      return manager.click(botId, body.ref, { button: body.button, clickCount: body.double === true ? 2 : 1, profile });
    case "hover":
      return manager.hover(botId, body.ref, profile);
    case "drag":
      return manager.drag(botId, body.from, body.to, profile);
    case "fill":
      return manager.fill(botId, body.ref, body.text, profile);
    case "type":
      return manager.type(botId, body.text, profile);
    case "press":
      return manager.press(botId, body.key, profile);
    case "scroll":
      return manager.scroll(botId, body.direction, body.amount, profile);
    case "select":
      return manager.select(botId, body.ref, body.values, profile);
    case "wait":
      return manager.waitFor(botId, { text: body.text, url: body.url, timeoutMs: body.timeoutMs }, profile);
    case "read":
      return manager.read(botId, profile);
    case "screenshot":
      return manager.screenshot(botId, profile);
    default:
      throw new Error(`unknown browser operation: ${operation}`);
  }
}

/** Agents never need query strings or fragments back from the browser host;
 * both routinely carry session and OAuth tokens. The renderer talks to the
 * manager directly and retains the real address. */
function sanitizeHostResult(result, operation) {
  if (!result || Object.prototype.toString.call(result) !== "[object Object]" || !isString(result.url)) return result;
  const sanitized = { ...result };
  // Page observations carry the same URL inside a convenience `text` field
  // used only by Electron-side diagnostics. The MCP proxy formats from the
  // structured fields, so do not expose that duplicate unsanitized channel.
  if (operation !== "read") delete sanitized.text;
  if (result.url === "about:blank") return sanitized;
  try {
    const url = new URL(result.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { ...sanitized, url: url.toString() };
  } catch {
    return { ...sanitized, url: "" };
  }
}

/**
 * @param {object} options
 * @param {() => (ReturnType<import("./browser-surface.cjs").createBrowserSurfaceManager> | null)} options.manager
 *   getter — the current window's surface, or null when no window is open
 * @param {string} [options.token] 64 hex chars; generated per boot when absent
 * @param {() => number} [options.now] injectable monotonic wall clock for
 *   deterministic capability-expiry tests
 */
function createBrowserHost({ manager, token = randomBytes(32).toString("hex"), now = Date.now }) {
  const currentManager = manager?.constructor === Function ? manager : () => manager;
  if (!manager) throw new Error("The browser surface manager is required");
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("The browser host token must be 64 hex characters");
  let server = null;
  let url = null;
  /** Per-turn opaque capabilities. Unlike a deterministic bot/profile HMAC,
   * these disappear at turn completion and cannot be retained by a stale
   * child process for the rest of the desktop boot. */
  const capabilities = new Map();

  const syncCapabilityPin = (botId, profile) => {
    const active = [...capabilities.values()].some((scope) => scope.botId === botId && scope.profile === profile);
    currentManager()?.setCapabilityActive?.(botId, profile, active);
  };

  /** Remove capabilities as one lifecycle transaction: invalidate in-flight
   * surface actions first, then update the view pins. Revocation is a hard
   * turn boundary, not merely a refusal of the next HTTP request. */
  const dropCapabilities = (predicate) => {
    const changed = new Map();
    const bots = new Set();
    for (const [capability, scope] of capabilities) {
      if (!predicate(scope, capability)) continue;
      capabilities.delete(capability);
      changed.set(`${scope.botId}\0${scope.profile}`, scope);
      bots.add(scope.botId);
    }
    for (const botId of bots) currentManager()?.cancelAgentActions?.(botId);
    for (const scope of changed.values()) syncCapabilityPin(scope.botId, scope.profile);
    return changed.size;
  };

  const pruneCapabilities = () => {
    const current = now();
    dropCapabilities((scope) => scope.expiresAt <= current);
  };

  const manageCapability = async (operation, req, res) => {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return json(res, 400, { error: error?.message ?? "invalid request" });
    }
    if (operation === "clear") {
      dropCapabilities(() => true);
      return json(res, 200, { ok: true });
    }
    const capability = isString(body.token) ? String(body.token) : "";
    if (!/^[0-9a-f]{64}$/.test(capability) || tokenMatches(capability, token)) {
      return json(res, 400, { error: "a valid opaque capability token is required" });
    }
    if (operation === "revoke") {
      dropCapabilities((_, candidate) => candidate === capability);
      return json(res, 200, { ok: true });
    }
    const botId = isString(body.botId) ? String(body.botId) : "";
    const profile = isString(body.profile) ? String(body.profile) : "";
    const requestedExpiry = Number(body.expiresAt);
    const current = now();
    if (!BOT_ID.test(botId) || !PROFILE_PARTITION_ID.test(profile)) {
      return json(res, 400, { error: "a valid bot and browser profile are required" });
    }
    if (!Number.isSafeInteger(requestedExpiry) || requestedExpiry <= current) {
      return json(res, 400, { error: "a future capability expiry is required" });
    }
    pruneCapabilities();
    const existing = capabilities.get(capability);
    if (existing && (existing.botId !== botId || existing.profile !== profile)) {
      return json(res, 409, { error: "that capability is already registered to another scope" });
    }
    // Registration is the authoritative start of a new browser turn. If a
    // prior best-effort revoke was lost with the server connection, do not
    // allow its bearer to overlap the new one for the crash-backstop TTL.
    if (!existing) dropCapabilities((scope) => scope.botId === botId);
    if (!existing && capabilities.size >= MAX_CAPABILITIES) {
      return json(res, 429, { error: "too many live browser capabilities" });
    }
    const expiresAt = Math.min(requestedExpiry, current + MAX_CAPABILITY_TTL_MS);
    capabilities.set(capability, { botId, profile, expiresAt });
    syncCapabilityPin(botId, profile);
    return json(res, 200, { ok: true, expiresAt });
  };

  const handle = async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: "loopback only" });
    const authorization = String(req.headers.authorization ?? "");
    const receivedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const path = String(req.url ?? "").split("?")[0];
    const surface = currentManager();
    const capabilityControl = CAPABILITY_ROUTE.exec(path);
    if (capabilityControl && req.method === "POST") {
      if (!tokenMatches(receivedToken, token)) return json(res, 401, { error: "unauthorized" });
      return manageCapability(capabilityControl[1], req, res);
    }
    if (req.method === "GET" && path === "/v1/health") {
      if (!tokenMatches(receivedToken, token)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { ok: true, views: surface ? surface.size() : 0, window: Boolean(surface) });
    }
    const match = BOT_ROUTE.exec(path);
    if (!match || req.method !== "POST") return json(res, 404, { error: "not found" });
    const [, botId, operation] = match;
    if (!OPERATIONS.has(operation)) return json(res, 404, { error: "unknown browser operation" });
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return json(res, 400, { error: error?.message ?? "invalid request" });
    }
    if (!Object.hasOwn(body, "profile") || !isString(body.profile)) {
      return json(res, 400, { error: "a browser profile is required" });
    }
    const profile = String(body.profile);
    pruneCapabilities();
    const capability = capabilities.get(receivedToken);
    if (!capability || capability.botId !== botId || capability.profile !== profile) {
      return json(res, 401, { error: "unauthorized" });
    }
    // A window may have been recreated after registration. Reassert the pin
    // before perform() can create a ninth view and run the LRU.
    surface?.setCapabilityActive?.(botId, profile, true);
    // Explicit turn-completion revocation is primary. Registration's
    // absolute two-hour expiry is a hard crash/revoke-failure backstop; a
    // retained proxy cannot keep itself alive by making requests.
    if (!surface) return json(res, 503, { error: "the OpenMausBot window is closed — open it to use the browser" });
    const beforeLease = surface.controlLease?.(botId, profile)
      ?? { held: surface.isHumanControlled?.(botId, profile) === true, epoch: 0 };
    if (beforeLease.held) {
      return json(res, 409, { error: "Browser control is currently held by the user — wait until they hand it back" });
    }
    try {
      const result = await perform(surface, botId, operation, body);
      const afterLease = surface.controlLease?.(botId, profile) ?? beforeLease;
      if (afterLease.held || afterLease.epoch !== beforeLease.epoch) {
        return json(res, 409, { error: "Browser control changed while the request was running — retry after the user hands it back" });
      }
      if (afterLease.agentEpoch !== beforeLease.agentEpoch || capabilities.get(receivedToken) !== capability || capability.expiresAt <= now()) {
        if (capability.expiresAt <= now()) pruneCapabilities();
        return json(res, 409, { error: "The browser action was cancelled because its turn ended" });
      }
      return json(res, 200, sanitizeHostResult(result ?? {}, operation));
    } catch (error) {
      const message = error?.message ?? String(error);
      if (/control is currently held|control changed|turn ended|action was cancelled|unavailable (?:while|after) human|unavailable while a protected field|browser actions are unavailable/i.test(message)) {
        return json(res, 409, { error: message });
      }
      // Stale refs, refused navigations and timeouts are the bot's to correct;
      // everything else is the surface's.
      const status = /stale|unknown|not visible|gone|required|invalid|limited|unsupported|Only |private-network|blocked|no previous|no next|must be|timed out|no option|not a select|changed since/i.test(message)
        ? 400
        : 500;
      return json(res, status, { error: message });
    }
  };

  return {
    get token() {
      return token;
    },
    get url() {
      return url;
    },
    start() {
      if (url) return Promise.resolve(url);
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          try {
            json(res, 500, { error: error?.message ?? "browser host failure" });
          } catch {}
        });
      });
      server.on("connection", (socket) => {
        if (!isLoopback(socket.remoteAddress)) socket.destroy();
      });
      return new Promise((resolve, reject) => {
        const fail = (error) => {
          const failed = server;
          server = null;
          url = null;
          try {
            failed?.close();
          } catch {}
          reject(error);
        };
        const reportBoundError = (error) => {
          // The one-shot startup handler below is removed after binding, but
          // http.Server can still emit errors later. Keep those errors handled
          // so a transient listener/socket failure cannot crash Electron.
          if (url) console.error("[browser-host] server error after binding:", error);
        };
        server.on("error", reportBoundError);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", fail);
          const address = server.address();
          url = `http://127.0.0.1:${address.port}`;
          resolve(url);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        dropCapabilities(() => true);
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
        url = null;
      });
    },
    clearCapabilities() {
      dropCapabilities(() => true);
    },
    revokeCapabilitiesForBot(botId) {
      dropCapabilities((scope) => scope.botId === botId);
    },
    revokeCapabilitiesForProfile(profile) {
      dropCapabilities((scope) => scope.profile === profile);
    },
    get capabilityCount() {
      pruneCapabilities();
      return capabilities.size;
    },
    /** What the harness needs to reach this host: transported privately. */
    descriptor() {
      if (!url) throw new Error("The browser host is not listening");
      return { version: 1, url, token, pid: process.pid };
    },
  };
}

module.exports = { MAX_CAPABILITIES, OPERATIONS, createBrowserHost };
