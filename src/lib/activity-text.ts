import { en, type LocaleKey } from "@/locales";
import { activeLocale, intlLocale, t, tFromServer } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { formatServerText, isReferenceParam, type ServerTextParams } from "../../shared/server-text";

type NoticeTool = Pick<NonNullable<Message["tool"]>, "nameCode" | "nameParams">;

export function isNoticeCode(code: string | undefined): code is string {
  return code?.startsWith("chat.notice.") === true;
}


function wordedParams(params: ServerTextParams | undefined): ServerTextParams | undefined {
  if (!params) return undefined;
  const worded: ServerTextParams = {};
  for (const [name, value] of Object.entries(params)) {
    if (!isReferenceParam(name, value)) worded[name] = value;
    else if (Object.hasOwn(en, value)) worded[name] = t(value as LocaleKey);
    else throw new Error(`unknown notice part ${value}`);
  }
  if (typeof params.resetsAt === "number" && typeof params.timeZone === "string") {
    const when = new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: params.timeZone }).format(params.resetsAt);
    worded.resets = `${when} (${params.timeZone})`;
  }
  return worded;
}

/** Only `chat.notice.*` keys are taken, so a stored row cannot make the app show any other catalog string. */
export function noticeText(code: string | undefined, english: string, params?: ServerTextParams): string {
  if (!isNoticeCode(code) || activeLocale() === "en") return english;
  try {
    return noticeWords(code, params);
  } catch {
    return english;
  }
}

/** Throws when this build lacks the key, a part or a param, so the caller keeps its English. */
export function noticeWords(code: string, params?: ServerTextParams): string {
  if (!isNoticeCode(code) || !Object.hasOwn(en, code)) throw new Error(`unknown notice ${code}`);
  const worded = wordedParams(params) ?? {};
  if ([...t(code as LocaleKey).matchAll(/\{(\w+)\}/g)].some(([, name]) => !Object.hasOwn(worded, name!))) throw new Error(`notice ${code} lacks a param`);
  return t(code as LocaleKey, worded);
}

export function activityText(tool: NoticeTool, english: string): string {
  return noticeText(tool.nameCode, english, tool.nameParams);
}


const LINE_PREFIXES = ["routines.server.", "chat.notice."];

function englishParams(params: ServerTextParams | undefined): ServerTextParams {
  return Object.fromEntries(Object.entries(params ?? {}).map(([name, value]) =>
    [name, isReferenceParam(name, value) && Object.hasOwn(en, value) ? en[value as LocaleKey] : value]));
}

/** A routine's stored line (`checkTroubleCode`, a run's `outputCode`, `errorCode`, `attentionCode`) in the reader's
 * language. Only `routines.server.*` and `chat.notice.*` keys are taken, and only while the field still reads as that
 * line's English: a later line the server wrote without a code is shown as written. */
export function routineLineText(code: string | undefined, english: string, params?: ServerTextParams): string {
  if (!code || !LINE_PREFIXES.some((prefix) => code.startsWith(prefix)) || !Object.hasOwn(en, code) || activeLocale() === "en") return english;
  if (formatServerText(en[code as LocaleKey], englishParams(params)) !== english) return english;
  try {
    return tFromServer(code, english, wordedParams(params));
  } catch {
    return english;
  }
}
