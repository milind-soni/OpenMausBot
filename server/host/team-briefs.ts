// A Team Cloud's briefs: each member whose Chief of Staff they own gets one server card a day in their own private chat
// with that Chief, edited in place. It lists only what is routed to them: the questions and approvals
// waiting on them, the runs that failed or were missed, and the results of routines that report to them. Nobody
// else's private chat ever reaches it. With no Chief there is no brief, and the same asks wait in their Needs you.
// The state is ids and times only, in team-briefs.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { botOwner } from "../../shared/bot-owner.ts";
import type { NeedsYouItem } from "../../shared/today.ts";
import { writeFileAtomic } from "../atomic.ts";
import { createAgentCard } from "../chat-widgets.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";
import { localDate } from "./check-plan.ts";
import { briefCard, type BriefRow, type BuiltCard, type NeedRow } from "./brief-cards.ts";
import { briefWords, type BriefWords } from "./brief-words.ts";
import { clip, oneLine } from "./text-clip.ts";

export const TEAM_BRIEFS_FILE = "team-briefs.json";
export const TEAM_BRIEF_TITLE = "Brief";
const MAX_PEOPLE = 500;
const SETTLE_MS = 2_000;

const id = z.string().min(1).max(512);
const cardSchema = z.object({ day: z.string().max(10), botId: id, threadId: id, messageId: id });
const fileSchema = z.object({
  version: z.literal(1),
  people: z.record(z.string().regex(/^p_[\w-]{22}$/u), z.object({
    card: cardSchema.optional(), notified: z.array(z.string().max(600)).max(200), openedOn: z.string().max(10).optional(),
    /** The language the member's app shows, from their last arrival. */
    language: z.string().max(35).optional(),
  })),
});
type PersonState = z.infer<typeof fileSchema>["people"][string];

export interface TeamBriefDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "messagesFor" | "appendMessage" | "patchMessage" | "patchTask" | "createTask" | "groupByThread" | "activePath">;
  dataDir: string;
  now?: () => number;
  timeZone?(): string | undefined;
  /** The team's language, for a member whose app has not said which it shows. */
  language?(): string | undefined;
  personKeyOf(email: string): string;
  /** What waits on this person now, routed to them alone. */
  needsYou(person: string): NeedsYouItem[];
  runs(): RoutineRun[];
  /** The person an ask (or a run's result) in this conversation is for; null: the Admins. */
  askedPerson(botId: string, threadId: string): string | null;
  startedBy(threadId: string): string | undefined;
  open(threadId: string, person: string): void;
  threadBusy(botId: string, threadId: string): boolean;
  notify(bot: BotRecord, threadId: string, detail: string): void;
}

