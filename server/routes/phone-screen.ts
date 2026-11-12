import { WebSocket, WebSocketServer, type RawData } from "ws";

import { STREAM_CLOSE } from "../browser/viewers/stream-v2.ts";
import { parseDevices, resolveAdbPath } from "../drivers/phone-proxy.ts";
import type { PhoneHold } from "../phone-screen/hold.ts";
import { ADB_MISSING, createPhoneScreenHub, type PhoneInput } from "../phone-screen/hub.ts";
import { ensureScrcpyServer } from "../phone-screen/scrcpy-server-file.ts";
import { KEYCODES } from "../phone-screen/scrcpy-wire.ts";
import { runAdb } from "../phone-screen/session.ts";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

const LIST = "/api/usb-phones";
const STREAM = /^\/api\/usb-phones\/([\w.-]{1,64})\/stream$/;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_TEXT_LENGTH = 300;
// scrcpy's touch message carries the video's width and height as 16-bit numbers.
const MAX_VIDEO_SIDE = 65_535;
const RECHECK_MS = 5_000;
const PING_MS = 15_000;
// RFC 6455, section 5.5: a close frame's reason is at most 123 bytes.
const MAX_REASON_BYTES = 123;
const TAG = { config: Buffer.from([1]), key: Buffer.from([2]), delta: Buffer.from([3]) };
const NO_LONGER_AVAILABLE = "This phone view is no longer available.";

export interface PhoneScreenRouteDeps {
  upgrades: Upgrades;
  /** Read on every request: while false both routes are absent, and nothing runs adb or downloads. */
  enabled(): boolean;
  /** Whether the sign-in a stream was opened with still stands. */
  live(auth: RequestAuth): boolean;
  /** The person's hold on the phone. Every stream may take it and hand it back; its changes come back through `holdChanged`. */
  hold: Pick<PhoneHold, "held" | "take" | "release" | "used" | "watched">;
  /** The scrcpy server file is kept under it. */
  dataDir: string;
  /** A verified scrcpy server file; `ensureScrcpyServer(dataDir)` when unset. */
  serverFile?: () => Promise<string>;
  /** The adb executable; `resolveAdbPath()` when unset. */
  adbPath?: () => string | null;
}

type UsbPhones =
  | { available: true; devices: ReturnType<typeof parseDevices> }
  | { available: false; reasonCode: "adb-unavailable" | "adb-failed"; message: string; devices: [] };

async function usbPhones(adbPath: string | null): Promise<UsbPhones> {
  if (!adbPath) return { available: false, reasonCode: "adb-unavailable", message: ADB_MISSING, devices: [] };
  try {
    const devices = parseDevices(await runAdb(adbPath, ["devices", "-l"]));
    return { available: true, devices: devices.filter((device) => device.connection === "usb") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reasonCode: "adb-failed", message: message.replaceAll(adbPath, "adb"), devices: [] };
  }
}

function closeReason(text: string): string {
  let reason = text.slice(0, MAX_REASON_BYTES);
  while (Buffer.byteLength(reason) > MAX_REASON_BYTES) reason = reason.slice(0, -1);
  return reason;
}

const controlMessage = (held: boolean) => JSON.stringify({ type: "control", held });

