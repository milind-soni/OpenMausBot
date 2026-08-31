// Language registry — a language is one JSON file plus one line here.
// Catalogs are plain JSON so the optional Claude helper and human translators can
// read/write the same reviewable files without a runtime service.
// Packs are PARTIAL: any key a pack omits falls back to English, so a
// half-translated language is a usable language, not a broken one.
import en from "./en.json";
import de from "./de.json";
import es from "./es.json";
import fr from "./fr.json";
import hi from "./hi.json";
import ja from "./ja.json";
import ptBr from "./pt-br.json";
import zh from "./zh.json";

export { en };
export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;

export const locales: Record<string, LocalePack> = {
  en,
  de,
  es,
  fr,
  hi,
  ja,
  // both keys, one pack: pt-BR is the registered dialect, and a plain
  // "pt" system language should land on it rather than English
  pt: ptBr,
  "pt-br": ptBr,
  zh,
};

/** Pickable languages for the settings dropdown. Alias keys ("pt") are
 * routing, not choices, so they are not listed here. */
export const localeChoices: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "hi", label: "हिन्दी" },
  { code: "ja", label: "日本語" },
  { code: "pt-br", label: "Português (Brasil)" },
  { code: "zh", label: "中文" },
];
