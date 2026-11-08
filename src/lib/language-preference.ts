import { useEffect, useState, useSyncExternalStore } from "react";
import { loadLocale } from "@/lib/i18n";

export const LANGUAGE_KEY = "omb-language";

let sessionChoice: string | null | undefined;
let storedChoiceOffered = false;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// Storage is per origin: this computer's page on each of its ports, My Cloud, a team and a saved server each have
// their own, so in the desktop app the choice lives in the app.
const desktop = () => globalThis.window?.ogb?.desktopLanguage;

function storedChoice(): string | null {
  try {
    return storage()?.getItem(LANGUAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** A pick saved in this page's storage before the app kept one becomes the app's pick. */
function desktopChoice(bridge: NonNullable<ReturnType<typeof desktop>>): string | null {
  const saved = bridge.choice();
  if (saved !== null || storedChoiceOffered) return saved;
  storedChoiceOffered = true;
  const earlier = storedChoice();
  if (earlier !== null) void bridge.set(earlier).catch(() => undefined);
  return earlier;
}

export function languageChoice(): string | null {
  if (sessionChoice !== undefined) return sessionChoice;
  const bridge = desktop();
  return bridge ? desktopChoice(bridge) : storedChoice();
}

export function effectiveLanguage(choice: string | null, serverDefault: string | undefined): string {
  return choice ?? serverDefault ?? "";
}

export function localeTag(language: string, system: string | undefined = globalThis.navigator?.language): string | undefined {
  return language || system;
}

export function startupLocaleTag(system: string | undefined = globalThis.navigator?.language): string | undefined {
  return localeTag(effectiveLanguage(languageChoice(), undefined), system);
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== LANGUAGE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function onDesktopChange() {
  sessionChoice = undefined;
  notify();
}

let stopDesktopChanges: (() => void) | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    stopDesktopChanges = desktop()?.onChange(onDesktopChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      stopDesktopChanges?.();
      stopDesktopChanges = undefined;
    }
  };
}

export function setLanguageChoice(language: string): void {
  sessionChoice = language;
  const bridge = desktop();
  if (bridge) {
    void bridge.set(language).catch(() => undefined);
    if (bridge.choice() === language) sessionChoice = undefined;
  }
  try {
    const local = storage();
    local?.setItem(LANGUAGE_KEY, language);
    if (!bridge && local?.getItem(LANGUAGE_KEY) === language) sessionChoice = undefined;
  } catch {
  }
  notify();
}

export function useLanguageChoice(): string | null {
  return useSyncExternalStore(subscribe, languageChoice, () => null);
}

/** The person's own language, loaded before a page first draws, so they never see another one first. `fallback`: the
 * language to show while nothing is picked. */
export function loadPageLanguage(fallback?: string): Promise<string> {
  return loadLocale(effectiveLanguage(languageChoice(), fallback) || globalThis.navigator?.language);
}

/** In the desktop app's rail: the language the window beside it shows, which the rail (like main's menus) follows while
 * nothing is picked; undefined before the window has said, in an older desktop app, or anywhere else. */
export function windowLanguage(): string | undefined {
  return desktop()?.windowShows?.() ?? undefined;
}

function subscribeWindow(listener: () => void): () => void {
  return desktop()?.onWindowShows?.(listener) ?? (() => {});
}

export function useWindowLanguage(): string | undefined {
  return useSyncExternalStore(subscribeWindow, () => windowLanguage() ?? null, () => null) ?? undefined;
}

/** Shows `language` (the system's when empty) once its pack has loaded, and draws the caller again then. `windowPage`:
 * the window's own page, whose language the desktop app's menus, tray and dialogs follow while nothing is picked. */
export function usePageLanguage(language: string, windowPage = false): void {
  const [, setShown] = useState(0);
  useEffect(() => {
    void loadLocale(language || globalThis.navigator?.language).then((shown) => {
      if (windowPage) desktop()?.shown?.(shown);
      setShown((count) => count + 1);
    });
  }, [language, windowPage]);
}
