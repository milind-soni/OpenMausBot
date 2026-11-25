import type { BotSettingsSection } from "@/state/store";

export const LAST_BOT_SECTION_KEY = "openmausbot.lastBotSection.v1";

export const BOT_SETTINGS_SECTION_IDS: readonly BotSettingsSection[] = [
  "overview",
  "identity",
  "slack",
  "soul",
  "skills",
  "memory",
  "library",
  "routines",
  "access",
  "model",
  "permissions",
  "voice",
  "visibility",
  "history",
  "usage",
];

export function readLastBotSection(): BotSettingsSection | null {
  try {
    const stored = globalThis.localStorage?.getItem(LAST_BOT_SECTION_KEY);
    return stored && (BOT_SETTINGS_SECTION_IDS as readonly string[]).includes(stored)
      ? stored as BotSettingsSection
      : null;
  } catch {
    return null;
  }
}

export function rememberBotSection(section: BotSettingsSection): void {
  try {
    globalThis.localStorage?.setItem(LAST_BOT_SECTION_KEY, section);
  } catch {
  }
}
