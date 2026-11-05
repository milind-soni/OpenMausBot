// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.mock("./MenuMotion", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MenuMotion")>(),
  useMenuMotion: () => ({ shown: true, closing: false, className: "", exitProps: {} }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        config: { ...original.initialState.config, features: { browser: true }, browserEngine: { kind: "engine" } },
        instances: [{
          instanceId: "test", driverKind: "grokAgent", displayName: "Grok", snapshot: { state: "available" },
          capabilities: { computerMcp: true, browserMcp: true },
        } as InstanceInfo],
      },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({
    capabilities: {
      dictation: { available: false },
      host: { packaged: true, platform: "darwin" },
      localComputer: { available: true, support: "supported", enabled: true, status: "enabled" },
    },
    ready: true,
  }),
}));

const { PlaceChip } = await import("./PlaceChip");

const bot = {
  id: "bot", threadId: "thread", name: "Rio", title: "", description: "", color: "green", notifications: true,
  unread: false, busy: false, messages: [], computer: undefined, modelSelection: { instanceId: "test", model: "grok-4.6" },
} as Bot;

let root: Root | undefined;
afterEach(() => { flushSync(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

describe("the desktop place menu", () => {
  it("pins Browser when the person clicks it, though Auto picked Browser already", () => {
    const onPin = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    flushSync(() => root!.render(createElement(PlaceChip, { bot, live: false, task: { surface: "browser", surfaceAuto: true }, onPin })));
    const row = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((el) => el.textContent?.startsWith("Browser"));
    expect(row).toBeDefined();
    flushSync(() => row!.click());
    expect(onPin).toHaveBeenCalledWith("browser");
  });
});
