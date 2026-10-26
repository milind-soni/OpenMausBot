import en from "./en.json";
import de from "./de.json";
import es from "./es.json";
import fr from "./fr.json";
import hi from "./hi.json";
import ja from "./ja.json";
import ptBr from "./pt-br.json";
import zh from "./zh.json";
import zhTw from "./zh-tw.json";
import uk from "./uk.json";
import vi from "./vi.json";
import tr from "./tr.json";
import pl from "./pl.json";

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
  pt: ptBr,
  "pt-br": ptBr,
  zh,
  "zh-hant": zhTw,
  "zh-hk": zhTw,
  "zh-mo": zhTw,
  "zh-tw": zhTw,
  uk,
  vi,
  tr,
  pl,
};

export const localeChoices: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "hi", label: "हिन्दी" },
  { code: "ja", label: "日本語" },
  { code: "pt-br", label: "Português (Brasil)" },
  { code: "zh", label: "简体中文" },
  { code: "zh-tw", label: "繁體中文（台灣）" },
  { code: "uk", label: "Українська" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "tr", label: "Türkçe" },
  { code: "pl", label: "Polski" },
];
