// Companion device registry contract. The three properties that matter:
// a token is never recoverable from disk, pairing credentials are one-time,
// a manual code cannot be ground down by guessing, and revocation works.
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import {
  bearerToken,
  cleanDeviceName,
  DeviceRegistry,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_TTL_MS,
} from "../src/devices.ts";

const pair = (registry: DeviceRegistry, name = "iPhone") => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, name);
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};

describe("DeviceRegistry", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("issues a token that authenticates, and never stores it", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    expect(token.startsWith("omb_")).toBe(true);
    expect(registry.authenticate(token)?.id).toBe(device.id);

    // the file on disk holds a digest, not the credential
    const raw = readFileSync(join(DATA_DIR, "devices.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).devices[0].tokenHash).toHaveLength(64);

    // and nothing the UI can read exposes it either
    expect(JSON.stringify(registry.list())).not.toContain(token);
    expect(registry.list()[0]).not.toHaveProperty("tokenHash");
  });

  it("closes only the pairing window named by an expected token", () => {
    const registry = new DeviceRegistry();
    const first = registry.openPairing();
    const second = registry.openPairing();

    expect(registry.closePairing(first.token)).toBe(false);
    expect(registry.pairing()?.token).toBe(second.token);
    expect(registry.closePairing(second.token)).toBe(true);
    expect(registry.pairing()).toBeNull();
  });

  it("survives a restart", () => {
    const { token } = pair(new DeviceRegistry());
    expect(new DeviceRegistry().authenticate(token)).not.toBeNull();
  });

  // A record written by an older build, or edited by hand, can be missing
  // everything except the two fields that make it a device at all. Reading it
  // back as-is puts "undefined" and "Last seen NaN" on the pairing page.
  it("completes a record that is missing its labels", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    const file = join(DATA_DIR, "devices.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    delete stored.devices[0].name;
    delete stored.devices[0].lastSeenAt;
    delete stored.devices[0].createdAt;
    delete stored.devices[0].cloudDesktopAccess;
    writeFileSync(file, JSON.stringify(stored));

    const reloaded = new DeviceRegistry();
    const [listed] = reloaded.list();
    expect(listed.id).toBe(device.id);
    expect(listed.name).toBe("Companion");
    expect(Number.isFinite(listed.lastSeenAt)).toBe(true);
    expect(Number.isFinite(listed.createdAt)).toBe(true);
    expect(listed.cloudDesktopAccess).toBe(false);
    // and the token it was paired with still works
    expect(reloaded.authenticate(token)?.id).toBe(device.id);
  });

  // POSIX only. Windows has no mode bits — `stat` reports a synthesised 0666
  // for anything not marked read-only, and the mode arguments this asserts on
  // are ignored when the file is created. Access there is an ACL question,
  // and the data directory sits under the user's own profile, which is
  // already not readable by other accounts. Skipped rather than loosened: an
  // assertion that passes by measuring nothing is worse than no assertion.
  it.skipIf(process.platform === "win32")(
    "keeps token hashes out of reach of other accounts on the machine",
    () => {
      pair(new DeviceRegistry());
      // 0700 on the directory, 0600 on the file. A hash is an offline target
      // for anyone who can read it, and this process is the only reader.
      expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(join(DATA_DIR, "devices.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("refuses unknown, empty, and near-miss tokens", () => {
    const registry = new DeviceRegistry();
    const { token } = pair(registry);

    expect(registry.authenticate(undefined)).toBeNull();
    expect(registry.authenticate("")).toBeNull();
    expect(registry.authenticate("omb_nope")).toBeNull();
    expect(registry.authenticate(token.slice(0, -1))).toBeNull();
    expect(registry.authenticate(`${token}x`)).toBeNull();
  });

  it("burns the pairing window after too many wrong codes", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 1; i < MAX_PAIRING_ATTEMPTS; i++) {
      expect(registry.redeem(wrong, "iPhone")).toEqual({ error: "that pairing credential is not right" });
      expect(registry.pairing()).not.toBeNull();
    }
    // the last one closes the window rather than counting down forever
    expect(registry.redeem(wrong, "iPhone")).toMatchObject({ error: expect.stringContaining("start pairing again") });
    expect(registry.pairing()).toBeNull();

    // and the real code is worthless now
    expect(registry.redeem(code, "iPhone")).toMatchObject({ error: expect.stringContaining("no pairing") });
    expect(registry.count()).toBe(0);
  });

  it("spends a code exactly once", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    expect(registry.redeem(code, "iPhone")).toHaveProperty("token");
    expect(registry.redeem(code, "iPad")).toMatchObject({ error: expect.stringContaining("no pairing") });
    expect(registry.count()).toBe(1);
  });

  it("points an out-of-window pairing attempt to Phone settings", () => {
    expect(new DeviceRegistry().redeem("000000", "iPhone")).toEqual({
      error: "no pairing is in progress — open Phone settings on your computer",
    });
  });

  it("replays one logical redemption without creating an orphan device", () => {
    const registry = new DeviceRegistry();
    const { token: credential } = registry.openPairing();
    const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";

    const first = registry.redeem(credential, "iPhone", requestId);
    const replay = registry.redeem(credential, "iPhone", requestId);

    expect(first).toHaveProperty("token");
    expect(replay).toEqual(first);
    expect(registry.count()).toBe(1);
    // Possessing only one half of the replay key is not enough.
    expect(registry.redeem(credential, "iPhone", "different-request-id")).toMatchObject({
      error: expect.stringContaining("no pairing"),
    });
    expect(registry.redeem("omb_pair_wrong", "iPhone", requestId)).toMatchObject({
      error: expect.stringContaining("no pairing"),
    });
  });

  it("forgets a redemption replay when a fresh pairing window opens", () => {
    const registry = new DeviceRegistry();
    const { token: firstCredential } = registry.openPairing();
    const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";
    expect(registry.redeem(firstCredential, "iPhone", requestId)).toHaveProperty("token");

    registry.openPairing();
    expect(registry.redeem(firstCredential, "iPhone", requestId)).toMatchObject({
      error: expect.stringContaining("not right"),
    });
  });

  it("actively erases a redemption replay at the original window expiry", () => {
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const { token: credential } = registry.openPairing();
      const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";
      expect(registry.redeem(credential, "iPhone", requestId)).toHaveProperty("token");
      const memory = registry as unknown as {
        replay: unknown;
        replayExpiryTimer: unknown;
      };
      expect(memory.replay).not.toBeNull();
      expect(memory.replayExpiryTimer).not.toBeNull();

      vi.advanceTimersByTime(PAIRING_TTL_MS + 1);
      expect(memory.replay).toBeNull();
      expect(memory.replayExpiryTimer).toBeNull();
      expect(registry.redeem(credential, "iPhone", requestId)).toMatchObject({
        error: expect.stringContaining("no pairing"),
      });
      expect(registry.count()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cloud desktop access off until enabled for that device", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    expect(device.cloudDesktopAccess).toBe(false);
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(false);
    expect(registry.setCloudDesktopAccess(device.id, true)).toBe(true);
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(true);
    expect(new DeviceRegistry().authenticate(token)?.cloudDesktopAccess).toBe(true);
    expect(registry.setCloudDesktopAccess(device.id, false)).toBe(true);
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(false);
    expect(registry.setCloudDesktopAccess("missing", true)).toBe(false);
  });

  it("rolls cloud desktop access back when it cannot be saved", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);
    (registry as unknown as { persist: () => void }).persist = () => {
      throw new Error("ENOSPC: no space left on device");
    };

    expect(() => registry.setCloudDesktopAccess(device.id, true)).toThrow("ENOSPC");
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(false);
  });

  it("uses a high-entropy QR credential and burns the manual fallback with it", () => {
    const registry = new DeviceRegistry();
    const { code, token } = registry.openPairing();

    expect(token).toMatch(/^omb_pair_[A-Za-z0-9_-]{43}$/);
    expect(registry.redeem(token, "iPhone")).toHaveProperty("token");
    expect(registry.redeem(code, "iPad")).toMatchObject({
      error: expect.stringContaining("no pairing"),
    });
    expect(registry.count()).toBe(1);
  });

  it("refuses an expired window without a timer", () => {
    // Move the clock, not the object. Ageing the window returned by
    // openPairing() only works while that object is the registry's own — the
    // day it hands back a copy, the test would be asserting against something
    // the registry never reads. The contract is "expiry is evaluated on read
    // against the wall clock", so the clock is the thing to control.
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const { code } = registry.openPairing();
      expect(registry.pairing()).not.toBeNull();

      // one tick short of the TTL: still live, so the assertion below is
      // about expiry rather than about pairing being broken outright
      vi.advanceTimersByTime(PAIRING_TTL_MS - 1);
      expect(registry.pairing()).not.toBeNull();

      vi.advanceTimersByTime(2);
      expect(registry.pairing()).toBeNull();
      expect(registry.redeem(code, "iPhone")).toMatchObject({
        error: expect.stringContaining("no pairing"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes one device without touching the others", () => {
    const registry = new DeviceRegistry();
    const phone = pair(registry, "iPhone");
    const tablet = pair(registry, "iPad");
    expect(registry.count()).toBe(2);

    expect(registry.revoke(phone.device.id)).toBe(true);
    expect(registry.revoke(phone.device.id)).toBe(false);
    expect(registry.authenticate(phone.token)).toBeNull();
    expect(registry.authenticate(tablet.token)?.name).toBe("iPad");

    // revocation is durable, not just in-memory
    expect(new DeviceRegistry().authenticate(phone.token)).toBeNull();
  });

  it("stores a device push target encrypted and never exposes it in the public fleet", () => {
    const pushKey = Buffer.alloc(32, 7).toString("base64");
    const registry = new DeviceRegistry({ pushEncryptionKey: pushKey });
    const { device } = pair(registry, "Galaxy S26 Ultra");
    const registrationToken = `fcm_${"a".repeat(120)}`;

    expect(registry.setPushToken(device.id, registrationToken)).toEqual({ ok: true });
    expect(registry.pushTargets()).toEqual([{ deviceId: device.id, token: registrationToken }]);
    expect(JSON.stringify(registry.list())).not.toContain(registrationToken);
    expect(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).not.toContain(registrationToken);

    const reloaded = new DeviceRegistry({ pushEncryptionKey: pushKey });
    expect(reloaded.pushTargets()).toEqual([{ deviceId: device.id, token: registrationToken }]);
  });

  it("rejects malformed push tokens and clears only the authenticated device target", () => {
    const pushKey = Buffer.alloc(32, 9).toString("base64");
    const registry = new DeviceRegistry({ pushEncryptionKey: pushKey });
    const phone = pair(registry, "Galaxy S26 Ultra");
    const tablet = pair(registry, "Tablet");
    const phoneToken = `fcm_${"p".repeat(120)}`;
    const tabletToken = `fcm_${"t".repeat(120)}`;

    expect(registry.setPushToken(phone.device.id, "short")).toEqual({ ok: false, error: "invalid push token" });
    expect(registry.setPushToken(phone.device.id, phoneToken)).toEqual({ ok: true });
    expect(registry.setPushToken(tablet.device.id, tabletToken)).toEqual({ ok: true });
    expect(registry.clearPushToken(phone.device.id)).toBe(true);
    expect(registry.pushTargets()).toEqual([{ deviceId: tablet.device.id, token: tabletToken }]);
    expect(registry.clearPushToken(phone.device.id)).toBe(false);
  });

  it("treats a corrupt devices.json as no paired devices", () => {
    pair(new DeviceRegistry());
    writeFileSync(join(DATA_DIR, "devices.json"), "{ not json");
    expect(new DeviceRegistry().count()).toBe(0);
  });
});

describe("authenticate under a failing disk", () => {
  it("still authenticates when the lastSeenAt write throws", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    // A read-only home or a full disk. The write being attempted here is the
    // "last seen" timestamp, which decorates a row in a settings panel — it
    // must not be able to sign a working phone out, on every request, for
    // the user least equipped to work out why.
    let attempted = 0;
    // SAFETY: `persist` is private, so the type has to be widened to reach
    // it. Assigning on the instance shadows the prototype method for this
    // registry only — the failing disk is simulated where the disk is used,
    // rather than by mocking node:fs for the whole file.
    (registry as unknown as { persist: () => void }).persist = () => {
      attempted++;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };

    expect(registry.authenticate(token)?.id).toBe(device.id);
    expect(attempted).toBe(1);
    // and again, so a throw cannot poison the path for later calls either
    expect(registry.authenticate(token)?.id).toBe(device.id);
  });
});

