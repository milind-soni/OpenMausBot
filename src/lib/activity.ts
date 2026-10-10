// Settings → Activity: the shape GET /api/admin-activity answers with
// (server/admin-activity.ts), and the pure pieces the screen renders from.
import { t } from "./i18n";
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
  /** YYYY-MM-DD, inclusive; empty means the server's default (the last 30 days). */
  from: string;
  to: string;
}

/** The query both the list and the CSV link use. Empty filters are left out. */
export function activityQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.who.trim()) params.set("who", filters.who.trim());
  if (filters.what !== "all") params.set("what", filters.what);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The server names non-people in English; show them in the reader's language. */
export function whoLabel(who: string): string {
  if (who === "This computer") return t("activity.actor.loopback");
  if (who === "Local service") return t("activity.actor.worker");
  if (who === "Command line") return t("activity.actor.cli");
  return who || "—";
}

function known(key: string): key is LocaleKey {
  return Object.hasOwn(en, key);
}

/** One line saying what happened, in the reader's language. */
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

/** A value from a row's before/after, short enough for one line. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// The activity panel's shaping: rows come from the harness newest first
// (server/activity.ts); the panel wants them under day headings with an
// outcome the eye can sort by before reading.
import type { ActivityOutcome, ActivityRow } from "../../shared/activity";

export type { ActivityOutcome, ActivityRow };

export interface ActivityDay {
  /** "Today", "Yesterday", or a short date */
  label: string;
  /** YYYY-MM-DD in local time, stable for keys */
  key: string;
  rows: ActivityRow[];
}

const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(date: Date, now: Date): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  const base = `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

/** Group newest-first rows under their local day, keeping that order. */
export function groupActivityByDay(rows: ActivityRow[], now: Date): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const row of rows) {
    const date = new Date(row.at);
    const key = localDayKey(date);
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else days.push({ key, label: dayLabel(date, now), rows: [row] });
  }
  return days;
}

export type ChipTone = "ok" | "danger" | "accent" | "warn";

/** One short word per outcome, plus the tone that colors it. */
export function outcomeChip(outcome: ActivityOutcome): { text: string; tone: ChipTone } {
  switch (outcome) {
    case "ran":
      return { text: "Ran", tone: "ok" };
    case "failed":
      return { text: "Failed", tone: "danger" };
    case "running":
      return { text: "Running", tone: "accent" };
    case "allowed":
      return { text: "Allowed", tone: "ok" };
    case "denied":
      return { text: "Denied", tone: "danger" };
    case "waiting":
      return { text: "Needs you", tone: "warn" };
  }
}

/** Short clock time for a row, local, no seconds: receipts read at a glance. */
export function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
