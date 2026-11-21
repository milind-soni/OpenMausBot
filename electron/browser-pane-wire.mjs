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

const TO_MAIN = new Set(["hello", "open", "create", "cdp", "front", "close-tab", "close", "erase", "resolved", "cancel-download"]);
const TO_SERVER = new Set(["hello", "opened", "failed", "created", "answer", "event", "tab", "tab-gone", "closed", "input", "which", "download"]);

const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
const text = (value, pattern) => typeof value === "string" && pattern.test(value);
const optional = (value, pattern) => value === undefined || text(value, pattern);
const count = (value) => Number.isSafeInteger(value) && value > 0;

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
    case "open": return text(message.partition, PANE_PARTITION) && Number.isInteger(message.egress) && message.egress > 0 && message.egress < 65_536 && text(message.downloads, ABSOLUTE);
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

/**
 * Hosts that get Electron's own user agent instead of the stripped one. Known open risk: sign-in walls (Google's
 * "this browser may not be secure", Cloudflare Turnstile) judge embedded browsers by it, and which choice passes is not
 * settled; a host goes here only after a live test in the app.
 */
export const PANE_UA_HOSTS = new Map();

/** The user agent a pane sends to `host`: Electron's with the app's tokens taken out, so sites see the Chromium it is. */
export function paneUserAgent(userAgent, host = "", hosts = PANE_UA_HOSTS) {
  if (hosts.get(String(host).toLowerCase()) === "electron") return String(userAgent);
  return String(userAgent).replace(/\s(?:Electron|OpenMausBot|openmausbot)\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
}
