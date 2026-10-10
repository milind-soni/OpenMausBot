import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { createSecureCredentialState } from "./secure-credential-state.mjs";

describe("serialized secure credential state", () => {
  // A launch that could not READ credentials.bin starts from {}. Writing a
  // document derived from {} would not "add a key" — it would replace every
  // secret in the file with nothing, and orphan the connected-apps identity
  // the user already authorized. So such a state does not write at all.
  it("refuses to persist when it was built from an unreadable store", async () => {
    const persist = vi.fn();
    const state = createSecureCredentialState({}, persist, { writable: false });

    await expect(state.update((credentials) => ({ ...credentials, xaiApiKey: "new" }))).rejects.toThrow(
      /credential store/i,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("still answers reads when it cannot write, so callers see an empty view rather than a crash", async () => {
    const state = createSecureCredentialState({}, vi.fn(), { writable: false });
    expect(state.read()).toEqual({});
  });

  it("writes normally when the store was readable", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const state = createSecureCredentialState({ boxToken: "old" }, persist, { writable: true });

    await state.update((credentials) => ({ ...credentials, boxToken: "new" }));
    expect(persist).toHaveBeenCalledWith({ boxToken: "new" });
  });

  it("writes normally when no options are passed at all", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const state = createSecureCredentialState({}, persist);
    await state.update(() => ({ boxToken: "x" }));
    expect(persist).toHaveBeenCalled();
  });

  it("derives concurrent changes from the latest committed copy", async () => {
    const writes = [];
    let releaseFirst;
    const firstPersisted = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const persist = vi.fn(async (value) => {
      writes.push(value);
      if (writes.length === 1) await firstPersisted;
    });
    const state = createSecureCredentialState({ existing: "kept" }, persist);

    const first = state.update((draft) => ({ ...draft, account: "signed" }));
    const second = state.update((draft) => ({ ...draft, apiKey: "saved" }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(state.read()).toEqual({ existing: "kept", account: "signed", apiKey: "saved" });
    expect(writes.at(-1)).toEqual({ existing: "kept", account: "signed", apiKey: "saved" });
  });

  it("returns copies that cannot mutate committed state", () => {
    const state = createSecureCredentialState({ nested: { value: "safe" } }, vi.fn());
    const snapshot = state.read();
    snapshot.nested.value = "changed";
    expect(state.read()).toEqual({ nested: { value: "safe" } });
  });

  it("accepts a cross-realm plain record and normalizes it to a local copy", () => {
    const foreign = runInNewContext("({ nested: { value: 'safe' } })");
    const state = createSecureCredentialState(foreign, vi.fn());

    expect(state.read()).toEqual({ nested: { value: "safe" } });
    expect(Object.getPrototypeOf(state.read())).toBe(Object.prototype);
  });

  it("rejects non-record documents and enumerable symbol keys", () => {
    class CredentialBag {}
    const symbolKeyed = { value: "safe" };
    symbolKeyed[Symbol("secret")] = "not-a-string-key";

    for (const invalid of [null, [], new Date(), new CredentialBag(), symbolKeyed]) {
      expect(() => createSecureCredentialState(invalid, vi.fn())).toThrow(TypeError);
    }
  });

  it("restores the encrypted document when the second phase fails", async () => {
    const writes = [];
    const state = createSecureCredentialState({ apiKey: "old" }, async (value) => writes.push(value));

    await expect(state.update(
      (draft) => ({ ...draft, apiKey: "new" }),
      async () => {
        throw new Error("local server rejected it");
      },
    )).rejects.toThrow("local server rejected it");

    expect(state.read()).toEqual({ apiKey: "old" });
    expect(writes).toEqual([{ apiKey: "new" }, { apiKey: "old" }]);
  });

  it("does not publish state when encrypted persistence fails", async () => {
    const state = createSecureCredentialState({ value: "old" }, async () => {
      throw new Error("keychain unavailable");
    });
    await expect(state.update((draft) => ({ ...draft, value: "new" }))).rejects.toThrow(
      "keychain unavailable",
    );
    expect(state.read()).toEqual({ value: "old" });
  });
});
