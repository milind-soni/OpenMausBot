// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The strip's own session check at 4 s and 20 s reads the page's server: not here.
vi.mock("@/lib/session-ended", () => ({ noteRefusedRequest: () => {} }));

import { endCloudWork, noteCloudUnanswered } from "@/lib/cloud-work";
import { setLocale } from "@/lib/i18n";
import { LiveConnectionStrip, RECONNECTING_AFTER_MS } from "./LiveConnectionStrip";

// The Cloud's own page asks the window what has its Cloud down only once its live stream has been down long enough to say so,
// then less and less often: a page load or a short dropout costs the Admin nothing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const MINUTE = 60_000;
let host: HTMLDivElement, root: Root | null = null;
const asks = vi.fn(async () => ({ kind: "update", since: Date.now() - 40_000, until: Date.now() + 17 * MINUTE, expectedAt: Date.now() + 2 * MINUTE }));

beforeEach(() => {
  vi.useFakeTimers();
  setLocale("en");
  asks.mockClear();
  Object.assign(window, { ogb: { home: { operation: asks } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; host.remove(); endCloudWork();
  delete (window as { ogb?: unknown }).ogb;
  vi.useRealTimers();
});

const show = (connected: boolean) => act(async () => root!.render(createElement(LiveConnectionStrip, { connected, hydrated: true })));
const pass = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const strip = () => host.querySelector("[data-live-connection]");

describe("asking what has the Cloud down", () => {
  it("asks nothing on a page load or a dropout shorter than the strip's 4 s", async () => {
    await show(false);
    await pass(RECONNECTING_AFTER_MS - 1_000);
    await show(true);
    await pass(5 * MINUTE);
    expect(asks).not.toHaveBeenCalled();
    expect(strip()).toBeNull();
  });

  it("asks at 4 s, then after 10, 20, 40 and every 60 s; nothing more once the stream is back", async () => {
    await show(true);
    await show(false);
    await pass(RECONNECTING_AFTER_MS - 1);
    expect(asks).toHaveBeenCalledTimes(0);
    await pass(1);
    expect(asks).toHaveBeenCalledTimes(1);
    expect(strip()?.getAttribute("data-live-connection")).toBe("working");
    expect(strip()?.textContent).toBe("Updating My Cloud to the latest version. Back in a minute or two.");
    const counts: number[] = [];
    for (const wait of [10_000, 20_000, 40_000, 60_000, 60_000]) { await pass(wait - 1); counts.push(asks.mock.calls.length); await pass(1); counts.push(asks.mock.calls.length); }
    expect(counts).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    await show(true);
    expect(strip()).toBeNull();
    await pass(5 * MINUTE);
    expect(asks).toHaveBeenCalledTimes(6);
  });

  it("asks at once when a send got no answer while the stream is down", async () => {
    await show(true);
    await show(false);
    await pass(1_000);
    expect(asks).not.toHaveBeenCalled();
    await act(async () => noteCloudUnanswered());
    await pass(0);
    expect(asks).toHaveBeenCalledTimes(1);
  });
});
