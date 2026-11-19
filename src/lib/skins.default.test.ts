import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();
const os = { dark: false, listeners: new Set<() => void>() };

async function boot() {
  vi.resetModules();
  const skins = await import("./skins");
  skins.applySkinChoice(skins.readSkinChoice());
  return { skin: document.documentElement.dataset.skin, stored: values.get("omb-skin") };
}

function setOsDark(dark: boolean) {
  os.dark = dark;
  for (const listener of os.listeners) listener();
}

beforeEach(() => {
  values.clear();
  os.dark = false;
  os.listeners.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset: {} as Record<string, string> } });
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === "(prefers-color-scheme: dark)" && os.dark; },
    addEventListener: (_type: string, listener: () => void) => { os.listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { os.listeners.delete(listener); },
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("default skin", () => {

  it("switches between Daylight and Midnight when the computer does, while following it", async () => {
    await boot();
    setOsDark(true);
    expect(document.documentElement.dataset.skin).toBe("midnight");
    setOsDark(false);
    expect(document.documentElement.dataset.skin).toBe("daylight");
  });

  it("stops following the computer once someone picks a skin", async () => {
    await boot();
    const skins = await import("./skins");
    skins.applySkin("meadow");
    setOsDark(true);
    expect(document.documentElement.dataset.skin).toBe("meadow");
    expect(values.get("omb-skin")).toBe("meadow");
  });

  it("keeps an install that ran before in Midnight when nobody picked a skin", async () => {
    values.set("omb-skin", "midnight");
    expect(await boot()).toMatchObject({ skin: "midnight", stored: "midnight" });
  });

  it("keeps Midnight for an earlier install whose saved skin is missing or no longer exists", async () => {
    values.set("omb-installed", "2026-01-01T00:00:00.000Z");
    expect(await boot()).toEqual({ skin: "midnight", stored: "midnight" });
    values.set("omb-skin", "retired-skin");
    expect(await boot()).toMatchObject({ skin: "midnight", stored: "midnight" });
  });

  it("always honours a skin someone chose", async () => {
    values.set("omb-skin", "lagoon");
    expect(await boot()).toMatchObject({ skin: "lagoon" });
    values.clear();
    values.set("omb-skin", "midnight");
    expect(await boot()).toMatchObject({ skin: "midnight" });
  });

  it("shows System as the theme and the matching look as the selected skin in Appearance on a fresh install", async () => {
    os.dark = true;
    await boot();
    const [{ SkinPicker }, { ThemeRow }] = await Promise.all([import("@/components/SkinPicker"), import("@/components/ThemeRow")]);
    const picker = renderToStaticMarkup(createElement(SkinPicker));
    const pressed = [...picker.matchAll(/aria-pressed="true"[\s\S]*?<div class="text-\[13px\] font-medium text-ink">([^<]+)</g)].map(([, name]) => name);
    expect(pressed).toEqual(["Midnight"]);
    const theme = renderToStaticMarkup(createElement(ThemeRow));
    expect([...theme.matchAll(/aria-checked="true"[^>]*>([^<]+)</g)].map(([, label]) => label)).toEqual(["System"]);
  });

  it("reports the chosen skin in Settings as a checked radio, not a pressed button", async () => {
    os.dark = true;
    await boot();
    const [{ SkinPicker }, { SettingsLook }] = await Promise.all([import("@/components/SkinPicker"), import("@/components/SettingsPrimitives")]);
    const picker = renderToStaticMarkup(createElement(SettingsLook.Provider, { value: true }, createElement(SkinPicker)));
    const radios = [...picker.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map(([radio]) => radio);
    expect(radios.filter((radio) => radio.includes('aria-checked="true"'))).toHaveLength(1);
    expect(radios.filter((radio) => radio.includes("aria-pressed"))).toEqual([]);
  });
});
