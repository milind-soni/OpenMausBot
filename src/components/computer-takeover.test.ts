// @vitest-environment happy-dom
// A provider-hosted desktop opened from plain web lives in its own tab, which the app can only watch from outside.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProviderDesktop } from "./computer-takeover";

type FakeTab = { closed: boolean; opener: unknown; location: { replace: ReturnType<typeof vi.fn> }; close: () => void };
let tab: FakeTab;
let requests: Array<{ action: string; lease?: string }>;
const request = async (action: "take" | "release", lease?: string) => {
  requests.push({ action, lease });
  return { held: action === "take", owned: true };
};

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
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
      botId: "scout", title: "Scout's live desktop", held: false, request, current: () => true,
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
      botId: "scout", title: "Scout's live desktop", held: false, request, current: () => true,
      join: async () => { throw new Error("The cloud computer did not answer"); },
    })).rejects.toThrow("did not answer");
    expect(tab.closed).toBe(true);
    expect(requests.map((entry) => entry.action)).toEqual(["take", "release"]);
    expect(requests[1]!.lease).toBe(requests[0]!.lease);
  });

  it("a computer the person already holds is not taken again, nor given back by this tab", async () => {
    await openProviderDesktop({
      botId: "scout", title: "Scout's live desktop", held: true, request, current: () => true,
      join: async () => ({ joinUrl: "https://desktop.invalid/scout" }),
    });
    tab.closed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests).toEqual([]);
  });
});
