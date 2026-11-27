import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecretHolds } from "./browser-secret-hold.ts";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const at = (url: string) => async () => url;

describe("a secret held on a page", () => {
  it("refuses page scripts on that page until the hold ends, and lets them run once the page moved", async () => {
    const holds = new SecretHolds(async () => true);
    holds.hold("s", { url: "https://example.com/login#step", ms: 60_000 });
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(true);
    expect(await holds.refuses("other", at("https://example.com/login"))).toBe(false);
    vi.advanceTimersByTime(59_000);
    expect(await holds.refuses("s", at("https://example.com/login#other"))).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(false);
    holds.hold("s", { url: "https://example.com/login", ms: 60_000 });
    expect(await holds.refuses("s", at("https://example.com/dashboard"))).toBe(false);
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(false);
  });

  it("belongs to the tab it was typed in: a page in another tab neither meets the hold nor ends it", async () => {
    const holds = new SecretHolds(async () => true);
    holds.hold("s", { url: "https://example.com/login", ms: 60_000, tab: "T1" });
    expect(await holds.refuses("s", at("https://example.com/other"), "T2")).toBe(false);
    expect(await holds.refuses("s", at("https://example.com/login"), "T2")).toBe(false);
    expect(await holds.refuses("s", at("https://example.com/login"), "T1")).toBe(true);
    expect(await holds.refuses("s", at("https://example.com/next"), "T1")).toBe(false);
    expect(await holds.refuses("s", at("https://example.com/login"), "T1")).toBe(false);
  });

  it("counts a page whose address cannot be read as the held one", async () => {
    const holds = new SecretHolds(async () => true);
    holds.hold("s", { url: "https://example.com/login", ms: 60_000 });
    expect(await holds.refuses("s", at(""))).toBe(true);
  });

  it("clears a form left for the bot when the hold ends, and keeps refusing until the clear has run", async () => {
    let ran = false;
    const runClear = vi.fn(async (_session: string, clear: () => Promise<void>) => { if (!ran) return false; await clear(); return true; });
    const clear = vi.fn(async () => undefined);
    const holds = new SecretHolds(runClear);
    holds.hold("s", { url: "https://example.com/login", ms: 60_000, clear });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runClear).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(true);
    expect(await holds.refuses("s", at("https://example.com/next"))).toBe(false);
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(true);
    ran = true;
    holds.hold("s", { url: "https://example.com/login", ms: 60_000, clear });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(false);
  });

  it("forgets a session's hold and its clear when the browser closes", async () => {
    const runClear = vi.fn(async () => true);
    const holds = new SecretHolds(runClear);
    holds.hold("s", { url: "https://example.com/login", ms: 60_000, clear: async () => undefined });
    expect(holds.sessions()).toEqual(["s"]);
    holds.drop("s");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runClear).not.toHaveBeenCalled();
    expect(holds.sessions()).toEqual([]);
    expect(await holds.refuses("s", at("https://example.com/login"))).toBe(false);
  });
});
