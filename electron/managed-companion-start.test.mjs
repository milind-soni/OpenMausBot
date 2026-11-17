import { describe, expect, it, vi } from "vitest";

import { startCheckedManagedConnection } from "./managed-companion-start.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("starting the managed connection with the phone link", () => {
  it("asks about the stored address before dialling it, and waits for it to verify only when asked to", async () => {
    const calls = [];
    const check = vi.fn(async () => { calls.push("check"); return null; });
    const start = vi.fn(async (options) => { calls.push(["start", options]); });
    await startCheckedManagedConnection({ check, start, wait: true, desired: () => true });
    expect(calls).toEqual(["check", ["start", { waitForVerification: true }]]);
  });

  it("starts behind the check without holding the caller, and not once the phone link stopped", async () => {
    let finish = () => {};
    const check = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const start = vi.fn(async () => {});
    let desired = true;
    await startCheckedManagedConnection({ check, start, wait: false, desired: () => desired });
    expect(start).not.toHaveBeenCalled();
    finish(null);
    await settle();
    expect(start).toHaveBeenCalledWith({ waitForVerification: false });

    const stopped = vi.fn(async () => {});
    await startCheckedManagedConnection({ check: async () => null, start: stopped, wait: false, desired: () => (desired = false) });
    await settle();
    expect(stopped).not.toHaveBeenCalled();
  });

  it("dials anyway when the check is slow, and lets the check correct it afterwards", async () => {
    const check = vi.fn(() => new Promise(() => {}));
    const start = vi.fn(async () => {});
    const begun = Date.now();
    await startCheckedManagedConnection({ check, start, wait: true, desired: () => true, checkWaitMs: 50 });
    expect(start).toHaveBeenCalledWith({ waitForVerification: true });
    expect(Date.now() - begun).toBeLessThan(2_000);

    const background = vi.fn(async () => {});
    await startCheckedManagedConnection({ check, start: background, wait: false, desired: () => true, checkWaitMs: 50 });
    expect(background).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(background).toHaveBeenCalledWith({ waitForVerification: false }));
  });

  it("does not dial once the phone link stopped during the check", async () => {
    const start = vi.fn(async () => {});
    await startCheckedManagedConnection({ check: async () => null, start, wait: true, desired: () => false });
    expect(start).not.toHaveBeenCalled();
  });

  it("still starts when the check fails or there is nothing to check", async () => {
    for (const check of [vi.fn(async () => Promise.reject(new Error("offline"))), vi.fn(() => { throw new Error("no account"); }), vi.fn(() => undefined)]) {
      const start = vi.fn(async () => {});
      await startCheckedManagedConnection({ check, start, wait: true, desired: () => true });
      expect(start).toHaveBeenCalledWith({ waitForVerification: true });
    }
  });
});
