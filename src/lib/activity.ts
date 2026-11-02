import { activeLocale, t } from "./i18n";
import { en, type LocaleKey } from "@/locales";

export const ACTIVITY_WHATS = ["all", "approvals", "decisions", "config", "people", "session", "webhook", "mcp", "engine", "bot", "budget", "visibility"] as const;
export type ActivityWhat = typeof ACTIVITY_WHATS[number];

export type ActivityEntry =
  | {
      type: "approval";
      at: string;
      who: string;
      what: string;
      source: string;
      bot?: string;
      tool?: string;
      summary?: string;
      threadId: string;
      requestId?: string;
    }
  | {
      type: "admin";
      at: string;
      who: string;
      what: string;
      action: string;
      target?: { kind: string; id?: string; name?: string };
      changed?: string[];
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };

export interface ActivityFilters {
  who: string;
  what: ActivityWhat;
  from: string;
  to: string;
}

export function activityQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.who.trim()) params.set("who", filters.who.trim());
  if (filters.what !== "all") params.set("what", filters.what);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function whoLabel(who: string): string {
  if (who === "This computer") return t("activity.actor.loopback");
  if (who === "Local service") return t("activity.actor.worker");
  if (who === "Command line") return t("activity.actor.cli");
  return who || "—";
}

function known(key: string): key is LocaleKey {
  return Object.hasOwn(en, key);
}

export function describeEntry(entry: ActivityEntry): string {
  if (entry.type === "approval") {
    const decisionKey = `activity.decision.${entry.what}`;
    const decision = known(decisionKey) ? t(decisionKey) : entry.what;
    const line = entry.tool ? t("activity.approvalLine", { decision, tool: entry.tool }) : decision;
    return entry.bot ? `${line} ${t("activity.approvalIn", { bot: entry.bot })}` : line;
  }
  const actionKey = `activity.action.${entry.action}`;
  const action = known(actionKey) ? t(actionKey) : entry.action;
  const target = entry.target?.name ?? entry.target?.id;
  return target ? `${action}: ${target}` : action;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

import type { ActivityOutcome, ActivityRow } from "../../shared/activity";

export type { ActivityOutcome, ActivityRow };

export interface ActivityDay {
  label: string;
  key: string;
  rows: ActivityRow[];
}

const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(date: Date, now: Date, locale: string): string {
  if (!Number.isFinite(date.getTime())) return "—";
  const key = localDayKey(date);
  if (key === localDayKey(now)) return t("chat.day.today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDayKey(yesterday)) return t("chat.day.yesterday");
  if (!locale.startsWith("en")) return new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "numeric", month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
  const base = `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

export function groupActivityByDay(rows: ActivityRow[], now: Date, locale = activeLocale()): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const row of rows) {
    const date = new Date(row.at);
    const key = localDayKey(date);
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else days.push({ key, label: dayLabel(date, now, locale), rows: [row] });
  }
  return days;
}

export type ChipTone = "ok" | "danger" | "accent" | "warn";

export function outcomeChip(outcome: ActivityOutcome): { text: string; tone: ChipTone } {
  switch (outcome) {
    case "ran":
      return { text: t("ui.dynamic.activity.ran"), tone: "ok" };
    case "failed":
      return { text: t("ui.dynamic.activity.failed"), tone: "danger" };
    case "running":
      return { text: t("ui.dynamic.activity.running"), tone: "accent" };
    case "allowed":
      return { text: t("ui.dynamic.activity.allowed"), tone: "ok" };
    case "denied":
      return { text: t("ui.dynamic.activity.denied"), tone: "danger" };
    case "waiting":
      return { text: t("ui.dynamic.activity.waiting"), tone: "warn" };
  }
}

export function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
