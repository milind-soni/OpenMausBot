// Paired phones. The harness trusts loopback, so off loopback a device token is
// the credential. Only its SHA-256 is stored: a stolen devices.json is not a
// stolen fleet.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the bearer token — never the token itself */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  /** Off on every new and migrated device until the computer owner enables it. */
  cloudDesktopAccess: boolean;
  /** A separate grant from cloudDesktopAccess: a browser signed into the
   * person's real accounts is a different risk from a disposable VM. Off on
   * every new and migrated device until the computer owner enables it. */
  browserControlAccess: boolean;
  /** "local": Wi-Fi and Tailscale only. The relay never admits it and its psk is never tried there. */
  routes: DeviceRoutes;
  /** First end-to-end encrypted session. From then on its token is refused on the plain listener. */
  e2eAt?: number;
}

export type DeviceRoutes = "any" | "local";

export type PublicDevice = Omit<DeviceRecord, "tokenHash">;

/** `token` rides in the QR, has enough entropy to stand alone and is never
 * persisted. `code` is six digits, so it lives two minutes and dies after a
 * few wrong guesses. Redeeming either burns both. */
export interface PairingWindow {
  code: string;
  token: string;
  expiresAt: number;
  attemptsLeft: number;
}

/** Lets the same request recover a lost response through another advertised
 * address. The token stays memory-only; a replay needs the original pairing
 * credential and the client's request id. */
interface PairingReplay {
  requestId: string;
  credentialHash: string;
  expiresAt: number;
  result: { device: PublicDevice; token: string };
}

