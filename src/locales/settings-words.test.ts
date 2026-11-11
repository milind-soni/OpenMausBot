import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import en from "./en.json";

/** The redesigned Settings: its nav, page header and pages, the outer menu, and the rows every page shares. A key they
 * render must exist in every language, so a translated window never falls back to English (a German "Sign out"). */
const SETTINGS_DIR = "src/components/settings";
const SHARED = [
  "SettingsPrimitives.tsx", "NotificationSettingsRows.tsx", "AppSettingsRows.tsx", "AnalyticsRow.tsx", "OpenAtLoginRow.tsx",
  "TalkShortcutRow.tsx", "SidebarProfileMenu.tsx", "PlaceLookCard.tsx", "DefaultBotControls.tsx", "PhoneDevicesSection.tsx",
].map((file) => `src/components/${file}`);

function files(): string[] {
  const own = (readdirSync(SETTINGS_DIR, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts")).map((file) => join(SETTINGS_DIR, file));
  return [...own, ...SHARED];
}

function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of files()) {
    const text = readFileSync(file, "utf8");
    for (const pattern of [/\bt\(\s*"([A-Za-z0-9_.]+)"/g, /labelKey: "([A-Za-z0-9_.]+)"/g]) {
      for (const match of text.matchAll(pattern)) if (Object.hasOwn(en, match[1]!)) keys.add(match[1]!);
    }
  }
  return [...keys].sort();
}

const LOCALES = (readdirSync("src/locales") as string[]).filter((file) => file.endsWith(".json") && file !== "en.json" && file !== "source-hashes.json");

it("finds the keys Settings renders", () => {
  expect(usedKeys().length).toBeGreaterThan(200);
});

it.each(LOCALES)("%s has every key the Settings window, the outer menu and their shared rows render", (file) => {
  const pack = JSON.parse(readFileSync(join("src/locales", file), "utf8")) as Record<string, string>;
  expect(usedKeys().filter((key) => !Object.hasOwn(pack, key))).toEqual([]);
});
