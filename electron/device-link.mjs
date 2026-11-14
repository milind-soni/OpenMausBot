// A lent computer's end of the device link: one WebSocket to My Cloud, through which My Cloud's browsers reach the web
// from this computer's own internet connection. Lending keeps it open; this runs one connection of it.
import { createChromeDoor } from "./device-chrome.mjs";
import { createDeviceEgress } from "./device-egress.mjs";
import { createLinkMux } from "./device-link-protocol.mjs";

const PING_MS = 10_000;
/** An opening that has not finished by now never will (a proxy that took the connection and went quiet): give up, so
 * lending dials again. */
const OPEN_MS = 15_000;
/** Nothing heard for this long: My Cloud is gone without closing (asleep, its network down), so the link ends here. */
const SILENT_MS = 25_000;

/** The link's address on My Cloud for this lent computer. */
export function linkUrl(origin, path) {
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * Runs one link connection until it ends, then resolves with its close code and reason; `signal` aborting ends it.
 * `egress`: what the computer's own check takes (resolve, connect, interfaces), for tests. `onStream(target, result)`:
 * each connection My Cloud asked for, with what this computer's check answered. `lends()`: what this computer lends right
 * now, read on every stream, so My Cloud is never taken at its word. `chrome`: the Chrome door's options, or an object
 * with its own `open` to stand in for the door.
 */
export function runDeviceLink({ url, headers = {}, egress = {}, signal, WebSocket: Socket = globalThis.WebSocket, pingMs = PING_MS, silentMs = SILENT_MS, openMs = OPEN_MS, lends = () => ({ internet: true, chrome: false }), chrome = {}, onOpen = () => {}, onStream = () => {}, traffic = () => {}, now = Date.now }) {
  return new Promise((done) => {
    let seenAs = null;
    let heard = now();
    let finished = false;
    let ws;
    try { ws = new Socket(url, { headers }); }
    catch { done({ code: 1006, reason: "" }); return; }
    ws.binaryType = "arraybuffer";
    const send = (frame) => { try { ws.send(frame); } catch {} };
    const deviceEgress = createDeviceEgress({ ...egress, seenAs: () => seenAs });
    const chromeDoor = typeof chrome.open === "function" ? chrome : createChromeDoor(chrome);
    const mux = createLinkMux({ send, traffic, accept: async (target) => {
      const isChrome = target.chrome === true;
      const grant = lends();
      const result = !(isChrome ? grant.chrome : grant.internet) ? { refused: "not-lent" } : isChrome ? await chromeDoor.open() : await deviceEgress.open(target);
      try { onStream(target, result); } catch {}
      return result;
    } });
    let pinger = null;
    const opening = setTimeout(() => finish(1006, "timeout"), openMs);
    opening.unref?.();
    const finish = (code, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(opening);
      clearInterval(pinger);
      signal?.removeEventListener("abort", stop);
      mux.close();
      try { ws.close(); } catch {}
      done({ code, reason });
    };
    const stop = () => finish(1000, "stopped");
    if (signal?.aborted) { stop(); return; }
    signal?.addEventListener("abort", stop, { once: true });
    ws.onopen = () => {
      clearTimeout(opening);
      heard = now();
      onOpen();
      pinger = setInterval(() => {
        if (now() - heard > silentMs) finish(1006, "silent");
        else send(JSON.stringify({ t: "ping" }));
      }, pingMs);
      pinger.unref?.();
    };
    ws.onmessage = ({ data }) => {
      heard = now();
      if (typeof data === "string") {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message?.t === "hello") { seenAs = typeof message.seenAs === "string" ? message.seenAs : null; return; }
        if (message?.t === "pong") return;
      }
      mux.receive(data);
    };
    ws.onclose = ({ code, reason }) => finish(code, reason);
  });
}
