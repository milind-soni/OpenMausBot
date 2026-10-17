// Automations as a person reads them: one plain sentence, one status word, "last ran" and "next". Built from the
// store's schedules (routines), webhooks and runs, so the Automations page, its panel and the chat card never disagree.
import { cronScheduleLabel } from "../../shared/cron-label";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Routine, RoutineRun, RoutineSchedule } from "@/lib/routines";
import type { WebhookTrigger } from "@/lib/webhooks";
import type { AppTrigger } from "@/lib/app-triggers";
import { appProblem, appStatusParts, appWhen, skippedToday } from "@/lib/app-automations";
import type { OptionCardData } from "@/state/store";

export type AutomationKind = "schedule" | "webhook" | "app";

export interface Automation {
  kind: AutomationKind;
  id: string;
  name: string;
  botId: string;
  instructions: string;
  enabled: boolean;
  schedule?: RoutineSchedule;
  eventTypes?: string[];
  /** kind "app": what it watches, its problem and what it skipped. */
  appTrigger?: AppTrigger;
  nextRunAt: number | null;
  /** This automation's runs, newest first. */
  runs: RoutineRun[];
}

const runTime = (run: RoutineRun) => run.startedAt ?? run.scheduledFor ?? run.createdAt;
const newestFirst = (left: RoutineRun, right: RoutineRun) => runTime(right) - runTime(left);

export function automationsFrom(sources: { routines: readonly Routine[]; webhooks: readonly WebhookTrigger[]; appTriggers?: readonly AppTrigger[]; runs: readonly RoutineRun[] }): Automation[] {
  const runsOf = (id: string) => sources.runs.filter((run) => run.routineId === id).sort(newestFirst);
  return [
    ...sources.routines.map((routine): Automation => ({
      kind: "schedule", id: routine.id, name: routine.name, botId: routine.botId, instructions: routine.prompt, enabled: routine.enabled,
      schedule: routine.schedule, nextRunAt: routine.enabled ? routine.nextRunAt : null, runs: runsOf(routine.id),
    })),
    ...sources.webhooks.map((webhook): Automation => ({
      kind: "webhook", id: webhook.id, name: webhook.name, botId: webhook.botId, instructions: webhook.prompt, enabled: webhook.enabled,
      eventTypes: webhook.eventTypes, nextRunAt: null, runs: runsOf(webhook.id),
    })),
    ...(sources.appTriggers ?? []).map((trigger): Automation => ({
      kind: "app", id: trigger.id, name: trigger.name, botId: trigger.botId, instructions: trigger.prompt, enabled: trigger.enabled,
      appTrigger: trigger, nextRunAt: null, runs: runsOf(trigger.id),
    })),
  ];
}

export function automationFor(ref: { kind: AutomationKind; id: string }, sources: Parameters<typeof automationsFrom>[0]): Automation | null {
  return automationsFrom({
    routines: ref.kind === "schedule" ? sources.routines.filter((routine) => routine.id === ref.id) : [],
    webhooks: ref.kind === "webhook" ? sources.webhooks.filter((webhook) => webhook.id === ref.id) : [],
    appTriggers: ref.kind === "app" ? (sources.appTriggers ?? []).filter((trigger) => trigger.id === ref.id) : [],
    runs: sources.runs,
  })[0] ?? null;
}

/** The automation a chat card made: a create that applied on its own. Its id never changes, so the card follows it. */
export function cardAutomation(card: OptionCardData): { kind: AutomationKind; id: string } | null {
  if (!card.autoApplied || card.answered !== "allow" || card.held) return null;
  const routine = card.routineRequest;
  if (routine?.operation.action === "create" && routine.resultId) return { kind: "schedule", id: routine.resultId };
  const webhook = card.webhookRequest;
  if (webhook?.operation.action === "create" && webhook.resultId) return { kind: "webhook", id: webhook.resultId };
  const app = card.appTriggerRequest;
  if (app?.operation.action === "create" && app.resultId) return { kind: "app", id: app.resultId };
  return null;
}

// ---- Times: "today 9:02 AM", "yesterday", "Mon 9:00 AM", "next Monday 9:00 AM" ----

const DAY_MS = 24 * 60 * 60_000;
const startOfDay = (at: number) => { const day = new Date(at); day.setHours(0, 0, 0, 0); return day.getTime(); };
const locale = () => activeLocale();

