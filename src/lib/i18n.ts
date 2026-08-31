// Minimal string catalog — deliberately not a library. The renderer follows
// the system language; unknown tags and untranslated keys fall back to
// English, so a partial pack can ship the day it has one string.
import { en, locales, type LocaleKey, type LocalePack } from "@/locales";

/** "de-AT" → "de-at" if registered, else "de", else "en". Pure, for tests. */
export function resolveLocale(tag: string | undefined, available: ReadonlySet<string>): string {
  if (!tag) return "en";
  const lower = tag.toLowerCase();
  if (available.has(lower)) return lower;
  const base = lower.split("-")[0] ?? "";
  return available.has(base) ? base : "en";
}

/** Switch the active language (a future settings picker calls this too).
 * Returns the locale that actually took effect after fallback. The registry
 * is read live, so a pack registered after boot is immediately reachable. */
export function setLocale(tag: string | undefined): string {
  const resolved = resolveLocale(tag, new Set(Object.keys(locales)));
  activePack = locales[resolved] ?? en;
  return resolved;
}

let activePack: LocalePack = en;
setLocale(globalThis.navigator?.language);

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