const DEVICES_FILE = join(DATA_DIR, "devices.json");
export const PAIRING_TTL_MS = 120_000;
export const MAX_PAIRING_ATTEMPTS = 5;
export const MAX_DEVICES = 20;
/** lastSeen is a UI nicety, not an audit log. */
const LAST_SEEN_WRITE_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant-time: a plain === leaks a prefix through timing. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function sameCredential(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Untrusted display text from the phone. */
export function cleanDeviceName(raw: unknown): string {
  const name = String(raw ?? "")
    // oxlint-disable-next-line no-control-regex -- strips control characters from a display name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 60);
  return name || "Companion";
}

/** `0` and negatives would date a device to 1970. */
const timestamp = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** `lastSeenAt` falls back to `createdAt`: a device not heard from since
 * pairing was last seen when it paired. */
function normalizeDevice(record: Partial<DeviceRecord> & { id: string; tokenHash: string }): DeviceRecord {
  const createdAt = timestamp(record.createdAt, Date.now());
  return {
    id: record.id,
    tokenHash: record.tokenHash,
    name: cleanDeviceName(record.name),
    createdAt,
    lastSeenAt: timestamp(record.lastSeenAt, createdAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
    browserControlAccess: record.browserControlAccess === true,
    routes: record.routes === "local" ? "local" : "any",
    ...(typeof record.e2eAt === "number" && record.e2eAt > 0 ? { e2eAt: record.e2eAt } : {}),
  };
}

/** A device saved at pairing whose token was never used: the phone never got its reply, or lost it. Dropped after this. */
export const UNCONFIRMED_DEVICE_MS = 5 * 60_000;

export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  /** Paired in this run and not yet used; a restart forgets these, and such a device then stays until removed. */
  private unconfirmed = new Map<string, ReturnType<typeof setTimeout>>();
  private droppedListeners = new Set<(id: string) => void>();
  private window: PairingWindow | null = null;
  /** The window a renewal replaced: still valid until its own expiry, so a phone mid-scan never misses. */
  private previousWindow: PairingWindow | null = null;
  private replay: PairingReplay | null = null;
  private replayExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenWrites = new Map<string, number>();
  /** devices.json exists but could not be read: "no devices" is a guess. */
  private unreadable = false;
  private changeListeners = new Set<() => void>();

  /** Pairing, removal, a route restriction, or a pairing window opening or closing. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** A device dropped because its phone never used it. */
  onDropped(listener: (id: string) => void): void {
    this.droppedListeners.add(listener);
  }

  /** The phone holds the token: it authenticated with it, or opened an encrypted session keyed by it. */
  confirm(id: string): void {
    const timer = this.unconfirmed.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.unconfirmed.delete(id);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  /** Records, token hashes included: the E2E layer derives each psk and admission value from them. */
  records(): readonly DeviceRecord[] {
    return this.devices;
  }

  /** Only `id` and `tokenHash` make a record a device; the rest is display and
   * gets defaults. */
  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(DEVICES_FILE, "utf8"));
      if (Array.isArray(parsed?.devices)) {
        this.devices = parsed.devices
          .filter(
            (d: unknown): d is Partial<DeviceRecord> & { id: string; tokenHash: string } =>
              typeof (d as DeviceRecord)?.id === "string" &&
              typeof (d as DeviceRecord)?.tokenHash === "string",
          )
          .map(normalizeDevice);
      } else {
        this.unreadable = true;
      }
    } catch (error) {
      this.unreadable = (error as NodeJS.ErrnoException)?.code !== "ENOENT";
    }
  }

  /** Atomic: a torn file reads as empty and would sign every phone out. */
  private persist() {
    ensureDataDir();
    writeFileAtomic(DEVICES_FILE, JSON.stringify({ devices: this.devices }, null, 2));
    this.unreadable = false;
  }

  list(): PublicDevice[] {
    return this.devices.map(({ tokenHash: _tokenHash, ...rest }) => rest);
  }

  /** Until the next successful save. The list is then empty only because
   * nothing could be read, so it must not read as "nothing is paired". */
  devicesUnreadable(): boolean {
    return this.unreadable;
  }

  count(): number {
    return this.devices.length;
  }

  /** The newest window. Expiry is evaluated on read. */
  pairing(): PairingWindow | null {
    return this.pairingWindows()[0] ?? null;
  }

  /** Newest first: at most the current window and the one a renewal replaced. */
  pairingWindows(): PairingWindow[] {
    const now = Date.now();
    let expired = false;
    if (this.previousWindow && this.previousWindow.expiresAt <= now) {
      this.previousWindow = null;
      expired = true;
    }
    if (this.window && this.window.expiresAt <= now) {
      this.window = this.previousWindow;
      this.previousWindow = null;
      expired = true;
    }
    if (expired) this.changed();
    return [this.window, this.previousWindow].filter((window): window is PairingWindow => window !== null);
  }

  /** A fresh code while the pairing screen stays open; the one before keeps its remaining time. */
  renewPairing(): PairingWindow {
    const current = this.pairing();
    const next = this.newWindow();
    this.previousWindow = current;
    this.window = next;
    this.changed();
    return next;
  }

  /** `randomInt`, not `Math.random`: the code is a credential. */
  private newWindow(): PairingWindow {
    return {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      token: `omb_pair_${randomBytes(32).toString("base64url")}`,
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
  }

  /** Replaces any open window. */
  openPairing(): PairingWindow {
    this.clearReplay();
    this.previousWindow = null;
    this.window = this.newWindow();
    this.changed();
    return this.window;
  }

  /** With a token: the newest window's closes both; the replaced one's closes only that one. */
  closePairing(expectedToken?: string): boolean {
    const [newest, previous] = this.pairingWindows();
    if (expectedToken !== undefined && newest?.token !== expectedToken) {
      if (!previous || previous.token !== expectedToken) return false;
      this.previousWindow = null;
      this.changed();
      return true;
    }
    const wasOpen = newest !== undefined;
    this.window = null;
    this.previousWindow = null;
    this.clearReplay();
    if (wasOpen) this.changed();
    return true;
  }

  /** Erase the only in-memory copy of an issued token. Timed, so an expired
   * recovery window never leaves a raw bearer in a long-lived process. */
  private clearReplay() {
    this.replay = null;
    if (this.replayExpiryTimer) clearTimeout(this.replayExpiryTimer);
    this.replayExpiryTimer = null;
  }

  /** A client that supplies a request id may repeat the same redemption until
   * the window's original expiry. There is no general token-read endpoint. */
  redeem(
    credential: string,
    name: unknown,
    pairRequestId?: unknown,
  ): { device: PublicDevice; token: string } | { error: string } {
    const presented = String(credential ?? "");
    const requestId =
      typeof pairRequestId === "string" && /^[A-Za-z0-9._-]{16,128}$/.test(pairRequestId)
        ? pairRequestId
        : null;

    if (this.replay && this.replay.expiresAt <= Date.now()) this.clearReplay();
    if (
      requestId &&
      this.replay &&
      sameCredential(this.replay.requestId, requestId) &&
      sameDigest(this.replay.credentialHash, sha256(presented))
    ) {
      return this.replay.result;
    }

    const windows = this.pairingWindows();
    const window = windows.find((candidate) => sameCredential(candidate.code, presented) || sameCredential(candidate.token, presented));
    if (windows.length === 0) return { error: "no pairing is in progress — open Phone settings on your computer" };
    if (!window) {
      // Every open window pays for a wrong guess: without burning them, six digits is seconds of guessing.
      for (const open of windows) open.attemptsLeft -= 1;
      if (windows.some((open) => open.attemptsLeft <= 0)) {
        this.closePairing();
        return { error: "too many incorrect codes — start pairing again" };
      }
      return { error: "that pairing credential is not right" };
    }
    // After the code check: a full fleet must not answer wrong guesses, which
    // would leak state and cost no attempts.
    if (this.devices.length >= MAX_DEVICES) return { error: "too many paired devices — remove one first" };
    // Consume every open window without clearing a replay; `closePairing` clears both.
    this.window = null;
    this.previousWindow = null;

    const token = `omb_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      cloudDesktopAccess: false,
      browserControlAccess: false,
      routes: "any",
    };
    this.devices.push(device);
    // Unlike lastSeenAt, a failed write rolls the registration back: a device
    // only in memory is paired until the next restart, then silently is not.
    try {
      this.persist();
    } catch (e) {
      this.devices.pop();
      return { error: `could not save the pairing: ${(e as Error).message}` };
    }
    this.changed();
    const unconfirmed = setTimeout(() => {
      this.unconfirmed.delete(device.id);
      try {
        if (!this.revoke(device.id)) return;
      } catch {
        return;
      }
      for (const listener of this.droppedListeners) listener(device.id);
    }, UNCONFIRMED_DEVICE_MS);
    unconfirmed.unref?.();
    this.unconfirmed.set(device.id, unconfirmed);
    const { tokenHash: _tokenHash, ...pub } = device;
    const result = { device: pub, token };
    if (requestId) {
      this.replay = {
        requestId,
        credentialHash: sha256(presented),
        expiresAt: window.expiresAt,
        result,
      };
      this.replayExpiryTimer = setTimeout(
        () => this.clearReplay(),
        Math.max(0, window.expiresAt - Date.now()),
      );
      this.replayExpiryTimer.unref?.();
    }
    return result;
  }

  authenticate(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => sameDigest(d.tokenHash, hash));
    if (!device) return null;
    this.confirm(device.id);
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(device.id) ?? 0) > LAST_SEEN_WRITE_MS) {
      device.lastSeenAt = now;
      this.lastSeenWrites.set(device.id, now);
      // A failed lastSeenAt write must never stop a valid token authenticating.
      try {
        this.persist();
      } catch {
      }
    }
    return device;
  }

  /** False when nothing matched, so the page cannot report a no-op as success. */
  revoke(id: string): boolean {
    const previous = this.devices;
    this.devices = previous.filter((d) => d.id !== id);
    if (this.devices.length === previous.length) return false;
    try {
      this.persist();
    } catch (error) {
      this.devices = previous;
      throw error;
    }
    this.lastSeenWrites.delete(id);
    this.confirm(id);
    this.changed();
    return true;
  }

  setRoutes(id: string, routes: DeviceRoutes): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return false;
    const previous = device.routes;
    device.routes = routes;
    try {
      this.persist();
    } catch (error) {
      device.routes = previous;
      throw error;
    }
    this.changed();
    return true;
  }

  /** Once: the first end-to-end session ratchets this device off the plain listener for good. */
  markE2E(id: string): void {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device || device.e2eAt) return;
    device.e2eAt = Date.now();
    try {
      this.persist();
    } catch {
      // Kept in memory; the next successful write saves it.
    }
  }

  /** Per device, so one phone does not inherit another's permission. */
  setCloudDesktopAccess(id: string, allowed: boolean): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return false;
    const previous = device.cloudDesktopAccess;
    device.cloudDesktopAccess = allowed;
    try {
      this.persist();
    } catch (error) {
      device.cloudDesktopAccess = previous;
      throw error;
    }
    return true;
  }

  setBrowserControlAccess(id: string, allowed: boolean): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return false;
    const previous = device.browserControlAccess;
    device.browserControlAccess = allowed;
    try {
      this.persist();
    } catch (error) {
      device.browserControlAccess = previous;
      throw error;
    }
    return true;
  }
}

/** The scheme is case-insensitive (RFC 7235 §2.1). A header with nothing after
 * the scheme is `undefined`, never "". */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || undefined : undefined;
}
