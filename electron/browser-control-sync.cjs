"use strict";

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const PROFILE_ID = /^[a-z0-9_-]{1,40}$/;

/** Accept only a positive hold assertion from the private server child.
 * A server-side `held:false` may be caused by a loopback release request, so
 * it must never clear Electron's local gate. Only the trusted Browser panel
 * release IPC can do that, after its server-first release succeeds. */
function applyBrowserControlHold(message, take) {
  if (!message || Object.prototype.toString.call(message) !== "[object Object]") return false;
  if (message.type !== "openmausbot:browser-control") return false;
  if (message.held !== true || !BOT_ID.test(String(message.botId ?? ""))) {
    throw new Error("invalid browser-control hold message");
  }
  if (!(take instanceof Function)) throw new Error("browser-control receiver is unavailable");
  take(String(message.botId));
  return true;
}

/** Decode server-authoritative lifecycle cleanup messages carried on the
 * same private utilityProcess port as the browser descriptor. They are never
 * accepted from the renderer or loopback HTTP. */
function decodeBrowserLifecycleMessage(message) {
  if (!message || Object.prototype.toString.call(message) !== "[object Object]") return null;
  if (message.type === "openmausbot:browser-bot-deleted") {
    const botId = String(message.botId ?? "");
    if (!BOT_ID.test(botId)) throw new Error("invalid browser bot-deleted message");
    return { type: "bot-deleted", botId };
  }
  if (message.type === "openmausbot:browser-profile-deleted") {
    const profileId = String(message.profileId ?? "");
    if (!PROFILE_ID.test(profileId) || profileId === "guest") {
      throw new Error("invalid browser profile-deleted message");
    }
    return { type: "profile-deleted", profileId };
  }
  return null;
}

module.exports = { applyBrowserControlHold, decodeBrowserLifecycleMessage };
