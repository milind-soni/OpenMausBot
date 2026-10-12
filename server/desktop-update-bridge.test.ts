import { afterEach, expect, it, vi } from "vitest";
import { DesktopUpdateBridge, type DesktopUpdateRequest } from "./desktop-update-bridge.ts";

afterEach(() => vi.useRealTimers());

it("correlates private replies, ignores unrelated and duplicate messages", async () => {
  const requests: DesktopUpdateRequest[] = [];
  const bridge = new DesktopUpdateBridge(message => { requests.push(message); return true; });
  const first = bridge.request("state"); const second = bridge.request("check");
  expect(bridge.receive({ type: "other" })).toBe(false);
  bridge.receive({ type: "openmausbot:update-result", requestId: "unrelated", state: { status: "downloaded" } });
  bridge.receive({ type: "openmausbot:update-result", requestId: requests[1]!.requestId, state: { status: "idle" } });
  expect(await second).toEqual({ status: "idle" });
  bridge.receive({ type: "openmausbot:update-result", requestId: requests[0]!.requestId, state: { status: "downloaded", version: "2" } });
  expect(await first).toEqual({ status: "downloaded", version: "2" });
  expect(bridge.receive({ type: "openmausbot:update-result", requestId: requests[0]!.requestId })).toBe(true);
});

it("cleans up a missing or exiting parent immediately", async () => {
  vi.useFakeTimers();
  for (const send of [() => false, () => { throw new Error("gone"); }]) {
    await expect(new DesktopUpdateBridge(send).request("install", "2")).rejects.toThrow("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  }
});

it("bounds missing replies and rejects malformed replies", async () => {
  vi.useFakeTimers();
  const requests: DesktopUpdateRequest[] = [];
  const bridge = new DesktopUpdateBridge(message => { requests.push(message); return true; });
  const pending = bridge.request("state"); const failure = expect(pending).rejects.toThrow("did not respond");
  await vi.advanceTimersByTimeAsync(30_000); await failure;
  expect(vi.getTimerCount()).toBe(0);
  const next = bridge.request("state");
  bridge.receive({ type: "openmausbot:update-result", requestId: requests[1]!.requestId, state: {} });
  await expect(next).rejects.toThrow("Invalid updater response");
  expect(vi.getTimerCount()).toBe(0);
});
