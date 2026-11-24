// How this app's Electron sessions and listeners meet the local OpenMausBot server. The server treats the app window
// as its owner only by a header the default session adds; no other session (desktop viewers, VM panes) may reach the
// server at all; and the server learns every port this app listens on, so its bots' browsers never reach them.
import { subscribe } from "node:diagnostics_channel";
import { isIP } from "node:net";

import authModule from "./desktop-server-auth.cjs";

const { DESKTOP_MUTATION_HEADER } = authModule;

function loopbackHost(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost") || bare === "0.0.0.0" || bare === "::") return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  return isIP(bare) === 6 && (bare === "::1" || /^::ffff:7f[0-9a-f]{2}:/.test(bare));
}

const profileSessions = new Map();
const savedOrigins = new WeakMap();

export function restrictSessionToOrigin(browser, origin) {
  savedOrigins.set(browser, origin);
}

function outsideSavedOrigin(url, browser) {
  const origin = savedOrigins.get(browser);
  if (!origin) return false;
  const target = URL.parse(url);
  if (target?.protocol === "blob:" || target?.protocol === "data:") return false;
  return target?.origin.replace(/^ws(s?):/, "http$1:") !== origin;
}

export function reserveProfilePort(port) {
  if (profileSessions.has(port)) throw new Error("The workspace port is already in use.");
  profileSessions.set(port, null);
  return { allow: browser => profileSessions.set(port, browser), release: () => profileSessions.delete(port) };
}

function otherServer(url, browser, primaryPort) {
  const target = URL.parse(url);
  if (!target || !["http:", "https:", "ws:", "wss:"].includes(target.protocol) || !loopbackHost(target.hostname)) return false;
  const port = Number(target.port || (target.protocol === "https:" || target.protocol === "wss:" ? 443 : 80));
  const owner = profileSessions.get(port);
  return port === primaryPort || (owner !== undefined && owner !== browser);
}

/**
 * `ownerToken()` is the desktop capability, or null while there is none to send. Chromium adds the header below
 * JavaScript, on http: and ws: alike, so a shell using curl cannot impersonate the person at the desktop.
 */
export function installServerSessions({ app, defaultSession, serverPort, ownerToken }) {
  defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: profileSessions.size > 0 && otherServer(details.url, defaultSession),
  }));
  defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const token = ownerToken();
    let owns = false;
    try {
      const target = new URL(details.url);
      owns = token !== null && (target.protocol === "http:" || target.protocol === "ws:") &&
        target.hostname === "127.0.0.1" && Number(target.port || 80) === serverPort();
    } catch {}
    callback({ requestHeaders: owns ? { ...details.requestHeaders, [DESKTOP_MUTATION_HEADER]: token } : details.requestHeaders });
  });
  app.on("session-created", (created) => {
    if (created === defaultSession) return;
    created.webRequest.onBeforeRequest((details, callback) => callback({ cancel: outsideSavedOrigin(details.url, created) || otherServer(details.url, created, serverPort()) }));
  });
}

const ownPorts = new Set();
const subscribers = new Set();

function report() {
  const message = { type: "openmausbot:own-listeners", ports: [...ownPorts] };
  for (const proc of subscribers) {
    try { proc.postMessage(message); } catch { subscribers.delete(proc); }
  }
}

subscribe("tracing:net.server.listen:asyncEnd", ({ server }) => {
  const address = server?.address();
  if (!address || typeof address !== "object" || ownPorts.has(address.port)) return;
  ownPorts.add(address.port);
  report();
});

/** Tells a server that has just become ready which ports this app listens on, and tells it again as more open. */
export function reportOwnListeners(proc, ports = []) {
  for (const port of ports) ownPorts.add(port);
  if (!subscribers.has(proc)) proc.once?.("exit", () => subscribers.delete(proc));
  subscribers.add(proc);
  report();
}
