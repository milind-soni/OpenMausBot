// The lines the server writes for a person to read (a bot's line, a status row, a card, a notification) come from the
// app's language packs, under "server.", in the language of the person they are for (host/person-languages.ts). The
// packaged server bundles only those keys (scripts/server-locale-plugin.mjs). Text only a model reads stays English and
// never comes from here. src/locales/server-lines.test.ts fails on an English line written straight into one.
import de from "../src/locales/de.json" with { type: "json" };
import en from "../src/locales/en.json" with { type: "json" };
import es from "../src/locales/es.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import hi from "../src/locales/hi.json" with { type: "json" };
import it from "../src/locales/it.json" with { type: "json" };
import ja from "../src/locales/ja.json" with { type: "json" };
import ko from "../src/locales/ko.json" with { type: "json" };
import pl from "../src/locales/pl.json" with { type: "json" };
import ptBr from "../src/locales/pt-br.json" with { type: "json" };
import ru from "../src/locales/ru.json" with { type: "json" };
import tr from "../src/locales/tr.json" with { type: "json" };
import uk from "../src/locales/uk.json" with { type: "json" };
import vi from "../src/locales/vi.json" with { type: "json" };
import zhTw from "../src/locales/zh-tw.json" with { type: "json" };
import zh from "../src/locales/zh.json" with { type: "json" };
import { byLanguage } from "./language.ts";

export type ServerLineKey = Extract<keyof typeof en, `server.${string}`>;
type Pack = Partial<Record<string, string>>;

const PACKS: { en: Pack } & Record<string, Pack> = { en, de, es, fr, hi, it, ja, ko, pl, "pt-br": ptBr, ru, tr, uk, vi, zh, "zh-tw": zhTw };
const ENGLISH: Pack = en;

/** The line in `language` (a language tag; undefined reads as English), with each `{name}` filled from `params`. A key
 * the language has no words for yet reads in English, as the app's own screens do. */
export function serverLine(language: string | undefined, key: ServerLineKey, params?: Readonly<Record<string, string | number>>): string {
  const template = byLanguage(PACKS, language)[key] ?? ENGLISH[key] ?? key;
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match)) : template;
}

/** The language a line for this person is written in: their app's, else the place's (host/person-languages.ts).
 * Undefined reads as English. */
export type LineLanguage = (person?: string) => string | undefined;
