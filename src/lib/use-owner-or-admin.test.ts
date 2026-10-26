// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: Root | null = null;
let seen: (boolean | null)[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  seen = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  const { useOwnerOrAdmin } = await import("./use-owner-or-admin");
  function Probe() {
    seen.push(useOwnerOrAdmin());
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(createElement(Probe)));
}

describe("useOwnerOrAdmin", () => {
  it("looks the session up again after a failed read and shows owner controls once it answers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(new Response(JSON.stringify({ kind: "loopback" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await mount();
    expect(seen.at(-1)).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe(true);
  });

  it("lets controls mounted after a failed read wait for the one retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(new Response(JSON.stringify({ kind: "loopback" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await mount();
    act(() => root?.unmount());
    seen = [];
    await mount();
    expect(seen).toEqual([false]);
    expect(fetch).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe(true);
  });

  it("keeps a session it read without asking the server again", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ kind: "loopback" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await mount();
    act(() => root?.unmount());
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(seen.at(-1)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
