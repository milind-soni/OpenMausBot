// @vitest-environment happy-dom
// A provider-hosted desktop opened from plain web lives in its own tab, which the app can only watch from outside.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProviderDesktop, viewerClosedRelease } from "./computer-takeover";

type FakeTab = { closed: boolean; opener: unknown; location: { replace: ReturnType<typeof vi.fn> }; close: () => void };
let tab: FakeTab;
let requests: Array<{ action: string; lease?: string }>;
/** Whether a take's lease holds the computer: false while another device's hold sits on it. */
let owns: boolean;
const request = async (action: "take" | "release", lease?: string) => {
  requests.push({ action, lease });
  return { held: action === "take", owned: owns };
};

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  owns = true;
  tab = { closed: false, opener: window, location: { replace: vi.fn() }, close: () => { tab.closed = true; } };
  vi.stubGlobal("ogb", undefined);
  vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a provider desktop's own tab", () => {
  it("opens inside the click, cut off from the app, and closing it gives the computer back", async () => {
    await openProviderDesktop({
      botId: "scout", title: "Scout's live desktop", request, current: () => true,
      join: async () => ({ joinUrl: "https://desktop.invalid/scout" }),
    });
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledWith("https://desktop.invalid/scout");
    const lease = requests[0]!.lease;
    expect(requests).toEqual([{ action: "take", lease: expect.stringMatching(/^[0-9a-f]{36}$/) }]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests, "the computer stays the person's while its tab is open").toHaveLength(1);
    tab.closed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests.at(-1), "closing the tab left the bot waiting").toEqual({ action: "release", lease });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests).toHaveLength(2);
  });

  it("a join that fails closes the tab and gives the computer back", async () => {
    await expect(openProviderDesktop({
      botId: "scout", title: "Scout's live desktop", request, current: () => true,
      join: async () => { throw new Error("The cloud computer did not answer"); },
    })).rejects.toThrow("did not answer");
    expect(tab.closed).toBe(true);
    expect(requests.map((entry) => entry.action)).toEqual(["take", "release"]);
    expect(requests[1]!.lease).toBe(requests[0]!.lease);
  });

  it("a take whose answer is lost is given back with the lease it sent", async () => {
    const lost = async (action: "take" | "release", lease?: string) => {
      await request(action, lease);
      if (action === "take") throw new Error("The connection dropped");
      return { held: false };
    };
    await expect(openProviderDesktop({
      botId: "scout", title: "Scout's live desktop", request: lost, current: () => true,
      join: async () => ({ joinUrl: "https://desktop.invalid/scout" }),
    })).rejects.toThrow("connection dropped");
    expect(requests.map((entry) => entry.action)).toEqual(["take", "release"]);
    expect(requests[1]!.lease).toBe(requests[0]!.lease);
  });

  it("a take the server does not grant opens nothing", async () => {
    const join = vi.fn(async () => ({ joinUrl: "https://desktop.invalid/scout" }));
    const refused = async (action: "take" | "release", lease?: string) => {
      requests.push({ action, lease });
      return { held: false, owned: false };
    };
    await expect(openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request: refused, current: () => true, join }))
      .rejects.toMatchObject({ key: "computer.err.confirmControl" });
    expect(join).not.toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.closed).toBe(true);
  });

  it("a computer another device holds is taken with this tab's own lease, and not given back by this tab", async () => {
    owns = false;
    await openProviderDesktop({
      botId: "scout", title: "Scout's live desktop", request, current: () => true,
      join: async () => ({ joinUrl: "https://desktop.invalid/scout" }),
    });
    expect(requests).toEqual([{ action: "take", lease: expect.stringMatching(/^[0-9a-f]{36}$/) }]);
    tab.closed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests).toHaveLength(1);
  });
});

describe("the app's viewer window", () => {
  it.each([
    { row: "a provider desktop's open took the hold", opens: [true], lease: 0 },
    { row: "its open found another device's hold", opens: [false], lease: null },
    { row: "a reopen found another device's hold after an open that took it", opens: [true, false], lease: 0 },
    { row: "no open recorded it", opens: [], lease: null },
  ] as Array<{ row: string; opens: boolean[]; lease: number | null }>)("gives back, when it closes, only a hold its open's take owned: $row", async ({ opens, lease }) => {
    vi.stubGlobal("ogb", { desktopViewer: { open: vi.fn(async () => true) } });
    for (const owned of opens) {
      owns = owned;
      await openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join: async () => ({ joinUrl: "https://desktop.invalid/scout" }) });
    }
    expect(viewerClosedRelease("scout")).toEqual(lease === null ? null : { action: "release", controlLeaseId: requests[lease]!.lease });
    expect(viewerClosedRelease("scout"), "a close gives its lease back once").toBeNull();
  });

  it("gives back, after a reload of the page, the hold its open took before it", async () => {
    vi.stubGlobal("ogb", { desktopViewer: { open: vi.fn(async () => true) } });
    await openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join: async () => ({ joinUrl: "https://desktop.invalid/scout" }) });
    vi.resetModules();
    const reloaded = await import("./computer-takeover");
    expect(reloaded.viewerClosedRelease("scout")).toEqual({ action: "release", controlLeaseId: requests[0]!.lease });
  });

  it("gives back, once the reopened viewer closes, the hold of an open a reload of the page cut off during its join", async () => {
    vi.stubGlobal("ogb", { desktopViewer: { open: vi.fn(async () => true) } });
    void openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(0);
    vi.resetModules();
    const reloaded = await import("./computer-takeover");
    owns = false;
    await reloaded.openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join: async () => ({ joinUrl: "https://desktop.invalid/scout" }) });
    expect(reloaded.viewerClosedRelease("scout")).toEqual({ action: "release", controlLeaseId: requests[0]!.lease });
  });

  it("leaves nothing for a close to give back after an open whose join failed gave its hold back", async () => {
    vi.stubGlobal("ogb", { desktopViewer: { open: vi.fn(async () => true) } });
    await expect(openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join: async () => { throw new Error("join failed"); } })).rejects.toThrow("join failed");
    expect(requests).toEqual([{ action: "take", lease: requests[0]!.lease }, { action: "release", lease: requests[0]!.lease }]);
    expect(viewerClosedRelease("scout")).toBeNull();
  });

  it("opens and closes as if nothing were recorded when the page's storage refuses", async () => {
    const refuses = () => { throw new Error("storage refused"); };
    vi.stubGlobal("sessionStorage", { getItem: refuses, setItem: refuses, removeItem: refuses });
    vi.stubGlobal("ogb", { desktopViewer: { open: vi.fn(async () => true) } });
    await openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join: async () => ({ joinUrl: "https://desktop.invalid/scout" }) });
    expect(requests.map((entry) => entry.action), "the open went through").toEqual(["take"]);
    expect(viewerClosedRelease("scout")).toBeNull();
  });
});

it("the join is told the lease its take holds, so a Local VM join can name it", async () => {
  const join = vi.fn(async (_signal: AbortSignal, _lease: string) => ({ joinUrl: "https://desktop.invalid/scout" }));
  await openProviderDesktop({ botId: "scout", title: "Scout's live desktop", request, current: () => true, join });
  expect(join).toHaveBeenCalledWith(expect.any(AbortSignal), requests[0]!.lease);
});
