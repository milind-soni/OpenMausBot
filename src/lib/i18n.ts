// Minimal string catalog — deliberately not a library. The renderer follows
// the system language; unknown tags and untranslated keys fall back to
// English, so a partial pack can ship the day it has one string.
import { en, locales, type LocaleKey, type LocalePack } from "@/locales";

/** "zh-Hant-TW" → exact tag, then "zh-hant", then "zh", then "en". Pure, for tests. */
export function resolveLocale(tag: string | undefined, available: ReadonlySet<string>): string {
  if (!tag) return "en";
  let candidate = tag.toLowerCase();
  while (candidate) {
    if (available.has(candidate)) return candidate;
    const separator = candidate.lastIndexOf("-");
    if (separator < 0) break;
    candidate = candidate.slice(0, separator);
  }
  return "en";
}

/** Switch the active language (a future settings picker calls this too).
 * Returns the locale that actually took effect after fallback. The registry
 * is read live, so a pack registered after boot is immediately reachable. */
export function setLocale(tag: string | undefined): string {
  const resolved = resolveLocale(tag, new Set(Object.keys(locales)));
  activePack = locales[resolved] ?? en;
  active = resolved;
  return resolved;
}

/** The locale t() is answering in. React cannot see a module variable, so a
 * memoized subtree that renders catalog strings takes this as a prop and
 * re-renders when it changes — the transcript does exactly that. */
export function activeLocale(): string {
  return active;
}

let active = "en";
let activePack: LocalePack = en;
setLocale(globalThis.navigator?.language);

/** Translate a key the server chose rather than the renderer — the note a
 * held approval card shows. A key this build does not know (an older client
 * meeting a newer server, or a card saved before the key existed) falls back
 * to the English the server sends beside it, so the note always reads. */
export function tFromServer(key: string | undefined, fallback: string | undefined): string | undefined {
  return key && Object.hasOwn(en, key) ? t(key as LocaleKey) : fallback;
}

/** Look up a catalog string. `{name}` placeholders interpolate from params;
 * a placeholder without a matching param stays verbatim so a bad pack shows
 * its seams instead of dropping words. */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const template = activePack[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
