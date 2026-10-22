import { useSyncExternalStore } from "react";

export const LANGUAGE_KEY = "omb-language";

let sessionChoice: string | null | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function languageChoice(): string | null {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(LANGUAGE_KEY) ?? null;
  } catch {
    return null;
  }
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setLanguageChoice(language: string): void {
  sessionChoice = language;
  try {
    const local = storage();
    local?.setItem(LANGUAGE_KEY, language);
    if (local?.getItem(LANGUAGE_KEY) === language) sessionChoice = undefined;
  } catch {
  }
  notify();
}

export function useLanguageChoice(): string | null {
  return useSyncExternalStore(subscribe, languageChoice, () => null);
}
