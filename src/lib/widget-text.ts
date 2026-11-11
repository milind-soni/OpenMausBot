import { en, type LocaleKey } from "@/locales";
import { activeLocale, intlLocale, t } from "@/lib/i18n";
import { noticeWords } from "@/lib/activity-text";
import type { ServerTextParams } from "../../shared/server-text";
import type { WidgetNode, WidgetPayload } from "../../shared/widget";
import { readWidgetText, type WidgetMoment, type WidgetText, type WidgetTextParam } from "../../shared/widget-text";

const STYLE: Record<WidgetMoment["style"], Intl.DateTimeFormatOptions> = {
  clock: { hour: "2-digit", minute: "2-digit" },
  bareClock: { hour: "2-digit", minute: "2-digit" },
  longDate: { weekday: "long", month: "long", day: "numeric" },
  shortDate: { weekday: "short", month: "short", day: "numeric" },
};

function momentText(moment: WidgetMoment): string {
  const words = new Intl.DateTimeFormat(intlLocale(), { ...STYLE[moment.style], timeZone: moment.zone ?? "UTC" }).format(moment.at);
  return moment.style === "clock" && !moment.zone ? `${words} UTC` : words;
}

function paramText(param: WidgetTextParam): string | number {
  if (typeof param !== "object") return param;
  return "at" in param ? momentText(param) : wordsOf(param);
}

/** Only `brief.*` and `chat.notice.*` keys are taken, so a card cannot make the app show any other catalog string. Throws when the build
 * lacks a key or a param, so the caller keeps the English. */
function wordsOf(text: WidgetText): string {
  if (text.key.startsWith("chat.notice.")) {
    if (Object.values(text.params ?? {}).some((value) => typeof value === "object")) throw new Error(`notice ${text.key} takes flat params`);
    return noticeWords(text.key, text.params as ServerTextParams | undefined);
  }
  if (!text.key.startsWith("brief.") || !Object.hasOwn(en, text.key)) throw new Error(`unknown card text ${text.key}`);
  const params = Object.fromEntries(Object.entries(text.params ?? {}).map(([name, value]) => [name, paramText(value)]));
  if (text.key.startsWith("brief.inbox.") && typeof params.amountValue === "string" && Number.isFinite(Number(params.amountValue))) {
    params.amount = new Intl.NumberFormat(intlLocale()).format(Number(params.amountValue));
  }
  if (text.key.startsWith("brief.inbox.") && typeof params.deadline === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(params.deadline)) {
    const date = new Date(params.deadline);
    const day = new Date(params.deadline.slice(0, 10));
    if (Number.isFinite(date.getTime()) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === params.deadline.slice(0, 10)) {
      params.deadline = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", ...(params.deadline.length === 10 ? { timeZone: "UTC" } : {}) }).format(date);
    }
  }
  const template = t(text.key as LocaleKey);
  const unfilled = [...template.matchAll(/\{(\w+)\}/g)].some(([, name]) => !Object.hasOwn(params, name!));
  if (unfilled) throw new Error(`card text ${text.key} lacks a param`);
  return t(text.key as LocaleKey, params);
}

function localizeNode(node: WidgetNode): WidgetNode {
  const fields = readWidgetText(node.i18n);
  const next: WidgetNode = { ...node };
  for (const [field, text] of Object.entries(fields ?? {})) {
    try {
      next[field] = wordsOf(text);
    } catch {
      continue;
    }
  }
  if (node.children) next.children = node.children.map(localizeNode);
  return next;
}

/** A server-built card in the person's language; English, and every other card, as written. */
export function localizedCard(payload: WidgetPayload, serverCard: boolean, locale = activeLocale()): WidgetPayload {
  if (!serverCard || locale === "en") return payload;
  return { ...payload, root: localizeNode(payload.root) };
}
