import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import {
  bearerToken,
  cleanDeviceName,
  DeviceRegistry,
  MAX_DEVICES,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_TTL_MS,
  UNCONFIRMED_DEVICE_MS,
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

    const raw = readFileSync(join(DATA_DIR, "devices.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).devices[0].tokenHash).toHaveLength(64);

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

  it("drops a paired device its phone never used, and keeps one it did", () => {
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const dropped: string[] = [];
      registry.onDropped((id) => dropped.push(id));
      const unused = pair(registry, "Lost reply");
      const used = pair(registry, "Used");
      const viaSession = pair(registry, "Encrypted");
      expect(registry.authenticate(used.token)?.id).toBe(used.device.id);
      registry.confirm(viaSession.device.id);
      vi.advanceTimersByTime(UNCONFIRMED_DEVICE_MS - 1);
      expect(registry.list()).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(dropped).toEqual([unused.device.id]);
      expect(registry.list().map((device) => device.name)).toEqual(["Used", "Encrypted"]);
      expect(registry.authenticate(unused.token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a restart", () => {
    const { token } = pair(new DeviceRegistry());
    expect(new DeviceRegistry().authenticate(token)).not.toBeNull();
  });

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
    expect(reloaded.authenticate(token)?.id).toBe(device.id);
  });

  // POSIX only: Windows stat reports a synthesised 0666 and ignores the mode
  // arguments; access there is an ACL question.
  it.skipIf(process.platform === "win32")(
    "keeps token hashes out of reach of other accounts on the machine",
    () => {
      pair(new DeviceRegistry());
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
      expect(registry.redeem(wrong, "iPhone")).toEqual({ error: "that pairing credential is not right", code: "pairing_code_wrong" });
      expect(registry.pairing()).not.toBeNull();
    }
    expect(registry.redeem(wrong, "iPhone")).toMatchObject({ error: expect.stringContaining("start pairing again"), code: "pairing_too_many" });
    expect(registry.pairing()).toBeNull();

    expect(registry.redeem(code, "iPhone")).toMatchObject({ error: expect.stringContaining("no pairing"), code: "pairing_not_open" });
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
      code: "pairing_not_open",
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
    // Move the clock, not the object: expiry is evaluated on read against the
    // wall clock.
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const { code } = registry.openPairing();
      expect(registry.pairing()).not.toBeNull();

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

    expect(new DeviceRegistry().authenticate(phone.token)).toBeNull();
  });

  it("treats a corrupt devices.json as no paired devices", () => {
    pair(new DeviceRegistry());
    writeFileSync(join(DATA_DIR, "devices.json"), "{ not json");
    expect(new DeviceRegistry().count()).toBe(0);
  });

  it("says when its empty list is only an unreadable file, until it saves again", () => {
    const file = join(DATA_DIR, "devices.json");
    expect(new DeviceRegistry().devicesUnreadable()).toBe(false);

    pair(new DeviceRegistry());
    expect(new DeviceRegistry().devicesUnreadable()).toBe(false);
    for (const contents of ["{ not json", "null", '{"devices":"none"}']) {
      writeFileSync(file, contents);
      const registry = new DeviceRegistry();
      expect(registry.count()).toBe(0);
      expect(registry.devicesUnreadable()).toBe(true);
    }
    rmSync(file);
    mkdirSync(file);
    expect(new DeviceRegistry().devicesUnreadable()).toBe(true);
    rmSync(file, { recursive: true });

    writeFileSync(file, "{ not json");
    const registry = new DeviceRegistry();
    expect(registry.devicesUnreadable()).toBe(true);
    pair(registry);
    expect(registry.devicesUnreadable()).toBe(false);
    expect(new DeviceRegistry().devicesUnreadable()).toBe(false);
  });
});

describe("authenticate under a failing disk", () => {
  it("still authenticates when the lastSeenAt write throws", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    let attempted = 0;
    // `persist` is private; shadowed on this instance so the failing disk is
    // simulated where the disk is used, not by mocking node:fs.
    (registry as unknown as { persist: () => void }).persist = () => {
      attempted++;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };

    expect(registry.authenticate(token)?.id).toBe(device.id);
    expect(attempted).toBe(1);
    expect(registry.authenticate(token)?.id).toBe(device.id);
  });
});

