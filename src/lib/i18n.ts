import { productName } from "@/lib/brand";
import { en, localeChoices, locales, type LocaleKey, type LocalePack } from "@/locales";

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

export function setLocale(tag: string | undefined): string {
  const resolved = resolveLocale(tag, new Set(Object.keys(locales)));
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
  const pack = locales[code];
  const shown = localeChoices.find((choice) => locales[choice.code] === pack)?.code ?? code;
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

let active = "en";
let activePack: LocalePack = en;
setLocale(globalThis.navigator?.language);

export function tFromServer(key: string | undefined, fallback: string | undefined): string | undefined {
  return key && Object.hasOwn(en, key) ? t(key as LocaleKey) : fallback;
}

/** `{app}` is the product's name as a person reads it (productName) unless `params` names it. */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const template = activePack[key] ?? en[key];
  if (!params && !template.includes("{app}")) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : name === "app" ? productName() : match,
  );
}
