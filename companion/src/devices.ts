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
}

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
  };
}

export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private window: PairingWindow | null = null;
  private replay: PairingReplay | null = null;
  private replayExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenWrites = new Map<string, number>();
  /** devices.json exists but could not be read: "no devices" is a guess. */
  private unreadable = false;

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

  /** Expiry is evaluated on read. */
  pairing(): PairingWindow | null {
    if (this.window && this.window.expiresAt <= Date.now()) this.window = null;
    return this.window;
  }

  /** `randomInt`, not `Math.random`: the code is a credential. */
  openPairing(): PairingWindow {
    this.clearReplay();
    this.window = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      token: `omb_pair_${randomBytes(32).toString("base64url")}`,
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
    return this.window;
  }

  closePairing(expectedToken?: string): boolean {
    if (expectedToken !== undefined && this.pairing()?.token !== expectedToken) return false;
    this.window = null;
    this.clearReplay();
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

    const window = this.pairing();
    if (!window) return { error: "no pairing is in progress — open Phone settings on your computer" };
    if (!sameCredential(window.code, presented) && !sameCredential(window.token, presented)) {
      window.attemptsLeft -= 1;
      // Without burning the window, six digits is seconds of guessing.
      if (window.attemptsLeft <= 0) {
        this.closePairing();
        return { error: "too many incorrect codes — start pairing again" };
      }
      return { error: "that pairing credential is not right" };
    }
    // After the code check: a full fleet must not answer wrong guesses, which
    // would leak state and cost no attempts.
    if (this.devices.length >= MAX_DEVICES) return { error: "too many paired devices — remove one first" };
    // Consume the window without clearing a replay; `closePairing` clears both.
    this.window = null;

    const token = `omb_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      cloudDesktopAccess: false,
      browserControlAccess: false,
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
    return true;
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
