// The messages the desktop main process and its own server exchange about the bots' browser panes, over the utility
// process's parent port. Security: only Electron's main process can post on that port, so the port itself is the
// authentication; every message is still checked here, on both sides, before anything acts on it.
export const PANE_MESSAGE = "openmausbot:browser-pane";

/** Tabs one profile's browser may have open, as for a launched Chrome. */
export const PANE_TABS_PER_BROWSER = 8;

/** A profile's partition: persistent per profile, or in memory with a nonce for a temporary one. */
export const PANE_PARTITION = /^(?:persist:omb-pane-[0-9a-f]{24}|omb-pane-[0-9a-f]{24}-[0-9a-f]{8})$/;
const BROWSER = /^(?:bot|shared|temp):[A-Za-z0-9._:@-]{1,200}$/;
const TAB = /^p[1-9]\d{0,9}$/;
const SESSION = /^[\w.:-]{1,128}$/;
const METHOD = /^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/;
const BOT = /^[\w.-]{1,128}$/;
const GUID = /^[0-9a-f-]{36}$/;
const DOWNLOAD_STATES = new Set(["begin", "inProgress", "completed", "canceled"]);
/** An absolute folder or file path, POSIX or Windows, with no parent steps. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\0]{0,4095}$/;

const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;
const SAME_SITE = new Set(["unspecified", "no_restriction", "lax", "strict"]);
/** Chromium's own limit on a cookie's name and value together. */
const COOKIE_BYTES = 4096;
const MAX_COOKIES = 2000;

const TO_MAIN = new Set(["hello", "open", "create", "cdp", "front", "close-tab", "close", "erase", "resolved", "cancel-download", "set-cookies", "cookie-sources-result", "cookie-import-result", "cookie-offer-result", "hold-result"]);
const TO_SERVER = new Set(["hello", "opened", "failed", "created", "answer", "event", "tab", "tab-gone", "closed", "input", "which", "download", "cookies-set", "cookie-sources", "cookie-import", "cookie-offer", "hold", "let-go"]);

const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
const text = (value, pattern) => typeof value === "string" && pattern.test(value);
const optional = (value, pattern) => value === undefined || text(value, pattern);
const count = (value) => Number.isSafeInteger(value) && value > 0;
const tally = (value) => Number.isSafeInteger(value) && value >= 0;
const short = (value, limit) => typeof value === "string" && value.length <= limit && !value.includes("\0");

/** Electron's cookies.set details, as an import writes them into a pane's partition. */
function cookieValid(cookie) {
  return isObject(cookie) && short(cookie.url, 4096) && /^https?:\/\//.test(cookie.url) && short(cookie.name, COOKIE_BYTES) && short(cookie.value, COOKIE_BYTES)
    && cookie.name.length + cookie.value.length <= COOKIE_BYTES && (cookie.domain === undefined || short(cookie.domain, 253)) && short(cookie.path, 1024)
    && typeof cookie.secure === "boolean" && typeof cookie.httpOnly === "boolean" && SAME_SITE.has(cookie.sameSite)
    && (cookie.expirationDate === undefined || Number.isFinite(cookie.expirationDate));
}

function sourcesValid(sources) {
  return Array.isArray(sources) && sources.length <= 64 && sources.every((source) => isObject(source) && text(source.id, SOURCE) && short(source.name, 80)
    && ["chromium", "firefox", "safari"].includes(source.engine) && Array.isArray(source.profiles) && source.profiles.length <= 64
    && source.profiles.every((profile) => isObject(profile) && short(profile.id, 512) && short(profile.name, 80)));
}

function fieldsValid(message) {
  const { op } = message;
  if ("browser" in message && !(op === "resolved" && message.browser === null) && !text(message.browser, BROWSER)) return false;
  if ("tab" in message && !text(message.tab, TAB)) return false;
  if ("req" in message && !count(message.req)) return false;
  if ("session" in message && !optional(message.session, SESSION)) return false;
  if ("method" in message && !text(message.method, METHOD)) return false;
  if ("params" in message && !isObject(message.params)) return false;
  if ("partition" in message && !text(message.partition, PANE_PARTITION)) return false;
  switch (op) {
    case "open": return text(message.partition, PANE_PARTITION) && Number.isInteger(message.egress) && message.egress > 0 && message.egress < 65_536 && text(message.downloads, ABSOLUTE)
      && (message.identity === "native" || message.identity === "cleaned");
    case "failed": return typeof message.error === "string" && (message.reason === undefined || message.reason === "no-window");
    case "cancel-download": return text(message.guid, GUID);
    case "download": return text(message.tab, TAB) && text(message.guid, GUID) && DOWNLOAD_STATES.has(message.state)
      && optional(message.path, ABSOLUTE) && (message.url === undefined || typeof message.url === "string") && (message.name === undefined || typeof message.name === "string")
      && (message.received === undefined || Number.isFinite(message.received)) && (message.total === undefined || Number.isFinite(message.total));
    case "erase": return text(message.partition, PANE_PARTITION);
    case "create": return count(message.req) && typeof message.url === "string" && message.url.length <= 8192;
    case "cdp": return count(message.req) && text(message.tab, TAB) && text(message.method, METHOD) && isObject(message.params);
    case "front": case "close-tab": case "tab-gone": return text(message.tab, TAB);
    case "created": case "tab": return text(message.tab, TAB) && text(message.target, SESSION) && typeof message.url === "string" && typeof message.title === "string" && optional(message.opener, TAB);
    case "answer": return count(message.req) && (isObject(message.result) || isObject(message.error));
    case "event": return text(message.tab, TAB) && text(message.method, METHOD) && isObject(message.params);
    case "which": return count(message.req) && text(message.botId, BOT) && (message.threadId === null || text(message.threadId, BOT));
    case "resolved": return count(message.req);
    case "set-cookies": return count(message.req) && Array.isArray(message.cookies) && message.cookies.length <= MAX_COOKIES && message.cookies.every(cookieValid);
    case "cookies-set": return count(message.req) && tally(message.written) && tally(message.refused);
    case "cookie-sources": return count(message.req);
    case "cookie-sources-result": return count(message.req) && sourcesValid(message.sources);
    case "cookie-import": case "cookie-offer":
      return count(message.req) && text(message.botId, BOT) && (message.threadId === null || text(message.threadId, BOT)) && short(message.site, 2048)
        && (message.op === "cookie-offer" || (text(message.source, SOURCE) && short(message.profile, 512) && message.profile.length > 0));
    case "cookie-import-result": return count(message.req) && isObject(message.result) && typeof message.result.ok === "boolean";
    case "hold": return count(message.req) && text(message.botId, BOT) && (message.threadId === null || text(message.threadId, BOT)) && text(message.browser, BROWSER) && text(message.tab, TAB) && typeof message.held === "boolean";
    case "hold-result": return count(message.req) && typeof message.held === "boolean";
    case "let-go": return true;
    case "cookie-offer-result": return count(message.req) && typeof message.offered === "boolean" && (message.reason === undefined || short(message.reason, 32));
    default: return true;
  }
}

function read(raw, ops) {
  if (!isObject(raw) || raw.type !== PANE_MESSAGE || !ops.has(raw.op)) return null;
  return fieldsValid(raw) ? raw : null;
}

/** A message for the main process, or null when it is not one or is malformed. */
export function paneMessageToMain(raw) {
  return read(raw, TO_MAIN);
}

/** A message for the server, or null when it is not one or is malformed. */
export function paneMessageToServer(raw) {
  return read(raw, TO_SERVER);
}
