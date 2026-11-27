// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endCall, startCall } from "./call";
import { callInProgress, useReportCallPresence } from "./call-presence";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  endCall();
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

describe("call presence", () => {
  it("a turn call or a running Live call is a call", () => {
    expect(callInProgress(null, "idle")).toBe(false);
    expect(callInProgress("bot-1", "idle")).toBe(true);
    for (const phase of ["starting", "live", "ending"] as const) expect(callInProgress(null, phase)).toBe(true);
    for (const phase of ["ended", "failed"] as const) expect(callInProgress(null, phase)).toBe(false);
  });

  it("tells main when a call starts and ends, and says none on mount", async () => {
    const callActive = vi.fn(async () => {});
    (window as unknown as { ogb: unknown }).ogb = { callActive };
    await act(async () => { root.render(createElement(() => { useReportCallPresence(); return null; })); });
    await act(async () => { startCall("bot-1"); });
    await act(async () => { endCall("bot-1"); });
    expect(callActive.mock.calls).toEqual([[false], [true], [false]]);
  });
});