/** 9 AM on the hour, 9:30 AM otherwise, in the person's language. */
export function clock(at: number, dropZeroMinutes = false): string {
  const date = new Date(at);
  return date.toLocaleTimeString(locale(), dropZeroMinutes && date.getMinutes() === 0 ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" });
}

/** When something last happened: "today 9:02 AM", "yesterday", "Mon 9:00 AM", or "Oct 3". */
export function lastWhen(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return t("automations.time.today", { time: clock(at) });
  if (days === 1) return t("automations.time.yesterday");
  if (days < 7) return `${new Date(at).toLocaleDateString(locale(), { weekday: "short" })} ${clock(at)}`;
  return new Date(at).toLocaleDateString(locale(), { month: "short", day: "numeric" });
}

/** When something happens next: "today 9:00 AM", "tomorrow 9:00 AM", "Monday 9:00 AM", or "Oct 23". */
export function nextWhen(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days <= 0) return t("automations.time.today", { time: clock(at) });
  if (days === 1) return t("automations.time.tomorrow", { time: clock(at) });
  if (days < 7) return `${new Date(at).toLocaleDateString(locale(), { weekday: "long" })} ${clock(at)}`;
  return new Date(at).toLocaleDateString(locale(), { month: "short", day: "numeric" });
}

const capital = (text: string) => text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1);

// ---- The sentence ----

const atClock = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  const day = new Date();
  day.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return clock(day.getTime(), true);
};
const dayName = (day: number, style: "long" | "short") => new Date(2026, 0, 4 + day).toLocaleDateString(locale(), { weekday: style });

