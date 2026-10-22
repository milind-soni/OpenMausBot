import { activeLocale, documentLanguage } from "@/lib/i18n";

type DesktopLanguageBridge = import("../../electron/desktop-prefs.mjs").DesktopLanguageBridge;

export function tellDesktopLanguage(language: string, configLoaded: boolean, bridge: DesktopLanguageBridge | undefined = globalThis.window?.ogb?.desktopLanguage): Promise<void> | undefined {
  if (!language && !configLoaded) return undefined;
  return bridge?.set(language ? documentLanguage(activeLocale()).toLowerCase() : "").catch(() => {});
}