describe("a pairing that cannot be saved", () => {
  // Same throwaway state as the suite above — a registry built on a leftover
  // devices.json would start with a device already in it.
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is not left live in memory", () => {
    const registry = new DeviceRegistry();
    // SAFETY: as above — the private `persist` shadowed on this one instance,
    // which is the only way to make the write fail without a filesystem that
    // really is read-only.
    (registry as unknown as { persist: () => void }).persist = () => {
      throw new Error("EROFS: read-only file system");
    };

    const { code } = registry.openPairing();
    const result = registry.redeem(code, "iPhone");

    // A device kept in memory but never written is paired until the next
    // restart and then silently is not — the phone holds a token that stops
    // working with nothing to explain it. Fail the pairing instead.
    expect("error" in result).toBe(true);
    expect(registry.count()).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

describe("cleanDeviceName", () => {
  it("clamps, trims, and strips control characters", () => {
    expect(cleanDeviceName("  Milind's iPhone  ")).toBe("Milind's iPhone");
    // an untrusted label must not carry NULs or ANSI escapes into a UI
    expect(cleanDeviceName("bad\u0000name\u001b[31m")).toBe("bad name [31m");
    expect(cleanDeviceName("x".repeat(200))).toHaveLength(60);
  });

  it("falls back rather than allowing an empty label", () => {
    expect(cleanDeviceName("")).toBe("Companion");
    expect(cleanDeviceName(undefined)).toBe("Companion");
    expect(cleanDeviceName("   ")).toBe("Companion");
  });
});

describe("bearerToken", () => {
  it("reads only a well-formed Bearer header", () => {
    expect(bearerToken("Bearer omb_abc")).toBe("omb_abc");
    expect(bearerToken("  Bearer omb_abc  ")).toBe("omb_abc");
    expect(bearerToken("omb_abc")).toBeUndefined();
    expect(bearerToken("Basic omb_abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  // RFC 7235 says the scheme is case-insensitive, and a client sending
  // "bearer" is within its rights. This is the only parser in the sidecar,
  // so a phone cannot get a 401 from one half disagreeing with the other —
  // which is exactly what happened while the proxy carried a second, laxer
  // one of its own: the same header authenticated on one path and not the
  // other, depending on which code it happened to meet.
  it("matches the scheme however it is cased", () => {
    expect(bearerToken("bearer omb_abc")).toBe("omb_abc");
    expect(bearerToken("BEARER omb_abc")).toBe("omb_abc");
    expect(bearerToken("BeArEr omb_abc")).toBe("omb_abc");
    // a tab separates scheme from credential just as legally as a space
    expect(bearerToken("BeArEr\tomb_abc")).toBe("omb_abc");
    // still not a free-for-all: a scheme with nothing after it is not a
    // credential, however much whitespace is standing in for one
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer   ")).toBeUndefined();
    expect(bearerToken("Beareromb_abc")).toBeUndefined();
  });
});
