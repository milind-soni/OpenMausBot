// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { DeviceNotificationsRow } from "./NotificationSettingsRows";

const fixture = vi.hoisted(() => ({ optedIn: true, setFinishedNotifications: vi.fn() }));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => true,
  setNotificationSounds: vi.fn(),
  useNotificationFeed: () => false,
  setNotificationFeed: vi.fn(),
  useFinishedNotifications: () => fixture.optedIn,
  setFinishedNotifications: fixture.setFinishedNotifications,
}));

let root: Root | undefined;
let container: HTMLDivElement;
let permission: NotificationPermission;
const readPermission = vi.fn(() => permission);
const requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");

beforeEach(() => {
  vi.clearAllMocks();
  fixture.optedIn = true;
  permission = "granted";
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", { get permission() { return readPermission(); }, requestPermission });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;
const mount = async () => { await act(async () => root!.render(createElement(StrictMode, null, createElement(DeviceNotificationsRow)))); };
const resume = async (event: "visibilitychange" | "focus") => {
  await act(async () => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
};

it.each(["visibilitychange", "focus"] as const)("follows a permission changed in the browser on %s, without asking", async (event) => {
  await mount();
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  permission = "denied";
  await resume(event);
  expect(toggle().disabled).toBe(true);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("Notifications are blocked for this site");
  permission = "granted";
  await resume(event);
  expect(toggle().disabled).toBe(false);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(requestPermission).not.toHaveBeenCalled();
  expect(fixture.setFinishedNotifications).not.toHaveBeenCalled();
});

it("asks the browser only from the switch, and turns finished notices on once allowed", async () => {
  permission = "default";
  fixture.optedIn = false;
  await mount();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(requestPermission).not.toHaveBeenCalled();
  await act(async () => toggle().click());
  expect(requestPermission).toHaveBeenCalledOnce();
  expect(fixture.setFinishedNotifications).toHaveBeenCalledWith(true);

  requestPermission.mockResolvedValueOnce("denied");
  fixture.setFinishedNotifications.mockClear();
  permission = "default";
  await resume("focus");
  await act(async () => toggle().click());
  expect(fixture.setFinishedNotifications).not.toHaveBeenCalled();
  expect(toggle().disabled).toBe(true);
});

it("keeps a muted device muted when permission is granted elsewhere, and toggles without asking once allowed", async () => {
  fixture.optedIn = false;
  await mount();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle().click());
  expect(requestPermission).not.toHaveBeenCalled();
  expect(fixture.setFinishedNotifications).toHaveBeenCalledWith(true);
});

it("ignores hidden pages and stops listening once unmounted", async () => {
  await mount();
  permission = "denied";
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await resume("focus");
  expect(toggle().disabled).toBe(false);
  await act(async () => root!.unmount());
  root = undefined;
  readPermission.mockClear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await resume("visibilitychange");
  await resume("focus");
  expect(readPermission).not.toHaveBeenCalled();
});
