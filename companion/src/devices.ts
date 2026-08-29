// Companion devices — the phones allowed to reach this harness over the
// network. Everything here exists because of one fact: the harness has no
// authentication at all, and it is right not to have any on 127.0.0.1. The
// loopback socket IS the credential — the same reason the app can PUT an API
// key without proving anything. The moment a second socket leaves loopback
// that assumption is gone, so a device token becomes the credential instead.
//
// Tokens follow the same write-only rule as the keys in config.json: the
// token is generated once, handed to the phone at pairing, and never stored
// — devices.json keeps only its SHA-256. A stolen devices.json is not a
// stolen fleet.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

/** One paired phone, as it is written to disk. */
export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the bearer token — never the token itself */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  /** Full interactive access to a bot's cloud desktop. Deliberately off on
   * every new and migrated device until the computer owner enables it. */
  cloudDesktopAccess: boolean;
  /** FCM registration tokens are delivery credentials. They are encrypted
   * with an OS-protected key supplied by the desktop shell, never stored as
   * plaintext or exposed through the control UI. */
  push?: StoredPushTarget;
}

/** What the UI is allowed to see: a device without its secret. */
export type PublicDevice = Omit<DeviceRecord, "tokenHash" | "push">;

interface StoredPushTarget {
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface PushTarget {
  deviceId: string;
  token: string;
}

export interface DeviceRegistryOptions {
  pushEncryptionKey?: string;
}

/** A pairing window: two short-lived credentials, deliberately single-use.
 *
 * `token` is the primary path carried inside the QR code. It has enough
 * entropy to stand on its own and is never typed or persisted. `code` is the
 * human fallback: six digits is only 1e6 possibilities, so it lives for two
 * minutes, dies after a handful of wrong guesses, and only exists while the
 * user is looking at the pairing screen. Redeeming either burns both. */
export interface PairingWindow {
  code: string;
  token: string;
  expiresAt: number;
  attemptsLeft: number;
}

/** A successful redemption kept only long enough for the *same* phone request
 * to recover from a lost HTTP response on another advertised address.
 *
 * The device token remains memory-only here (the durable file still contains
 * only its digest), and a replay needs both the original high-entropy pairing
 * credential and the client-generated request id. Older clients that omit a
 * request id retain the original exactly-once behaviour. */
interface PairingReplay {
  requestId: string;
  credentialHash: string;
  expiresAt: number;
  result: { device: PublicDevice; token: string };
}

const DEVICES_FILE = join(DATA_DIR, "devices.json");
export const PAIRING_TTL_MS = 120_000;
export const MAX_PAIRING_ATTEMPTS = 5;
/** Bounds the file, and a fleet of 20 phones is already an odd story. */
export const MAX_DEVICES = 20;
/** lastSeen is a UI nicety, not an audit log — don't write on every request. */
const LAST_SEEN_WRITE_MS = 60_000;

/** Hex digest. Tokens live on disk as one of these and never in the clear. */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant-time compare of two hex digests of the same length. A plain ===
 * on a token hash leaks its prefix through timing; cheap to avoid. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Same treatment for a pairing credential, which is compared far more often
 * than it is correct. */
function sameCredential(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Device names come from the phone, so they are untrusted display text:
 * clamp the length and drop control characters before they reach a UI. */
export function cleanDeviceName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 60);
  return name || "Companion";
}

/** A timestamp we are willing to render, or a stand-in. `0` and the negatives
 * are as wrong as a missing field and read worse: they date a device to 1970
 * in the UI, where "now" is at least true of when we learned of it. */
const timestamp = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** Complete a stored record, whatever shape the file had. `lastSeenAt` falls
 * back to `createdAt` rather than to the clock: a device we have never heard
 * from since pairing was last seen when it paired. */