export function createTeamBriefs(deps: TeamBriefDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, TEAM_BRIEFS_FILE);
  let people: Record<string, PersonState> = {};
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) people = parsed.data.people;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`team briefs: ${file} is unreadable; starting fresh`);
  }
  const save = () => {
    const kept = Object.fromEntries(Object.entries(people).slice(-MAX_PEOPLE));
    try { writeFileAtomic(file, `${JSON.stringify({ version: 1, people: kept })}\n`, { mode: 0o600 }); } catch (error) {
      console.warn(`team briefs: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const today = () => localDate(now(), deps.timeZone?.());
  const dayStart = () => {
    const day = today();
    let start = now();
    while (localDate(start - 60_000, deps.timeZone?.()) === day) start -= 60_000;
    return start;
  };

  /** The person's own Chief: the visible Chief of Staff they own. */
  function chiefOf(person: string): BotRecord | null {
    return deps.store.bots.find((bot) => {
      const owner = bot.chiefOfStaff && !bot.hidden ? botOwner(bot) : null;
      return owner !== null && deps.personKeyOf(owner) === person;
    }) ?? null;
  }

  /** The person's private chat with their Chief that holds the brief: the one it used, else a new one. */
  function home(chief: BotRecord, person: string, state: PersonState | undefined): string | undefined {
    const kept = state?.card?.botId === chief.id ? deps.store.taskByThread(chief.id, state.card.threadId) : undefined;
    if (kept && !kept.archivedAt) return kept.threadId;
    const own = deps.store.tasks(chief.id).find((task) => task.title === TEAM_BRIEF_TITLE && !task.archivedAt && !task.routineRunId && deps.startedBy(task.threadId) === person);
    if (own) return own.threadId;
    const created = deps.store.createTask(chief.id, TEAM_BRIEF_TITLE, false);
    if (!created) return undefined;
    deps.open(created.threadId, person);
    return created.threadId;
  }

  function rows(person: string, w: BriefWords): { needs: NeedRow[]; done: BriefRow[] } {
    const opens = (botId: string, threadId: string | undefined) => threadId && deps.store.taskByThread(botId, threadId) ? { open: { botId, threadId } } : {};
    const needs: NeedRow[] = deps.needsYou(person).flatMap((item): NeedRow[] => {
      if (item.kind !== "question") return [];
      const bot = deps.store.bot(item.botId)?.name, note = clip(item.text, 140);
      return [{ key: `question:${bot ?? ""}:${note}`, text: w.isAsking(bot ?? w.aBot), note, ...opens(item.botId, item.threadId) }];
    });
    const done: BriefRow[] = [];
    const since = dayStart();
    const latest = new Map<string, RoutineRun>();
    for (const run of deps.runs()) {
      const end = run.finishedAt ?? run.createdAt;
      if (end < since || !["completed", "failed", "missed"].includes(run.status) || run.report?.state === "quiet") continue;
      const threadId = run.resultsThreadId ?? run.threadId;
      if (!threadId || deps.askedPerson(run.botId, threadId) !== person) continue;
      const seen = latest.get(run.routineId);
      if (!seen || (seen.finishedAt ?? seen.createdAt) <= end) latest.set(run.routineId, run);
    }
    for (const run of latest.values()) {
      const bot = deps.store.bot(run.botId);
      if (!bot || bot.hidden) continue;
      const open = opens(run.botId, run.resultsThreadId ?? run.threadId);
      const name = oneLine(run.routineName, 80);
      if (run.status === "completed") done.push({ text: name, note: clip(oneLine(run.output ?? "", 140) || w.finished, 140), ...open });
      else {
        const error = clip(oneLine(run.error ?? "", 140), 140);
        needs.push({ key: `routine:${name}:${run.status}:${error}`, text: run.status === "missed" ? w.missed(name) : w.failed(name), note: error || w.didNotFinish, ...open });
      }
    }
    return { needs, done };
  }

  const writes = (bot: BotRecord, threadId: string, input: Parameters<typeof createAgentCard>[0]["input"]) =>
    createAgentCard({ store: deps.store as Parameters<typeof createAgentCard>[0]["store"], bot, threadId, input, serverCard: true });

  /** Posts the person's brief for today, or edits it in place; null when they have no Chief or nothing to show. */
  function render(person: string, options: { create: boolean }): { botId: string; threadId: string } | null {
    const chief = chiefOf(person);
    if (!chief) return null;
    const state = people[person];
    const day = today();
    const current = state?.card && state.card.day === day && state.card.botId === chief.id &&
      deps.store.messagesFor(state.card.threadId).some((row) => row.id === state.card!.messageId && row.serverCard) ? state.card : undefined;
    const language = state?.language ?? deps.language?.();
    const { needs, done } = rows(person, briefWords(language));
    if (!current && (needs.length === 0 && (!options.create || done.length === 0))) return null;
    const threadId = current?.threadId ?? home(chief, person, state);
    if (!threadId) return null;
    if (deps.threadBusy(chief.id, threadId)) {
      pending.add(person);
      return null;
    }
    const built: BuiltCard = briefCard({ now: now(), ...(deps.timeZone?.() ? { timeZone: deps.timeZone()! } : {}), ...(language ? { language } : {}), intro: false, needs, meetings: null, emails: [], routines: done });
    const written = current
      ? writes(chief, threadId, { tool: "update_widget", widget_id: current.messageId, widget: built.card })
      : writes(chief, threadId, { tool: "show_widget", widget: built.card });
    if (!written.ok) {
      console.warn(`team briefs: the card was refused: ${written.error}`);
      return null;
    }
    if (!current) deps.store.patchTask(chief.id, threadId, { unread: true });
    const seen = new Set(state?.notified ?? []);
    const fresh = needs.map((row) => `need:${row.key}`).filter((key) => !seen.has(key));
    if (fresh.length) deps.notify(chief, threadId, built.summary);
    people[person] = { ...state, card: { day, botId: chief.id, threadId, messageId: current?.messageId ?? written.messageId }, notified: [...seen, ...fresh].slice(-200) };
    save();
    return { botId: chief.id, threadId };
  }

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const due = [...pending];
    pending.clear();
    for (const person of due) {
      try { render(person, { create: false }); } catch (error) {
        console.warn(`team briefs: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  return {
    chiefOf,
    render,
    /** Something routed to this person changed: their brief catches up shortly, once, however many changes land. */
    soon(person: string | null): void {
      if (!person || !chiefOf(person)) return;
      pending.add(person);
      timer ??= setTimeout(flush, SETTLE_MS);
      timer.unref?.();
    },
    /** The person opened the app: today's brief catches up in the language their app shows, and opens on their first arrival of the day. */
    active(person: string | null, language?: string): { returned: boolean; open?: { botId: string; threadId: string } } {
      if (!person) return { returned: false };
      if (language && language !== people[person]?.language) {
        people[person] = { ...(people[person] ?? { notified: [] }), language };
        save();
      }
      const shown = render(person, { create: true });
      const day = today();
      if (!shown || people[person]?.openedOn === day) return { returned: false };
      people[person] = { ...people[person]!, openedOn: day };
      save();
      return { returned: false, open: { botId: shown.botId, threadId: shown.threadId } };
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type TeamBriefs = ReturnType<typeof createTeamBriefs>;
