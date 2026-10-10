import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveConnectionPage, reusableConnectionUrl } from "./connector-oauth";

afterEach(() => vi.unstubAllGlobals());

describe("OAuth tab reservation", () => {
  it("reuses a link only before its original ten-minute expiry", () => {
    const page = { url: "https://auth.example.test/flow", createdAt: 1_000 };
    expect(reusableConnectionUrl(page, 1_000)).toBe(page.url);
    expect(reusableConnectionUrl(page, 600_999)).toBe(page.url);
    expect(reusableConnectionUrl(page, 601_000)).toBeNull();
    expect(reusableConnectionUrl(page, 601_001)).toBeNull();
    expect(reusableConnectionUrl(page, 999)).toBeNull();
    expect(reusableConnectionUrl(undefined)).toBeNull();
  });
  it("reserves synchronously, severs the opener and keeps a navigated tab open", async () => {
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => page);
    vi.stubGlobal("window", { open });
    const launch = reserveConnectionPage();
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(page.opener).toBeNull();
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(await launch.open("https://auth.example.test/flow")).toBe(true);
    expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/flow");
    launch.cancel();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("detects blocked and manually closed tabs without retrying an asynchronous popup", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const blocked = reserveConnectionPage();
    expect(await blocked.open("https://auth.example.test/flow")).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    const page = { opener: {}, closed: true, location: { replace: vi.fn() }, close: vi.fn() };
    open.mockReturnValue(page as never);
    const closed = reserveConnectionPage();
    expect(await closed.open("https://auth.example.test/flow")).toBe(false);
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("closes only its own blank on cancellation and refuses late navigation", async () => {
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const launch = reserveConnectionPage();
    launch.cancel();
    expect(page.close).toHaveBeenCalledOnce();
    expect(await launch.open("https://auth.example.test/flow")).toBe(false);
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("keeps Electron external opening without reserving a browser tab", async () => {
    const openExternal = vi.fn(async () => {});
    const open = vi.fn();
    vi.stubGlobal("window", { ogb: { openExternal }, open });
    const launch = reserveConnectionPage();
    expect(open).not.toHaveBeenCalled();
    expect(await launch.open("https://auth.example.test/flow")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/flow");
  });
});
