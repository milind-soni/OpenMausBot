import { describe, expect, it, vi } from "vitest";

import { readSecureCredentials, resetUnreadableCredentials } from "./secure-credentials.mjs";

const transient = () =>
  new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again.");

const deps = (over = {}) => ({
  exists: () => true,
  isAvailable: async () => true,
  readFile: () => Buffer.from("cipher"),
  decrypt: async () => JSON.stringify({ composioApiKey: "ak_live" }),
  sleep: async () => {},
  ...over,
});

describe("readSecureCredentials", () => {
  it("reports an empty store when no file was ever written", async () => {
    const result = await readSecureCredentials(deps({ exists: () => false }));
    expect(result).toEqual({ status: "empty", credentials: {} });
  });

  it("returns the stored credentials when the store opens", async () => {
    const result = await readSecureCredentials(deps());
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("tries again when the OS says the store is temporarily unavailable", async () => {
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(JSON.stringify({ composioApiKey: "ak_live" }));
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("waits between attempts instead of hammering the keychain", async () => {
    const slept = [];
    const decrypt = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("{}");
    await readSecureCredentials(deps({ decrypt, sleep: async (ms) => slept.push(ms) }));
    expect(slept).toEqual([100]);
  });

  it("says UNAVAILABLE — never empty — when every attempt fails", async () => {
    const decrypt = vi.fn().mockRejectedValue(transient());
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
    expect(result.error).toMatch(/temporarily unavailable/);
    expect(decrypt.mock.calls.length).toBeGreaterThan(1);
  });

  it("says UNAVAILABLE when the OS store itself is switched off", async () => {
    const result = await readSecureCredentials(deps({ isAvailable: async () => false }));
    expect(result.status).toBe("unavailable");
  });

  it("says UNAVAILABLE for a file it cannot parse, rather than pretending it is empty", async () => {
    const decrypt = vi.fn().mockResolvedValue("not json");
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});

describe("resetUnreadableCredentials", () => {
  const resetDeps = (over = {}) => ({
    unreadable: true,
    confirm: vi.fn(async () => true),
    exists: () => true,
    moveAside: vi.fn(),
    failed: vi.fn(async () => {}),
    restart: vi.fn(),
    ...over,
  });

  it("moves the unreadable file aside and restarts once the person confirms", async () => {
    const d = resetDeps();
    await expect(resetUnreadableCredentials(d)).resolves.toBe("reset");
    expect(d.moveAside).toHaveBeenCalledTimes(1);
    expect(d.restart).toHaveBeenCalledTimes(1);
  });

  it("never touches a store that was read, and does not even ask", async () => {
    const d = resetDeps({ unreadable: false });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("readable");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.moveAside).not.toHaveBeenCalled();
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("changes nothing when the person cancels", async () => {
    const d = resetDeps({ confirm: vi.fn(async () => false) });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("cancelled");
    expect(d.moveAside).not.toHaveBeenCalled();
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("tells the person and does not restart when the file cannot be moved aside", async () => {
    const busy = new Error("EBUSY: resource busy or locked");
    const d = resetDeps({ moveAside: vi.fn(() => { throw busy; }) });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("failed");
    expect(d.failed).toHaveBeenCalledWith(busy);
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("still restarts when the file is already gone", async () => {
    const d = resetDeps({ exists: () => false });
    await expect(resetUnreadableCredentials(d)).resolves.toBe("reset");
    expect(d.moveAside).not.toHaveBeenCalled();
    expect(d.restart).toHaveBeenCalledTimes(1);
  });
});
