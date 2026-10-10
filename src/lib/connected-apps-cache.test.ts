// Why this exists: the panel is a modal, so its in-memory inventory dies the
// moment it closes. Reopening then paints an empty list until the network
// answers — and if the answer is "I could not read your key", it stays empty.
// A user reads that as "my connections are gone". This remembers the last
// thing we were SURE about, so the panel opens showing it.
import { describe, expect, it, vi } from "vitest";

import { CONNECTED_APPS_CACHE_KEY, readCachedInventory, writeCachedInventory } from "./connected-apps-cache";

const fakeStorage = (seed: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
};

const gmail = { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] };

describe("connected apps cache", () => {
  it("round-trips an inventory", () => {
    const storage = fakeStorage();
    writeCachedInventory({ gmail }, 1_700_000_000_000, storage);
    expect(readCachedInventory(storage)).toEqual({ at: 1_700_000_000_000, services: { gmail } });
  });

  it("returns nothing when the user has no cache yet", () => {
    expect(readCachedInventory(fakeStorage())).toBeNull();
  });

  it("ignores a cache it cannot make sense of, rather than throwing at paint time", () => {
    expect(readCachedInventory(fakeStorage({ [CONNECTED_APPS_CACHE_KEY]: "{{{" }))).toBeNull();
    expect(readCachedInventory(fakeStorage({ [CONNECTED_APPS_CACHE_KEY]: '{"services":"nope"}' }))).toBeNull();
    expect(readCachedInventory(fakeStorage({ [CONNECTED_APPS_CACHE_KEY]: '"a string"' }))).toBeNull();
  });

  it("rejects malformed service and account records before the panel paints them", () => {
    const cached = (services: unknown) => fakeStorage({
      [CONNECTED_APPS_CACHE_KEY]: JSON.stringify({ at: 1, services }),
    });
    expect(readCachedInventory(cached({ gmail: { connected: "yes" } }))).toBeNull();
    expect(readCachedInventory(cached({ gmail: { connected: true, accounts: "invalid" } }))).toBeNull();
    expect(readCachedInventory(cached({
      gmail: { connected: true, accounts: [{ id: "ca_1", status: 42 }] },
    }))).toBeNull();
    expect(readCachedInventory(cached({
      gmail: { connected: true, accounts: [{ id: "ca_1", status: "ACTIVE", alias: 7 }] },
    }))).toBeNull();
  });

  it("survives storage that throws, which a private window does", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readCachedInventory(throwing)).toBeNull();
    expect(() => writeCachedInventory({ gmail }, 1, throwing)).not.toThrow();
  });

  it("keeps only what the panel paints, never a credential", () => {
    const storage = fakeStorage();
    writeCachedInventory({ gmail }, 1, storage);
    const raw = storage.getItem(CONNECTED_APPS_CACHE_KEY) ?? "";
    expect(raw).toContain("gmail");
    expect(raw).toContain("ca_1");
    expect(raw).not.toMatch(/ak_|token|secret|key"\s*:/i);
  });

  it("does not blow up when storage is missing entirely", () => {
    const spy = vi.fn();
    expect(readCachedInventory(undefined)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
