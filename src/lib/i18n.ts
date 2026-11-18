import { productName } from "@/lib/brand";
import { en, loadLocalePack, localeChoices, localePacks, locales, type LocaleKey, type LocalePack } from "@/locales";

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

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

/** Every tag a pack is shown for, loaded or not. */
export function knownLocales(): Set<string> {
  return new Set([...Object.keys(localePacks), ...Object.keys(locales)]);
}

/** Shows `tag`'s language when its pack is loaded (loadLocale), English otherwise; returns the locale that took effect. */
export function setLocale(tag: string | undefined): string {
  switches += 1;
  return show(resolveLocale(tag, new Set(Object.keys(locales))));
}

/** Loads `tag`'s pack and shows it, unless another language was asked for meanwhile; until then the page keeps the
 * language it shows. Resolves to the locale shown. */
export async function loadLocale(tag: string | undefined): Promise<string> {
  const asked = ++switches;
  await loadLocalePack(resolveLocale(tag, knownLocales())).catch(() => undefined);
  return asked === switches ? show(resolveLocale(tag, new Set(Object.keys(locales)))) : active;
}

function show(resolved: string): string {
  activePack = locales[resolved] ?? en;
  active = resolved;
  // Screen readers choose pronunciation from <html lang>, and index.html ships "en".
  const root = typeof document === "undefined" ? undefined : document?.documentElement;
  if (root) {
    root.lang = documentLanguage(resolved);
    root.dir = RTL_LANGUAGES.has(root.lang.split("-")[0]!) ? "rtl" : "ltr";
  }
  return resolved;
}

export function documentLanguage(code: string): string {
  const pack = localePacks[code];
  const shown = (pack && localeChoices.find((choice) => localePacks[choice.code] === pack)?.code) || code;
  return shown
    .split("-")
    .map((part, index) =>
      index === 0 ? part.toLowerCase()
        : part.length === 2 ? part.toUpperCase()
          : part.length === 4 ? part[0]!.toUpperCase() + part.slice(1).toLowerCase()
            : part.toLowerCase())
    .join("-");
}

/** React cannot see the module variable t() reads, so memoized subtrees take this as a prop. */
export function activeLocale(): string {
  return active;
}

export function intlLocale(system: string | undefined = globalThis.navigator?.language): string {
  const tag = documentLanguage(active);
  if (tag.includes("-") || !system) return tag;
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(system)[0];
  } catch {
    return tag;
  }
  return canonical?.toLowerCase().split("-")[0] === tag ? canonical : tag;
}

let active = "en";
let activePack: LocalePack = en;
let switches = 0;

export function tFromServer(key: string | undefined, fallback: string, params?: Record<string, string | number>): string;
export function tFromServer(key: string | undefined, fallback: string | undefined, params?: Record<string, string | number>): string | undefined;
export function tFromServer(key: string | undefined, fallback: string | undefined, params?: Record<string, string | number>): string | undefined {
  if (!key || !Object.hasOwn(en, key)) return fallback;
  const template = activePack[key as LocaleKey] ?? en[key as LocaleKey];
  const unfilled = [...template.matchAll(/\{(\w+)\}/g)].some(([, name]) => !params || !Object.hasOwn(params, name!));
  return unfilled ? fallback : t(key as LocaleKey, params);
}

export function activePackComplete(): boolean {
  return activePack !== en && Object.keys(en).every((key) => Object.hasOwn(activePack, key));
}

/** `{app}` is the product's name as a person reads it (productName) unless `params` names it. */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const template = activePack[key] ?? en[key];
  if (!params && !template.includes("{app}")) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : name === "app" ? productName() : match,
  );
}
