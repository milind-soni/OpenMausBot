// @vitest-environment happy-dom
// The app icon row over a fake preload bridge: the saved picture, choosing, resetting, and a refused file.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { SettingsLook } from "./SettingsPrimitives";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = "data:image/png;base64,AAAA";
const defaultIcon = { custom: false, preview };
const customIcon = { custom: true, name: "moon.png", preview };

const { AppIconRow } = await import("./AppIconRow");

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((one) => one.textContent === label);

function install(over: { state?: () => Promise<AppIconState>; choose?: () => Promise<unknown>; reset?: () => Promise<unknown> } = {}) {
  const appIcon = {
    state: vi.fn(over.state ?? (async () => defaultIcon)),
    choose: vi.fn(over.choose ?? (async () => ({ outcome: "saved", state: customIcon }))),
    reset: vi.fn(over.reset ?? (async () => ({ outcome: "reset", state: defaultIcon }))),
  };
  (globalThis as { ogb?: unknown }).ogb = { appIcon };
  return appIcon;
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

async function render() {
  await act(async () => { root.render(createElement(SettingsLook.Provider, { value: true }, createElement(AppIconRow))); });
}

describe("the app icon row", () => {
  it("shows the app's own icon until a picture is chosen", async () => {
    const bridge = install();
    await render();
    expect(text()).toContain("App icon");
    expect(text()).toContain("Use your own picture");
    expect(host.querySelector("img")?.getAttribute("src")).toBe(preview);
    expect(button("Use default")).toBeUndefined();
    expect(bridge.state).toHaveBeenCalledOnce();
  });

  it("chooses a picture, names it, and lets the person go back", async () => {
    const bridge = install();
    await render();
    await act(async () => button("Choose icon…")!.click());
    expect(bridge.choose).toHaveBeenCalledOnce();
    expect(text()).toContain("Using moon.png");
    await act(async () => button("Use default")!.click());
    expect(bridge.reset).toHaveBeenCalledOnce();
    expect(text()).toContain("Use your own picture");
    expect(button("Use default")).toBeUndefined();
  });

  it("keeps the current icon and says why when the picture is too large", async () => {
    install({ choose: async () => ({ outcome: "error", problem: "size" }) });
    await render();
    await act(async () => button("Choose icon…")!.click());
    expect(host.querySelector("[role=alert]")?.textContent).toBe("That picture is larger than 8 MB.");
    expect(text()).toContain("Use your own picture");
  });

  it("draws nothing when this app has no icon bridge", async () => {
    await render();
    expect(host.textContent).toBe("");
  });
});
