import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { en } from "@/locales";
import { SETTINGS_PLACES, type SettingsPlace } from "../../../shared/settings-places";
import { SETTINGS_INDEX, SETTINGS_PAGES } from "./settings-index";
import { buildSettingsPlaces, settingsPlacesFile } from "./settings-places";

describe("the places bots cite", () => {
  it("are written out as Settings' own index reads in English (node --experimental-strip-types scripts/gen-settings-places.ts)", () => {
    expect(readFileSync(new URL("../../../shared/settings-places.ts", import.meta.url), "utf8")).toBe(settingsPlacesFile(en));
  });

  it("hold every page and every row search can open, each once", () => {
    const ids = buildSettingsPlaces(en).map((place) => place.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...SETTINGS_PAGES.map((page) => `page:${page.id}`), ...SETTINGS_INDEX.map((entry) => entry.id), "advanced-mode", "sidebar"]);
  });

  it("name a row by its page, its section and its own label, and say where Simple mode shows it", () => {
    const place = (id: string) => (SETTINGS_PLACES as readonly SettingsPlace[]).find((one) => one.id === id);
    expect(place("keys")).toMatchObject({ path: "Settings → AI → Other services" });
    expect(place("wifi")).toMatchObject({ path: "Settings → Phone & devices → How your phone reaches this computer → Same Wi-Fi", only: "the desktop app, on this computer's own page" });
    expect(place("language")).toMatchObject({ path: "Settings → General → Language", advanced: true, simplePath: "Settings → This app → Language" });
    expect(place("this-week")?.path).toBe("Settings → Plan & billing → This week");
    expect(place("apps")?.path).toMatch(/^the Apps panel/);
  });
});