function clientMessage(data: RawData, isBinary: boolean): Record<string, unknown> | undefined {
  if (isBinary) return undefined;
  try {
    const message: unknown = JSON.parse(data.toString());
    return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isSide = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_VIDEO_SIDE;
const isWithin = (value: unknown, side: number): value is number => Number.isFinite(value) && (value as number) >= 0 && (value as number) < side;

/** What a client asks the phone to do, or nothing when the message is not one of the three kinds or is out of range. */
function phoneInput({ type, action, x, y, w, h, key, text }: Record<string, unknown>): PhoneInput | undefined {
  if (type === "key") return typeof key === "string" && Object.hasOwn(KEYCODES, key) ? { type, key: key as keyof typeof KEYCODES } : undefined;
  if (type === "text") return typeof text === "string" && text.length >= 1 && text.length <= MAX_TEXT_LENGTH ? { type, text } : undefined;
  if (type !== "touch" || (action !== "down" && action !== "move" && action !== "up")) return undefined;
  if (!isSide(w) || !isSide(h) || !isWithin(x, w) || !isWithin(y, h)) return undefined;
  return { type, action, x: Math.floor(x), y: Math.floor(y), w, h };
}

export function createPhoneScreenRoutes(deps: PhoneScreenRouteDeps): {
  route: RouteHandler;
  /** For the hold's `onChange`: tells every open stream, after lifting every finger when the hold has ended. */
  holdChanged(held: boolean): void;
  closeForOwner(sessionId: string): void;
  closeAll(): Promise<void>;
} {
  const adbPath = deps.adbPath ?? (() => resolveAdbPath());
  const hub = createPhoneScreenHub({ adbPath, serverFile: deps.serverFile ?? (() => ensureScrcpyServer(deps.dataDir)) });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
  const streams = new Map<WebSocket, { auth: RequestAuth; close(code: number, reason: string): void }>();
  deps.upgrades.route((path) => deps.enabled() && STREAM.test(path));

  const route: RouteHandler = async ({ req, res, path, method, auth, json }) => {
    const serial = STREAM.exec(path)?.[1];
    if ((path !== LIST && !serial) || !deps.enabled()) return PASS;
    res.setHeader("cache-control", "no-store");
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (!serial) return json(res, 200, await usbPhones(adbPath()));
    const pending = deps.upgrades.pending(req);
    if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
    if (!isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
    const phones = await usbPhones(adbPath());
    if (!deps.enabled()) {
      res.writeHead(404).end();
      return;
    }
    if (!deps.live(auth)) return json(res, 401, { error: "Viewer access expired" });
    const phone = phones.devices.find((device) => device.serial === serial);
    if (phones.available && !phone) return json(res, 404, { error: "That USB phone is not connected." });
    if (phone?.state === "unauthorized") return json(res, 409, { error: "Unlock the phone and accept Allow USB debugging" });
    if (phone && phone.state !== "device") return json(res, 409, { error: `The Android device is ${phone.state}` });
    if (pending.socket.destroyed) return;
    pending.release();
    sockets.handleUpgrade(req, pending.socket, pending.head, (ws) => {
      let leave = () => {};
      const close = (code: number, reason: string) => {
        leave();
        try { ws.close(code, closeReason(reason)); } catch { ws.terminate(); }
      };
      ws.on("error", () => leave());
      if (!phones.available) return close(STREAM_CLOSE.failed, phones.message);
      streams.set(ws, { auth, close });
      deps.hold.watched(true);
      ws.send(controlMessage(deps.hold.held));
      const viewer = {
        send: (kind: keyof typeof TAG, data: Buffer) => ws.send(Buffer.concat([TAG[kind], data])),
        close,
        buffered: () => ws.bufferedAmount,
      };
      leave = hub.watch(serial, viewer);
      const stillAllowed = () => {
        if (deps.enabled() && deps.live(auth)) return true;
        if (!deps.enabled()) deps.hold.release();
        close(STREAM_CLOSE.gone, NO_LONGER_AVAILABLE);
        return false;
      };
      const recheck = setInterval(stillAllowed, RECHECK_MS);
      recheck.unref();
      ws.on("message", (data, isBinary) => {
        const message = clientMessage(data, isBinary);
        if (!message || ws.readyState !== WebSocket.OPEN || !stillAllowed()) return;
        if (message.type === "take") return deps.hold.take();
        if (message.type === "handBack") return deps.hold.release();
        const input = phoneInput(message);
        if (!input || !deps.hold.held) return;
        deps.hold.used();
        hub.input(serial, viewer, input);
      });
      let answered = true;
      const ping = setInterval(() => {
        if (!answered) return ws.terminate();
        answered = false;
        ws.ping();
      }, PING_MS);
      ping.unref();
      ws.on("pong", () => { answered = true; });
      ws.once("close", () => {
        clearInterval(recheck);
        clearInterval(ping);
        leave();
        streams.delete(ws);
        if (streams.size === 0) deps.hold.watched(false);
      });
    });
    res.detachSocket(pending.socket);
  };

  return {
    route,
    holdChanged(held) {
      if (!held) hub.liftAll();
      for (const ws of streams.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(controlMessage(held));
    },
    closeForOwner(sessionId) {
      for (const { auth, close } of streams.values()) {
        if (auth.kind === "session" && auth.session.id === sessionId) close(STREAM_CLOSE.gone, NO_LONGER_AVAILABLE);
      }
    },
    closeAll: () => hub.closeAll(),
  };
}
