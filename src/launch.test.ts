// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { PHONE_LAYOUT } from "./lib/use-media-query";
import { revealWhenReady, withLaunchTimeout } from "./launch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  [true, "[data-sidebar-hero] [data-avatar]", "ready"],
  [false, '[data-sidebar-tile="primary"] [data-launch-chief] [data-avatar]', "ready"],
  [false, '[data-sidebar-tile="primary"] [data-launch-chief] [data-avatar]', "offline"],
  [false, '[data-sidebar-tile="primary"] [data-launch-chief] [data-avatar]', "retry"],
] as const)("animates to the visible Chief (phone=%s, target=%s, reason=%s)", (phone, selector, reason) => {
  vi.useFakeTimers();
  const content = document.createElement("div");
  content.innerHTML = '<div data-launch-waiting="server"></div>';
  const root = { inert: true, querySelector: (query: string) => content.querySelector(query) };
  const launch = { style: { setProperty: vi.fn() }, remove: vi.fn() };
  const flight = { onfinish: () => {} };
  const face = { animate: vi.fn(() => flight), getBoundingClientRect: () => ({ left: 400, top: 300, width: 96, height: 96 }) };
  const avatar = { closest: () => null, animate: vi.fn(), getBoundingClientRect: () => ({ left: 10, top: 20, right: 52, bottom: 62, width: 42, height: 42 }) };
  const elements = new Map<string, unknown>([["root", root], ["launch", launch], ["launch-face", face]]);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === PHONE_LAYOUT && phone }));
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("innerWidth", 900);
  vi.stubGlobal("innerHeight", 700);
  vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id), querySelectorAll: (query: string) => query === selector ? [avatar] : [] });
  revealWhenReady();
  vi.advanceTimersByTime(2000);
  expect(face.animate).not.toHaveBeenCalled();
  if (reason === "ready") content.firstElementChild!.removeAttribute("data-launch-waiting");
  if (reason === "offline") content.insertAdjacentHTML("beforeend", '<div data-live-connection="offline"></div>');
  if (reason === "retry") content.insertAdjacentHTML("beforeend", '<button data-live-connection-retry></button>');
  vi.advanceTimersByTime(100);
  expect(face.animate).toHaveBeenCalledOnce();
  expect(avatar.animate).toHaveBeenCalledOnce();
  expect(launch.style.setProperty).toHaveBeenCalledWith("--launch-backdrop", "0");
  expect(launch.remove).not.toHaveBeenCalled();
  expect(root.inert).toBe(true);
  flight.onfinish();
  expect(launch.remove).toHaveBeenCalledOnce();
  expect(root.inert).toBe(false);
});

it("times out unresolved startup after one minute and ignores a late result", async () => {
  vi.useFakeTimers();
  const startup = Promise.withResolvers<string>();
  const onReady = vi.fn();
  const onError = vi.fn();
  const result = withLaunchTimeout(startup.promise).then(onReady, onError);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(onError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(onError).toHaveBeenCalledWith(expect.any(Error));
  startup.resolve("ready");
  await startup.promise;
  expect(onReady).not.toHaveBeenCalled();
});

it("clears the startup timeout once the page is ready", async () => {
  vi.useFakeTimers();
  await expect(withLaunchTimeout(Promise.resolve("ready"))).resolves.toBe("ready");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancelled", "throws", "no event"] as const)("reveals the app when the launch animation %s", (outcome) => {
  vi.useFakeTimers();
  const root = { inert: true, querySelector: () => null };
  const launch = { style: { setProperty: vi.fn() }, remove: vi.fn() };
  const flight = { onfinish: () => {}, oncancel: () => {} };
  const face = { animate: vi.fn(() => {
    if (outcome === "throws") throw new Error("animation unavailable");
    return flight;
  }) };
  const elements = new Map<string, unknown>([["root", root], ["launch", launch], ["launch-face", face]]);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [] });

  revealWhenReady();
  vi.advanceTimersByTime(1);
  if (outcome === "cancelled") flight.oncancel();
  if (outcome === "no event") vi.advanceTimersByTime(1000);
  expect(root.inert).toBe(false);
  flight.onfinish();
  vi.advanceTimersByTime(1000);
  expect(launch.remove).toHaveBeenCalledOnce();
  expect(root.inert).toBe(false);
});