function normalizeDevice(record: Partial<DeviceRecord> & { id: string; tokenHash: string }): DeviceRecord {
  const createdAt = timestamp(record.createdAt, Date.now());
  return {
    id: record.id,
    tokenHash: record.tokenHash,
    name: cleanDeviceName(record.name),
    createdAt,
    lastSeenAt: timestamp(record.lastSeenAt, createdAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
    ...(isStoredPushTarget(record.push) ? { push: record.push } : {}),
  };
}

function isStoredPushTarget(value: unknown): value is StoredPushTarget {
  if (typeof value !== "object" || value === null) return false;
  return (
    "version" in value && value.version === 1 &&
    "iv" in value && typeof value.iv === "string" &&
    "ciphertext" in value && typeof value.ciphertext === "string" &&
    "tag" in value && typeof value.tag === "string"
  );
}

function pushKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 ? decoded : null;
}

const validPushToken = (value: string): boolean =>
  value.length >= 20 && value.length <= 4_096 && /^[A-Za-z0-9_:-]+$/.test(value);

/** The paired fleet: who may reach the harness through the sidecar, and the
 * one short-lived window in which a new phone may join it. Backed by a file,
 * loaded once at construction and written on every change. */
export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private window: PairingWindow | null = null;
  private replay: PairingReplay | null = null;
  private replayExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenWrites = new Map<string, number>();
  private readonly pushEncryptionKey: Buffer | null;

  /** Load the paired fleet, normalising as it goes.
   *
   * Only `id` and `tokenHash` decide whether a record is a device at all —
   * without them it can neither be revoked nor authenticate. The rest is
   * display, and a record missing it is not worth discarding a working phone
   * over: what a half-written or hand-edited file used to produce was a UI
   * saying "undefined", last seen "NaN min ago". Defaults are cheaper than
   * either dropping the device or teaching every reader to doubt the type. */
  constructor(options: DeviceRegistryOptions = {}) {
    this.pushEncryptionKey = pushKey(options.pushEncryptionKey);
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
      }
    } catch {
      /* first run, or a file we can't read — start with no paired devices */
    }
  }

  /** Write the fleet to disk. Atomic, because a torn file reads as empty and
   * would sign every phone out with no way to tell why. */
  private persist() {
    ensureDataDir();
    writeFileAtomic(DEVICES_FILE, JSON.stringify({ devices: this.devices }, null, 2));
  }

  /** Every paired device, without the hash — this is what the page renders. */
  list(): PublicDevice[] {
    return this.devices.map(({ tokenHash, push, ...rest }) => rest);
  }

  /** Register or rotate this device's FCM address. The paired bearer has
   * already selected the device id before this method is called. */
  setPushToken(deviceId: string, token: string): { ok: true } | { ok: false; error: string } {
    if (!validPushToken(token)) return { ok: false, error: "invalid push token" };
    const key = this.pushEncryptionKey;
    if (!key) return { ok: false, error: "push storage unavailable" };
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return { ok: false, error: "device not found" };

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const previous = device.push;
    device.push = {
      version: 1,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    try {
      this.persist();
    } catch (error) {
      device.push = previous;
      throw error;
    }
    return { ok: true };
  }

  clearPushToken(deviceId: string): boolean {
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device?.push) return false;
    const previous = device.push;
    delete device.push;
    try {
      this.persist();
    } catch (error) {
      device.push = previous;
      throw error;
    }
    return true;
  }

  /** Decrypt only at the dispatch boundary. Corrupt or legacy entries fail
   * closed so one bad target never prevents delivery to the rest. */
  pushTargets(): PushTarget[] {
    const key = this.pushEncryptionKey;
    if (!key) return [];
    const targets: PushTarget[] = [];
    for (const device of this.devices) {
      const stored = device.push;
      if (!stored) continue;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
        decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
        const token = Buffer.concat([
          decipher.update(Buffer.from(stored.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
        if (validPushToken(token)) targets.push({ deviceId: device.id, token });
      } catch {
        /* corrupt ciphertext is ignored; another device can still receive */
      }
    }
    return targets;
  }

  /** How many phones are paired, against MAX_DEVICES. */
  count(): number {
    return this.devices.length;
  }

  /** The live pairing window, or null. Expiry is evaluated on read so a
   * stale window can never be redeemed by a caller that skipped a tick. */
  pairing(): PairingWindow | null {
    if (this.window && this.window.expiresAt <= Date.now()) this.window = null;
    return this.window;
  }

  /** Open a fresh window, replacing any that was already open. The code is
   * from `randomInt`, not `Math.random` — it is a credential for two minutes. */
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

  /** Erase the only in-memory copy of a successfully issued device token.
   * The timer matters even if nobody ever calls `redeem` again: an expired
   * recovery window must not leave a raw bearer sitting in a long-lived
   * desktop process. */
  private clearReplay() {
    this.replay = null;
    if (this.replayExpiryTimer) clearTimeout(this.replayExpiryTimer);
    this.replayExpiryTimer = null;
  }

  /** Redeem either pairing credential for a device token.
   *
   * Old clients receive the token exactly once. A client that supplies a
   * request id may repeat that same logical redemption until the pairing
   * window's original expiry, which is just enough to survive losing the
   * response while changing routes. There is no general token-read endpoint. */
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

    // A route can die after the registry committed the device but before the
    // phone received the response. Retrying the same logical request through
    // another advertised address must return the same device, not burn a
    // second slot or turn a successful pairing into a misleading 401.
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
      // A burned window is the whole point: without this, six digits is a
      // few seconds of guessing.
      if (window.attemptsLeft <= 0) {
        this.closePairing();
        return { error: "too many incorrect codes — start pairing again" };
      }
      return { error: "that pairing credential is not right" };
    }
    // After the code, not before. Checked first, a full fleet answers every
    // wrong guess with "too many paired devices" — which tells a guesser
    // something about this machine, and costs them none of their five
    // attempts. The window survives, so removing a phone and retyping the
    // same code still works.
    if (this.devices.length >= MAX_DEVICES) return { error: "too many paired devices — remove one first" };
    // Consume the window without clearing a possible replay. `closePairing`
    // is the explicit cancel operation and intentionally clears both.
    this.window = null;

    const token = `omb_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      cloudDesktopAccess: false,
    };
    this.devices.push(device);
    // Unlike the lastSeenAt write below, this one must not be swallowed. A
    // device that lives in memory but not on disk is paired until the next
    // restart and then silently is not — the phone keeps a token that stops
    // working for no reason it can show. Roll the registration back and say
    // so, so the user retries now rather than discovering it days later.
    try {
      this.persist();
    } catch (e) {
      this.devices.pop();
      return { error: `could not save the pairing: ${(e as Error).message}` };
    }
    const { tokenHash, ...pub } = device;
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
      // A two-minute recovery window is not a reason for a deliberately
      // stopped companion process to stay alive.
      this.replayExpiryTimer.unref?.();
    }
    return result;
  }

  /** Resolve a bearer token to its device, or null. */
  authenticate(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => sameDigest(d.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(device.id) ?? 0) > LAST_SEEN_WRITE_MS) {
      device.lastSeenAt = now;
      this.lastSeenWrites.set(device.id, now);
      // lastSeenAt decorates a row in a settings panel. A full disk or a
      // read-only home is a reason for it to be stale, never a reason for an
      // already-valid token to stop authenticating — which is what letting
      // this throw would mean, on every request, for the one user least able
      // to diagnose it.
      try {
        this.persist();
      } catch {
        /* the token is still good; the timestamp can wait */
      }
    }
    return device;
  }

  /** Take a phone's access away. False when there was no such device — a
   * revoke that quietly matched nothing would read as success on the page. */
  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.lastSeenWrites.delete(id);
    this.persist();
    return true;
  }

  /** Grant or remove the one capability that crosses from companion actions
   * into full desktop control. This is per device so a watch-only phone does
   * not inherit a different phone's permission. */
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
}

/**
 * Pull the bearer token out of an Authorization header.
 *
 * The scheme is matched case-insensitively because RFC 7235 §2.1 says it is:
 * a client sending `bearer <token>` is within its rights. This used to
 * require the exact casing while the proxy had a second, laxer parser of its
 * own — so which of the two a request happened to meet decided whether it
 * authenticated, and a phone got a 401 it could not explain. One function,
 * used everywhere a token is read. A header with nothing after the scheme is
 * `undefined` rather than the empty string, so no caller has to decide
 * whether "" counts as a credential.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || undefined : undefined;
}
