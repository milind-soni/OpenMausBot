// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdaterState } from "@/lib/updater";
import { UpdateBanner } from "./UpdateBanner";

let push: (state: UpdaterState) => void = () => {};
const seen = vi.fn(async () => {});
let focused = false;
let host: HTMLDivElement;
let root: Root;

const line = () => document.querySelector("[data-notice-toast]")?.textContent ?? null;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  seen.mockClear();
  focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  (window as unknown as { ogb: unknown }).ogb = {
    updater: {
      onState: (callback: (state: UpdaterState) => void) => {
        push = callback;
        callback({ status: "idle", updated: "0.1.130" });
        return () => {};
      },
      install: vi.fn(),
      check: vi.fn(),
      seen,
    },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the line after the app updated itself", () => {
  it("waits until the person looks at the window, says it once, and is then forgotten", async () => {
    await act(async () => root.render(createElement(UpdateBanner)));
    expect(line(), "nobody is looking yet").toBeNull();

    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(line()).toBe("OpenMausBot updated itself to 0.1.130.");
    expect(seen).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(5_000));
    expect(seen).toHaveBeenCalledOnce();
    await act(async () => push({ status: "idle" }));
    expect(line()).toBeNull();
  });

  it("gives way to an update that is ready again", async () => {
    focused = true;
    await act(async () => root.render(createElement(UpdateBanner)));
    await act(async () => push({ status: "downloaded", version: "0.1.131", updated: "0.1.130", installsByItself: true }));
    expect(line()).toBeNull();
    expect(host.textContent).toContain("OpenMausBot 0.1.131 is ready");
  });
});
