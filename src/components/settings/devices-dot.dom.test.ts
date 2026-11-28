// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { initialState, StoreContext } from "@/state/store";
import { devicesDot, setDevicesSignal } from "./devices-signal";
import { fullContext, visiblePages } from "./settings-index";
import { SettingsNav } from "./SettingsNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const place = { name: "This computer", kind: "computer" as const, color: null, named: false };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  setDevicesSignal(null);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "no route" }, { status: 404 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const ctx = fullContext({ advanced: false });
  act(() => root.render(createElement(StoreContext.Provider, { value: { state: initialState, dispatch: vi.fn() } as never },
    createElement(SettingsNav, { ctx, place, pages: visiblePages(ctx), current: "devices", query: "", hits: [], keyHits: [], narrow: false,
      onQuery: vi.fn(), onOpen: vi.fn(), onHit: vi.fn(), onKey: vi.fn(), onClose: vi.fn() }))));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setDevicesSignal(null);
  vi.unstubAllGlobals();
});

const dot = () => host.querySelector<HTMLElement>("[data-settings-page=devices] [data-settings-dot]");
const tell = (next: Parameters<typeof setDevicesSignal>[0]) => act(() => setDevicesSignal(next));

describe("the mark beside Devices", () => {
  it("is amber while anything on Devices needs the person, even with a phone connected, and says so", () => {
    tell({ place: "computer:This computer", needsYou: true, phoneConnected: true });
    expect(dot()?.getAttribute("data-settings-dot")).toBe("warning");
    expect(dot()?.getAttribute("aria-label")).toBe("A device or the private network needs you");
    expect(dot()?.title).toBe("A device or the private network needs you");
  });

  it("is green while a phone is connected and nothing needs the person, and says both", () => {
    tell({ place: "computer:This computer", needsYou: false, phoneConnected: true });
    expect(dot()?.getAttribute("data-settings-dot")).toBe("success");
    expect(dot()?.getAttribute("aria-label")).toBe("A phone is connected, and nothing needs you");
  });

  it("is not there with nothing to say, nor for what another place's Devices saw", () => {
    tell({ place: "computer:This computer", needsYou: false, phoneConnected: false });
    expect(dot()).toBeNull();
    tell({ place: "cloud:My Cloud", needsYou: true, phoneConnected: false });
    expect(dot()).toBeNull();
  });
});

describe("devicesDot", () => {
  it("puts what needs the person before a connected phone", () => {
    expect(devicesDot({ place: "x", needsYou: true, phoneConnected: false })).toBe("warning");
    expect(devicesDot({ place: "x", needsYou: false, phoneConnected: true })).toBe("success");
    expect(devicesDot({ place: "x", needsYou: false, phoneConnected: false })).toBeNull();
  });
});