describe("a removal that cannot be saved", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps the device in memory, matching the file, and lets the removal be retried", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);
    const writable = registry as unknown as { persist: () => void };
    const persist = writable.persist;
    writable.persist = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };

    expect(() => registry.revoke(device.id)).toThrow(/ENOSPC/);
    expect(registry.authenticate(token)?.id).toBe(device.id);
    expect(new DeviceRegistry().authenticate(token)?.id).toBe(device.id);

    writable.persist = persist;
    expect(registry.revoke(device.id)).toBe(true);
    expect(registry.authenticate(token)).toBeNull();
    expect(new DeviceRegistry().authenticate(token)).toBeNull();
  });
});

describe("a pairing that cannot be saved", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is not left live in memory", () => {
    const registry = new DeviceRegistry();
    (registry as unknown as { persist: () => void }).persist = () => {
      throw new Error("EROFS: read-only file system");
    };

    const { code } = registry.openPairing();
    const result = registry.redeem(code, "iPhone");

    expect("error" in result).toBe(true);
    expect(registry.count()).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

describe("cleanDeviceName", () => {
  it("clamps, trims, and strips control characters", () => {
    expect(cleanDeviceName("  Milind's iPhone  ")).toBe("Milind's iPhone");
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

  it("matches the scheme however it is cased", () => {
    expect(bearerToken("bearer omb_abc")).toBe("omb_abc");
    expect(bearerToken("BEARER omb_abc")).toBe("omb_abc");
    expect(bearerToken("BeArEr omb_abc")).toBe("omb_abc");
    expect(bearerToken("BeArEr\tomb_abc")).toBe("omb_abc");
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer   ")).toBeUndefined();
    expect(bearerToken("Beareromb_abc")).toBeUndefined();
  });
});

describe("browser control capability", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is off for a newly paired device", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);

    expect(device.browserControlAccess).toBe(false);
    expect(registry.list()[0].browserControlAccess).toBe(false);
  });

  it("reads a record written before the capability existed as off", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const path = join(DATA_DIR, "devices.json");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    delete stored.devices[0].browserControlAccess;
    writeFileSync(path, JSON.stringify(stored));

    expect(new DeviceRegistry().list().find((d) => d.id === device.id)?.browserControlAccess).toBe(false);
  });

  it("grants and revokes per device, leaving the other one alone", () => {
    const registry = new DeviceRegistry();
    const first = pair(registry, "First").device;
    const second = pair(registry, "Second").device;

    expect(registry.setBrowserControlAccess(first.id, true)).toBe(true);

    const byId = (id: string) => registry.list().find((d) => d.id === id)!;
    expect(byId(first.id).browserControlAccess).toBe(true);
    expect(byId(second.id).browserControlAccess).toBe(false);

    expect(registry.setBrowserControlAccess(first.id, false)).toBe(true);
    expect(byId(first.id).browserControlAccess).toBe(false);
  });

  it("is a separate grant from cloud desktop access", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);

    registry.setCloudDesktopAccess(device.id, true);

    expect(registry.list()[0].cloudDesktopAccess).toBe(true);
    expect(registry.list()[0].browserControlAccess).toBe(false);
  });

  it("survives a restart and refuses an unknown device", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    registry.setBrowserControlAccess(device.id, true);

    expect(new DeviceRegistry().list()[0].browserControlAccess).toBe(true);
    expect(registry.setBrowserControlAccess("nobody", true)).toBe(false);
  });
});

