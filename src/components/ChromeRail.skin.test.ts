// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const wearSkin = vi.fn();
const loadTheme = vi.fn(async () => {});
let worn: unknown = null;

vi.mock("@/lib/theme/runtime", () => ({ loadTheme, wornTheme: () => worn }));
vi.mock("@/lib/skins", () => ({ wearSkin }));
vi.mock("@/lib/language-preference", () => ({
  effectiveLanguage: (choice: string) => choice,
  useLanguageChoice: () => "en",
  usePageLanguage: () => {},
}));
vi.mock("./AccountMenu", () => ({ AccountsSheet: () => null, useAccountsSheet: () => ({ open: false, close: () => {} }) }));
vi.mock("./DesktopCapabilities", () => ({ DesktopCapabilitiesProvider: () => null }));
vi.mock("./PlacesRail", () => ({ PlacesRail: () => null }));

const { ChromeRail } = await import("./ChromeRail");

let onSkin: ((skin: string) => void) | null = null;

async function render(): Promise<() => void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(ChromeRail)); });
  return () => { root.unmount(); host.remove(); };
}

async function rail(): Promise<(skin: string) => void> {
  const done = await render();
  if (!onSkin) {
    done();
    throw new Error("the rail never asked for the skin of the page beside it");
  }
  return onSkin;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  worn = null;
  onSkin = null;
  (window as { ogb?: unknown }).ogb = { rail: { onSkin: (cb: (skin: string) => void) => { onSkin = cb; } } };
});

afterEach(() => { delete (window as { ogb?: unknown }).ogb; document.body.innerHTML = ""; });

it("wears the skin of the page beside it while no theme is worn", async () => {
  const told = await rail();
  await act(async () => { told("daylight"); });
  expect(wearSkin).toHaveBeenCalledWith("daylight");
});

it("keeps the theme's own skin when a theme is worn", async () => {
  worn = { id: "neon", theme: { name: "Neon" } };
  const told = await rail();
  await act(async () => { told("daylight"); });
  expect(loadTheme).toHaveBeenCalledTimes(1);
  expect(wearSkin).not.toHaveBeenCalled();
});
