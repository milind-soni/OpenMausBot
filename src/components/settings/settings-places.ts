// Every real place in Settings, as the person reads it in English: the list bots cite instead of guessing a menu path.
// shared/settings-places.ts is this list written out (scripts/gen-settings-places.ts); settings-places.test.ts fails
// when the two differ.
import type { SettingsPlace } from "../../../shared/settings-places.ts";
import { ADVANCED_PAGES, fullContext, pageById, SETTINGS_INDEX, SETTINGS_PAGES, type SettingsContext, type SettingsIndexEntry, type SettingsPage } from "./settings-index.ts";

const HOW_TO_OPEN = "Settings opens from the menu under the person's name at the bottom of the sidebar (or Cmd+, on a Mac, Ctrl+, elsewhere). Its first entry is named after the place (This computer, My Cloud, or the server's name).";

const ARROW = " → ";
const JUMPS: Record<NonNullable<SettingsIndexEntry["jump"]>, string> = {
  apps: "the Apps panel (Connect apps, at the bottom of the sidebar)",
  automations: "Automations, in the sidebar",
  bot: "a bot's own Settings (click the bot's name at the top of its chat)",
  shortcuts: "the keyboard shortcut list (the menu under the person's name → Keyboard shortcuts)",
};
/** Pages shown under the place's own name, the account's or the app's, rather than a label of their own. */
const IDENTITY_PAGE: Partial<Record<SettingsPage["id"], string>> = { overview: "(the place's own name, at the top)" };

/** Where a page or row shows when it is not on every place: on this computer's own page in the desktop app, on another
 * place's page there, or in a browser; else the one kind of place that has it. */
const SEEN = { here: {}, elsewhere: { here: false }, browser: { desktop: false, here: false, home: false, cloud: true } } satisfies Record<string, Partial<SettingsContext>>;
const SEEN_ON: Record<string, string> = {
  here: "the desktop app, on this computer's own page", "here,elsewhere": "the desktop app", "elsewhere,browser": "a Cloud's or server's own page", browser: "MausBot in a browser",
};
const KINDS: ReadonlyArray<{ only: string; ctx: Partial<SettingsContext> }> = [
  { only: "a team's or a self-hosted server's Settings, for admins", ctx: { team: true } },
  { only: "a company's managed MausBot", ctx: { organization: true } },
  { only: "a place with the skills library on", ctx: { skills: true } },
  { only: "a server that manages installations", ctx: { installations: true } },
  { only: "a MausBot Cloud's Settings, for its owner or admins", ctx: { cloud: true, storage: true } },
];

function onlyOn(shows: (ctx: SettingsContext) => boolean): string | undefined {
  const seen = (Object.keys(SEEN) as Array<keyof typeof SEEN>).filter((name) => shows(fullContext(SEEN[name])));
  if (seen.length === 3) return undefined;
  if (seen.length) return SEEN_ON[seen.join(",")] ?? undefined;
  return KINDS.find(({ ctx }) => shows(fullContext(ctx)))?.only;
}

function fill(text: string): string {
  return text.replaceAll("{app}", "MausBot").replaceAll("{place}", "My Cloud");
}

/** The places, in Settings' own order, with their labels read from `labels` (the English catalog). */
export function buildSettingsPlaces(labels: Readonly<Record<string, string>>): SettingsPlace[] {
  const label = (key: string) => {
    const text = labels[key];
    if (!text) throw new Error(`no English label for ${key}`);
    return fill(text);
  };
  const pagePath = (page: SettingsPage) => `Settings${ARROW}${IDENTITY_PAGE[page.id] ?? label(page.labelKey)}`;
  const places: SettingsPlace[] = [];
  for (const page of SETTINGS_PAGES) {
    const only = onlyOn(page.when);
    places.push({
      id: `page:${page.id}`, path: pagePath(page), words: page.synonyms,
      ...(ADVANCED_PAGES.includes(page.id) ? { advanced: true as const } : {}), ...(only ? { only } : {}),
    });
  }
  for (const entry of SETTINGS_INDEX) {
    if (entry.jump) {
      places.push({ id: entry.id, path: JUMPS[entry.jump], words: [...new Set([label(entry.labelKey).toLowerCase(), ...(entry.synonyms ?? [])])] });
      continue;
    }
    const page = pageById(entry.page);
    const own = label(entry.labelKey);
    const section = entry.sectionKey && ![own, label(page.labelKey)].includes(label(entry.sectionKey)) ? label(entry.sectionKey) : null;
    const path = [pagePath(page), ...(section ? [section] : []), ...(own !== label(page.labelKey) ? [own] : [])].join(ARROW);
    const advanced = Boolean(entry.advanced) || ADVANCED_PAGES.includes(entry.page);
    const simple = entry.simple ? [pagePath(pageById(entry.simple.page)), own].join(ARROW) : undefined;
    const only = onlyOn((ctx) => page.when(ctx) && (entry.when?.(ctx) ?? true));
    places.push({
      id: entry.id, path, words: [...new Set([...(entry.topFor ?? []), ...(entry.synonyms ?? [])])],
      ...(advanced ? { advanced: true as const } : {}), ...(simple ? { simplePath: simple } : {}), ...(only ? { only } : {}),
    });
  }
  places.push(
    { id: "advanced-mode", path: `Settings${ARROW}${label("settings.advancedMode.title")} (the switch at the bottom of the list of pages)`, words: ["advanced", "simple", "advanced mode", "simple mode", "more settings"] },
    { id: "sidebar", path: "the sidebar", words: ["sidebar", "order", "pin", "group", "archive"] },
  );
  return places;
}

/** shared/settings-places.ts as committed: the shape, then one place per line. */
export function settingsPlacesFile(labels: Readonly<Record<string, string>>): string {
  return [
    "// Written by scripts/gen-settings-places.ts from Settings' own index and the English catalog; edit those, then run it.",
    "",
    "/** A real place in Settings, as the person reads it in English. `advanced`: only Advanced mode shows it; `simplePath`:",
    " * where Simple mode shows it instead. `only`: the one kind of place or app it shows on. */",
    "export interface SettingsPlace {",
    "  id: string;",
    "  path: string;",
    "  words: string[];",
    "  advanced?: true;",
    "  simplePath?: string;",
    "  only?: string;",
    "}",
    "",
    `export const SETTINGS_HOW_TO_OPEN = ${JSON.stringify(HOW_TO_OPEN)};`,
    "",
    "export const SETTINGS_PLACES = [",
    ...buildSettingsPlaces(labels).map((place) => `  ${JSON.stringify(place)},`),
    "] as const satisfies readonly SettingsPlace[];",
    "",
    "export type SettingsPlaceId = (typeof SETTINGS_PLACES)[number][\"id\"];",
    "",
  ].join("\n");
}