describe("re-pairing with the token a phone already holds", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const repair = (registry: DeviceRegistry, replacesToken?: unknown, name = "iPhone") => {
    const { token: credential } = registry.openPairing();
    const result = registry.redeem(credential, name, undefined, replacesToken);
    if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
    return result;
  };
  const savedIds = () => (JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).devices as Array<{ id: string }>).map((d) => d.id);

  it("replaces that device in the same save: the count stays and the old token stops working", () => {
    const registry = new DeviceRegistry();
    const replaced: string[] = [];
    registry.onReplaced((id) => replaced.push(id));
    const other = pair(registry, "iPad");
    const first = pair(registry);
    const second = repair(registry, first.token);

    expect(registry.count()).toBe(2);
    expect(registry.authenticate(first.token)).toBeNull();
    expect(registry.authenticate(second.token)?.id).toBe(second.device.id);
    expect(registry.authenticate(other.token)?.id).toBe(other.device.id);
    expect(second.device.id).not.toBe(first.device.id);
    expect(savedIds()).toEqual([other.device.id, second.device.id]);
    expect(replaced).toEqual([first.device.id]);
  });

  it("starts the new device with a fresh pairing's grants, keeping only a route restriction", () => {
    const registry = new DeviceRegistry();
    const first = pair(registry);
    registry.setCloudDesktopAccess(first.device.id, true);
    registry.setBrowserControlAccess(first.device.id, true);
    registry.setRoutes(first.device.id, "local");
    registry.markE2E(first.device.id);

    const { device } = repair(registry, first.token);
    expect(device).toMatchObject({ cloudDesktopAccess: false, browserControlAccess: false, routes: "local" });
    expect(device).not.toHaveProperty("e2eAt");
  });

  it("ignores an unknown or malformed token, with the same reply as a pairing without one", () => {
    const registry = new DeviceRegistry();
    const kept = pair(registry);
    const replaced: string[] = [];
    registry.onReplaced((id) => replaced.push(id));
    const plain = repair(registry);
    for (const unknown of [`omb_${"A".repeat(43)}`, "", 42, { token: kept.token }, null]) {
      const result = repair(registry, unknown);
      expect(Object.keys(result).sort()).toEqual(Object.keys(plain).sort());
      expect(Object.keys(result.device).sort()).toEqual(Object.keys(plain.device).sort());
    }
    expect(registry.count()).toBe(7);
    expect(registry.authenticate(kept.token)?.id).toBe(kept.device.id);
    expect(replaced).toEqual([]);
  });

  it("does nothing without a valid pairing credential: the device stays and the attempt is spent", () => {
    const registry = new DeviceRegistry();
    const first = pair(registry);
    registry.openPairing();
    expect(registry.redeem("omb_pair_wrong", "Thief", undefined, first.token)).toMatchObject({ code: "pairing_code_wrong" });
    expect(registry.pairing()?.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS - 1);
    expect(registry.authenticate(first.token)?.id).toBe(first.device.id);
    registry.closePairing();
    expect(registry.redeem("123456", "Thief", undefined, first.token)).toMatchObject({ code: "pairing_not_open" });
    expect(registry.count()).toBe(1);
  });

  it("never reaches the device cap however often the same phone re-pairs", () => {
    const registry = new DeviceRegistry();
    for (let i = 0; i < MAX_DEVICES - 1; i++) pair(registry, `Phone ${i}`);
    let current = pair(registry, "Re-pairing phone");
    for (let i = 0; i < 25; i++) current = repair(registry, current.token, "Re-pairing phone");
    expect(registry.count()).toBe(MAX_DEVICES);
    expect(registry.authenticate(current.token)?.id).toBe(current.device.id);
  });

  it("still refuses a new phone at the cap with a code the phone can show", () => {
    const registry = new DeviceRegistry();
    for (let i = 0; i < MAX_DEVICES; i++) pair(registry, `Phone ${i}`);
    const { token: credential } = registry.openPairing();
    expect(registry.redeem(credential, "One too many")).toEqual({
      error: "too many paired devices — remove an old phone on your computer first",
      code: "pairing_device_limit",
    });
    expect(registry.redeem(credential, "One too many", undefined, `omb_${"B".repeat(43)}`)).toMatchObject({ code: "pairing_device_limit" });
    expect(registry.count()).toBe(MAX_DEVICES);
  });

  it("replays a lost reply without replacing again", () => {
    const registry = new DeviceRegistry();
    const first = pair(registry);
    const { token: credential } = registry.openPairing();
    const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";
    const once = registry.redeem(credential, "iPhone", requestId, first.token);
    const again = registry.redeem(credential, "iPhone", requestId, first.token);
    expect(again).toEqual(once);
    expect(registry.count()).toBe(1);
  });

  it("keeps the old device when the save fails", () => {
    const registry = new DeviceRegistry();
    const first = pair(registry);
    const writable = registry as unknown as { persist: () => void };
    writable.persist = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { token: credential } = registry.openPairing();
    expect(registry.redeem(credential, "iPhone", undefined, first.token)).toMatchObject({ code: "pairing_failed" });
    expect(registry.count()).toBe(1);
    expect(registry.authenticate(first.token)?.id).toBe(first.device.id);
  });
});