/** "Every weekday at 9 AM", "Every Monday at 5 PM", "Every 30 minutes", "On Monday, October 19 at 9 AM". */
export function plainWhen(schedule: RoutineSchedule): string {
  if (schedule.type === "once") {
    return t("automations.when.once", { date: new Date(schedule.at).toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric" }), time: clock(schedule.at, true) });
  }
  if (schedule.type === "cron") {
    const label = cronScheduleLabel(schedule);
    return label.startsWith("Cron ") ? t("automations.when.custom") : label;
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMinutes;
    let when = minutes === 60 ? t("automations.when.everyHour")
      : minutes % 60 === 0 ? t("automations.when.everyHours", { count: minutes / 60 })
        : t("automations.when.everyMinutes", { count: minutes });
    if (schedule.weekdays?.join(",") === "1,2,3,4,5") when = t("automations.when.onWeekdays", { when });
    if (schedule.window) when = t("automations.when.between", { when, start: atClock(schedule.window.start), end: atClock(schedule.window.end) });
    return when;
  }
  const time = atClock(schedule.time);
  const days = schedule.weekdays;
  if (days.length === 7) return t("automations.when.everyDay", { time });
  if (days.join(",") === "1,2,3,4,5") return t("automations.when.everyWeekday", { time });
  const names = days.map((day) => dayName(day, days.length === 1 ? "long" : "short"));
  return t("automations.when.everyDays", { days: new Intl.ListFormat(locale(), { type: "conjunction" }).format(names), time });
}

const IRREGULAR: Record<string, string> = { have: "has", do: "does", go: "goes", be: "is" };
const NOT_A_VERB = new Set(["if", "when", "whenever", "every", "each", "please", "the", "a", "an", "you", "i", "we", "my", "our", "your", "this", "that", "on", "at", "for", "after", "before"]);
const PHRASE_CHARS = 60;
const COMMON_VERBS = "add|archive|book|check|create|draft|email|file|flag|forward|label|list|message|move|notify|open|ping|post|reply|report|review|save|schedule|send|share|summarize|tell|update|write";

function thirdPerson(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower]!;
  if (/(s|sh|ch|x|z|o)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/** What the bot does, as a short phrase: the first clause of its instructions, addressed to the person. */
/** Words a bot may leave at the end of its instructions that a person never says: "…a reply to the email in the event data". */
const TECHNICAL_TAIL = /\s+(?:in|from|of|inside)\s+(?:the\s+)?(?:(?:incoming|webhook|trigger|app)\s+)?(?:event(?:'s)?(?:\s+(?:data|payload|body))?|payload|webhook(?:\s+(?:data|body|payload|call))?|trigger(?:\s+(?:data|payload))?)$/i;

export function doesPhrase(instructions: string, english = activeLocale().startsWith("en")): string {
  let clause = instructions.replace(/^\s*please\s+/i, "").split(/[.:;!?\n]|\s[—–-]\s/)[0]?.trim().replace(TECHNICAL_TAIL, "") ?? "";
  if (!clause) return t("automations.does.default");
  if (english) {
    clause = clause.replace(/\bme\b/gi, "you").replace(/\bmy\b/gi, "your").replace(/\bmine\b/gi, "yours").replace(/\bI\b/g, "you");
    const [first = "", ...rest] = clause.split(/\s+/);
    clause = /^[A-Za-z]+$/.test(first) && !NOT_A_VERB.has(first.toLowerCase())
      // "Summarize the inbox and post the top three" → "summarizes the inbox and posts the top three".
      ? [thirdPerson(first), ...rest].join(" ").replace(new RegExp(`\\b(and|then) (${COMMON_VERBS})\\b`, "g"), (_match, joiner: string, verb: string) => `${joiner} ${thirdPerson(verb)}`)
      : clause.charAt(0).toLowerCase() + clause.slice(1);
  } else {
    clause = clause.charAt(0).toLocaleLowerCase(locale()) + clause.slice(1);
  }
  if (clause.length <= PHRASE_CHARS) return clause;
  const cut = clause.slice(0, PHRASE_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : PHRASE_CHARS).trimEnd()}…`;
}

const GENERIC = new Set(["lead", "leads", "trigger", "triggers", "webhook", "webhooks", "hook", "hooks", "event", "events", "call", "calls", "request", "requests", "message", "messages", "notification", "notifications", "update", "updates"]);

const SOURCE_WORD = /\b(form|forms|app|site|website|store|shop|crm|inbox|sheet|zapier|typeform|tally|jotform|stripe|github|gitlab|shopify|hubspot|salesforce|slack|gmail|calendar|notion|airtable|webflow|wordpress|n8n|ifttt|make)\b/i;

/** Who sends: "your sales form" from a name like "Sales form leads", or "another app". */
export function sourcePhrase(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  while (words.length && GENERIC.has(words.at(-1)!.toLowerCase())) words.pop();
  while (words.length && GENERIC.has(words[0]!.toLowerCase())) words.shift();
  // Only a name that says where things come from ("sales form", "Shopify") reads well after "your".
  if (!words.length || words.length > 4 || words.some((word) => /\d/.test(word)) || !SOURCE_WORD.test(words.join(" "))) return t("automations.source.other");
  if (words.length > 1 && /^[A-Z][a-z]+$/.test(words[0]!)) words[0] = words[0]!.toLowerCase();
  return t("automations.source.named", { name: words.join(" ") });
}

/** "Every weekday at 9 AM, Scout sends you a summary of your inbox"; "When your sales form sends something, Scout drafts…". */
export function automationSentence(automation: Pick<Automation, "kind" | "name" | "instructions" | "schedule" | "appTrigger">, botName: string): string {
  const does = doesPhrase(automation.instructions);
  if (automation.kind === "app" && automation.appTrigger) return t("automations.sentence.appEvent", { when: appWhen(automation.appTrigger), bot: botName, does });
  if (automation.kind === "schedule" && automation.schedule) {
    return t("automations.sentence.schedule", { when: plainWhen(automation.schedule), bot: botName, does });
  }
  return t("automations.sentence.app", { source: sourcePhrase(automation.name), bot: botName, does });
}

// ---- Status: Working / Paused / Needs you ----

export type AutomationFix = "answer" | "sign-in" | "usage" | "edit" | "run" | "reconnect";
export interface AutomationStatus {
  state: "working" | "paused" | "needs-you";
  /** Needs you: one plain sentence, and the one button that fixes it. */
  reason?: string;
  fix?: AutomationFix;
}

const isProblem = (run: RoutineRun) => run.status === "failed" || run.status === "missed";
const SIGNED_OUT = /sign(ed)?[ -]?(in|out)\b|log(ged)?[ -]?(in|out)\b|unauthori[sz]ed|\b401\b|not authenticated|authentication (failed|required)|(token|session|credential)s? (has |have )?expired|expired (token|session|credential)|invalid api key|reconnect/i;
const OUT_OF_CREDIT = /credit|quota|billing|payment|insufficient|out of tokens|usage limit|rate.?limit|\b429\b|limit (reached|exceeded)|plan limit/i;
const OUT_OF_TIME = /run limit|time limit|timed out|minute limit/i;

function ownerFix(run: RoutineRun): { reason: string; fix: AutomationFix } | null {
  const error = `${run.error ?? ""} ${run.goalStatus === "limit-reached" ? "run limit" : ""}`;
  if (SIGNED_OUT.test(error)) return { reason: t("automations.reason.signIn"), fix: "sign-in" };
  if (OUT_OF_TIME.test(error)) return { reason: t("automations.reason.timeLimit"), fix: "edit" };
  if (OUT_OF_CREDIT.test(error)) return { reason: t("automations.reason.usage"), fix: "usage" };
  return null;
}

/** Paused when switched off. Needs you when its last run waits on the person, failed for a reason only the person can
 * fix, or failed twice running. A run that failed and then recovered is Working. */
export function automationStatus(automation: Pick<Automation, "enabled" | "runs" | "appTrigger">): AutomationStatus {
  if (!automation.enabled) return { state: "paused" };
  const app = automation.appTrigger && appProblem(automation.appTrigger);
  if (app) return { state: "needs-you", ...app };
  const settled = automation.runs.filter((run) => run.status !== "cancelled" && run.status !== "queued");
  const latest = settled[0];
  if (latest?.status === "waiting") return { state: "needs-you", reason: t("automations.reason.answer"), fix: "answer" };
  if (latest && isProblem(latest)) {
    const owner = ownerFix(latest);
    if (owner) return { state: "needs-you", ...owner };
    let streak = 0;
    for (const run of settled) { if (!isProblem(run)) break; streak += 1; }
    if (streak >= 2) return { state: "needs-you", reason: t("automations.reason.repeated", { count: streak }), fix: "run" };
  }
  return { state: "working" };
}

const RANK = { "needs-you": 0, working: 1, paused: 2 } as const;

/** Needs you first, then Working, then Paused; within each, the soonest next run, then by name. */
export function orderAutomations<T extends Automation>(automations: readonly T[]): T[] {
  return automations
    .map((automation) => ({ automation, rank: RANK[automationStatus(automation).state] }))
    .sort((left, right) => left.rank - right.rank
      || (left.automation.nextRunAt ?? Infinity) - (right.automation.nextRunAt ?? Infinity)
      || left.automation.name.localeCompare(right.automation.name))
    .map(({ automation }) => automation);
}

/** The grey line under a sentence: "Working · last ran today 9:02 AM · next Monday 9:00 AM". */
export function statusLine(automation: Automation, now = Date.now()): string {
  const status = automationStatus(automation);
  const latest = automation.runs.find((run) => run.status !== "queued");
  const parts = [t(status.state === "paused" ? "automations.status.paused" : status.state === "needs-you" ? "automations.status.needsYou" : "automations.status.working")];
  if (latest?.status === "running") parts.push(t("automations.runningNow"));
  else if (latest) parts.push(`${t("automations.lastRan", { when: lastWhen(runTime(latest), now) })}${isProblem(latest) ? " ✗" : ""}`);
  else if (!automation.appTrigger) parts.push(t("automations.notRunYet"));
  if (automation.appTrigger) parts.push(...appStatusParts(automation.appTrigger, Boolean(latest)), ...[skippedToday(automation.appTrigger, now) ?? []].flat());
  if (automation.nextRunAt != null) parts.push(t("automations.next", { when: nextWhen(automation.nextRunAt, now) }));
  return parts.join(" · ");
}

/** One recent run in plain words: "Today 9:02 AM", a mark, and its one-line result or reason. */
export function runLine(run: RoutineRun, now = Date.now()): { when: string; mark: "✓" | "✗" | "…" | "!"; text: string } {
  const firstLine = (text: string | undefined) => (text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const short = (text: string) => (text.length > 110 ? `${text.slice(0, 109).trimEnd()}…` : text);
  const when = capital(lastWhen(runTime(run), now));
  if (run.status === "completed") return { when, mark: "✓", text: short(firstLine(run.output)) || t("automations.run.done") };
  if (run.status === "waiting") return { when, mark: "!", text: t("automations.reason.answer") };
  if (run.status === "running" || run.status === "queued") return { when, mark: "…", text: t("automations.runningNow") };
  if (run.status === "cancelled") return { when, mark: "✗", text: t("automations.run.stopped") };
  return { when, mark: "✗", text: ownerFix(run)?.reason ?? (short(firstLine(run.error)) || t("automations.run.failed")) };
}

export const AUTOMATION_FIX_LABEL: Record<AutomationFix, LocaleKey> = {
  answer: "automations.fix.answer",
  "sign-in": "automations.fix.signIn",
  usage: "automations.fix.usage",
  edit: "automations.fix.edit",
  run: "automations.fix.run",
  reconnect: "automations.fix.reconnect",
};
