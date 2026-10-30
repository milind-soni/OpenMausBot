// The lines the server writes for a person to read (a bot's line, a status row, a card, a notification) come from the
// app's language packs, under "server.", in the language of the person they are for (host/person-languages.ts). This
// module reads English; server-line-packs.ts adds every other language when the server starts. The packaged server
// bundles only the "server." keys (scripts/server-locale-plugin.mjs). Text only a model reads stays English and never
// comes from here. A guard beside the packs (server-lines.test.ts) fails on an English line written straight into one.
import en from "../src/locales/en.json" with { type: "json" };
import { byLanguage } from "./language.ts";

export type ServerLineKey = Extract<keyof typeof en, `server.${string}`>;
type Pack = Partial<Record<string, string>>;

const ENGLISH: Pack = en;
const packs: { en: Pack } & Record<string, Pack> = { en: ENGLISH };

/** The other languages' packs, by code ("de", "pt-br", "zh-tw"); server-line-packs.ts adds them once, at start. */
export function addServerLinePacks(more: Readonly<Record<string, Pack>>): void {
  Object.assign(packs, more, { en: ENGLISH });
}

/** The line in `language` (a language tag; undefined reads as English), with each `{name}` filled from `params`. A key
 * the language has no words for yet reads in English, as the app's own screens do. */
export function serverLine(language: string | undefined, key: ServerLineKey, params?: Readonly<Record<string, string | number>>): string {
  const template = byLanguage(packs, language)[key] ?? ENGLISH[key] ?? key;
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match)) : template;
}

/** The language a line for this person is written in: their app's, else the place's (host/person-languages.ts).
 * Undefined reads as English. */
export type LineLanguage = (person?: string) => string | undefined;
