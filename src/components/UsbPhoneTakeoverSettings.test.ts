// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { UsbPhoneTakeoverSettings } from "./UsbPhoneTakeoverSettings";

const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  api: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(UsbPhoneTakeoverSettings)));
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Watch and take over the USB phone"]');

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.dispatch.mockImplementation((action: { type: string; config?: Record<string, unknown> }) => {
    if (action.type === "configStatus") fixture.config = action.config;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("Watch and take over the USB phone setting", () => {
  it("is not shown by a server that does not report the flag", () => {
    fixture.config = { features: { skillAuthoring: true } };
    render();
    expect(host.textContent).toBe("");
  });

  it("starts off, and turns on as features.usbPhoneTakeover with the server's answer", async () => {
    fixture.config = { features: { usbPhoneTakeover: false } };
    const saved = { features: { usbPhoneTakeover: true } };
    fixture.api.mockResolvedValue(saved);
    render();
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Shows the bots' USB Android phone live");
    expect(host.textContent).not.toContain("Off by default.");
    flushSync(() => [...host.querySelectorAll("button")].find((button) => !button.hasAttribute("aria-label"))!.click());
    expect(host.textContent).toContain("Off by default.");

    flushSync(() => toggle()!.click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { usbPhoneTakeover: true } }),
    });
    render();
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
  });

  it("turns off again, and shows a refusal from the server", async () => {
    fixture.config = { features: { usbPhoneTakeover: true } };
    fixture.api.mockRejectedValue(new Error("only an admin may change this"));
    render();
    flushSync(() => toggle()!.click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("only an admin may change this"));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { usbPhoneTakeover: false } }),
    });
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
  });
});
