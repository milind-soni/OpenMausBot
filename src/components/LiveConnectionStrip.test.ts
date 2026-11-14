// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ noteRefusedRequest: vi.fn() }));
vi.mock("@/lib/session-ended", () => ({ noteRefusedRequest: session.noteRefusedRequest }));

import { LiveConnectionStrip, RECONNECTING_AFTER_MS, CONNECTION_HELP_AFTER_MS } from "./LiveConnectionStrip";
import { t } from "@/lib/i18n";
import { markCloudAsleep, resetCloudPowerForTests } from "@/lib/cloud-power";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  session.noteRefusedRequest.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  resetCloudPowerForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const draw = (connected: boolean, hydrated = true) => act(() => root.render(createElement(LiveConnectionStrip, { connected, hydrated })));

it("says the app is reconnecting once the live stream has been down for a moment, and goes when it is back", async () => {
  draw(false);
  expect(container.textContent).toBe("");
  await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_AFTER_MS); });
  expect(container.textContent).toContain(t("liveConnection.reconnecting"));
  draw(true);
  expect(container.textContent).toBe("");
});

it("says the device is offline at once", () => {
  draw(true);
  act(() => { window.dispatchEvent(new Event("offline")); });
  expect(container.textContent).toContain(t("liveConnection.offline"));
  act(() => { window.dispatchEvent(new Event("online")); });
  expect(container.textContent).toBe("");
});

it.each([true, false])("offers help and a retry after a prolonged connection failure (hydrated: %s)", async (hydrated) => {
  draw(false, hydrated);
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS - 1); });
  expect(container.querySelector("button")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(container.textContent).toContain(t("liveConnection.help"));
  const retry = container.querySelector("button")!;
  expect(retry.textContent).toBe(t("liveConnection.retry"));
  const sent = vi.spyOn(window, "dispatchEvent");
  act(() => retry.click());
  expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: "omb:retry-live-events" }));
  draw(true, hydrated);
  expect(container.textContent).toBe("");
  draw(false, hydrated);
  expect(container.querySelector("button")).toBeNull();
});

it("does not offer a network retry while offline or while a Cloud is asleep", async () => {
  draw(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS); });
  act(() => { window.dispatchEvent(new Event("offline")); });
  expect(container.textContent).toBe(t("liveConnection.offline"));
  expect(container.querySelector("button")).toBeNull();
  act(() => { window.dispatchEvent(new Event("online")); markCloudAsleep(); });
  expect(container.textContent).toBe("");
});

it("asks whether the sign-in ended once the stream is late, so a refused stream can show the pairing page", async () => {
  draw(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_AFTER_MS); });
  expect(session.noteRefusedRequest).toHaveBeenCalledOnce();
  draw(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS); });
  expect(session.noteRefusedRequest).toHaveBeenCalledOnce();
});

it("asks again when the help text appears, in case the first probe could not reach the server", async () => {
  draw(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS); });
  expect(session.noteRefusedRequest).toHaveBeenCalledTimes(2);
});

it("never asks an offline device or a sleeping Cloud", async () => {
  draw(false);
  act(() => { window.dispatchEvent(new Event("offline")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS); });
  expect(session.noteRefusedRequest).not.toHaveBeenCalled();
  act(() => { window.dispatchEvent(new Event("online")); markCloudAsleep(); });
  draw(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS); });
  expect(session.noteRefusedRequest).not.toHaveBeenCalled();
});

it("cancels delayed help when an initial connection recovers", async () => {
  draw(false, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_AFTER_MS); });
  expect(container.textContent).toBe("");
  draw(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_HELP_AFTER_MS); });
  expect(container.textContent).toBe("");
});
