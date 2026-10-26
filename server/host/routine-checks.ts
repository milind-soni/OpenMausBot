// A routine's checks: plain code that reads Calendar and Gmail and other routines' runs on each tick, with no AI. What
// needs no judgement goes to the brief straight away; what needs judgement goes to one run, and the cursors move only
// once that run's answer is kept. State is ids and times only, one entry per routine, in routine-checks.json.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { SourceError, type CalendarEvent, type ConnectedReads, type EmailHeader, type ReadApp, type ReadSession } from "../connected-reads.ts";
import type { Routine, RoutineCheckResult, RoutineChecks, RoutineRun } from "../routines.ts";
import type { CheckHold } from "../routine-check-pacing.ts";
import {
  clashes, emailSince, fingerprint, keepNewest, LOOKAHEAD_MS, mergeMeetings, nextMeetingDue, planMail, planMeetings, pruneMeetings, type MeetingRecord,
} from "./check-plan.ts";
import { checkedPrompt, watchPrompt, type CheckItems } from "./check-prompts.ts";
import type { InboxTriage } from "./inbox-triage.ts";

const MINUTE = 60_000;
const CHECK_MS = 15 * MINUTE;
const MAX_JUDGED = 1_000;
const MAIL_READ_LIMIT = 100;
/** A run that took items and was never heard of again gives them back after this long. */
const PENDING_MS = 3 * 60 * MINUTE;
/** A read that keeps failing is tried again after 15 minutes doubled each time, at most 2 hours. */
const READ_RETRY_MS = 15 * MINUTE;
const READ_RETRY_MAX_MS = 2 * 60 * MINUTE;
export const CHECKS_FILE = "routine-checks.json";

const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(512);
const pendingSchema = z.object({
  at,
  mailCursor: at.optional(), mail: z.array(id).max(200), prep: z.array(id).max(50), runsCursor: at.optional(),
  /** The threads a draft may answer, each to its own sender: the run's emails, nothing else. */
  replies: z.array(z.object({ threadId: id, to: z.string().max(320) })).max(200),
  drafted: z.array(id).max(200).optional(),
});
const failureSchema = z.object({ since: at, count: z.number().int().min(1), signedOut: z.boolean().optional(), lastAt: at });
const routineStateSchema = z.object({
  mailCursor: at.optional(),
  judged: z.array(id).max(MAX_JUDGED).optional(),
  meetings: z.record(id, z.object({ start: at, fingerprint: z.string().max(64), prepStartedAt: at.optional(), preppedAt: at.optional(), remindedAt: at.optional() })).optional(),
  runsCursor: at.optional(),
  address: z.string().max(320).optional(),
  pending: z.record(id, pendingSchema).optional(),
  failures: z.object({ gmail: failureSchema.optional(), googlecalendar: failureSchema.optional() }).optional(),
});
const fileSchema = z.object({ version: z.literal(1), routines: z.record(id, routineStateSchema) });
type RoutineState = z.infer<typeof routineStateSchema>;
type Pending = z.infer<typeof pendingSchema>;

/** What a check found that needs no AI, for a routine that delivers to the brief. */
export interface CheckReport {
  routine: Routine;
  at: number;
  /** The person's meetings in the next 36 hours, each once; undefined when Calendar was not read. */
  meetings?: CalendarEvent[];
  clashes?: Array<[CalendarEvent, CalendarEvent]>;
  /** Meetings starting within 10 minutes, each reported once. */
  remind?: CalendarEvent[];
  /** Other routines' runs that finished since the last check. */
  runs?: RoutineRun[];
  /** Apps that could not be read, and whether reconnecting fixes it. */
  trouble?: Array<{ app: ReadApp; signedOut: boolean }>;
  /** New emails that wait for a later run, or true when there were more than one check reads. */
  waiting?: number | true;
  /** Mail and meetings that need an AI this bot's engine cannot fence, so they were not sorted. */
  unfenced?: boolean;
  /** The helper models sort the mail here, whatever the engine: only meeting prep needs a fenced AI. */
  helpersSort?: boolean;
  /** Whether Gmail is connected, and the person's address once read: the add-a-key suggestion's cue. */
  gmail?: { connected: boolean; address?: string };
  /** Emails the helper models picked for the brief, with a why built in plain code. */
  picked?: Array<{ email: EmailHeader; why: string; needsReply: boolean }>;
  /** The reads of this check, for the brief's own follow-ups (a reply already sent). */
  session?: ReadSession;
}

export interface RoutineChecksDeps {
  dataDir: string;
  reads: ConnectedReads;
  now?: () => number;
  /** Connected apps are on for this bot and its app switches let it read this app. */
  mayRead(botId: string, app: ReadApp): boolean;
  /** The bot's AI refuses every tool outside a run's allowlist, so a read-and-draft run is safe on it. */
  fenced(botId: string): boolean;
  timeZone(): string | undefined;
  /** Every routine's runs, newest last. */
  runs(): RoutineRun[];
  /** The person's recent dismissals of mail from these senders, newest first. */
  dismissedFrom(): string[];
  report(report: CheckReport): void | Promise<void>;
  /** The helper models' inbox triage (server/host/inbox-triage.ts); absent or not ready means an AI run sorts mail. */
  inbox?: Pick<InboxTriage, "ready" | "triage">;
}

const ACTIVE = new Set(["queued", "running", "waiting"]);
const appName: Record<ReadApp, string> = { gmail: "Gmail", googlecalendar: "Google Calendar" };
const addressOf = (from: string): string => (/<([^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

export function troubleSentence(trouble: ReadonlyArray<{ app: ReadApp; signedOut: boolean }>): string | undefined {
  if (!trouble.length) return undefined;
  const names = trouble.map((one) => appName[one.app]).join(" or ");
  return trouble.some((one) => one.signedOut) ? `Couldn't read ${names}. Reconnect it in Connected apps.` : `Couldn't read ${names}. I'll try again soon.`;
}

export function createRoutineChecks(deps: RoutineChecksDeps): RoutineChecks & {
  /** Keeps a run's items: its answer was read, so every email and meeting it was given is settled, sorted or prepared
   * or not, and none is handed out again. */
  commit(key: string): void;
  /** The run with this key may write a draft answering this thread, to this address, once. */
  mayDraft(key: string, threadId: string, to: string | undefined): boolean;
  drafted(key: string, threadId: string): void;
  /** The emails and meetings a run was handed, while it holds them. */
  items(key: string): { mail: EmailHeader[]; prep: Array<{ key: string; event: CalendarEvent }> } | null;
  pendingKeys(): string[];
  forget(routineId: string): void;
  /** The person's own Gmail address, once a check has read it. */
  address(): string | undefined;
} {
  const file = join(deps.dataDir, CHECKS_FILE);
  const now = deps.now ?? Date.now;
  let state: z.infer<typeof fileSchema> = { version: 1, routines: {} };
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`checks: ${file} is not a checks file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`checks: ${file} is unreadable; starting fresh`);
  }
  /** The headers and events a pending run was handed, while this process holds them: the state keeps only their ids. */
  const handed = new Map<string, { mail: EmailHeader[]; prep: Array<{ key: string; event: CalendarEvent }> }>();

  const save = (): void => {
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`checks: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const of = (routineId: string): RoutineState => (state.routines[routineId] ??= {});
  const ownerOf = (key: string): [string, Pending] | null => {
    for (const [routineId, entry] of Object.entries(state.routines)) {
      const pending = entry.pending?.[key];
      if (pending) return [routineId, pending];
    }
    return null;
  };

  function release(key: string): void {
    const owner = ownerOf(key);
    handed.delete(key);
    if (!owner) return;
    const entry = of(owner[0]);
    for (const meeting of owner[1].prep) if (entry.meetings?.[meeting]) delete entry.meetings[meeting]!.prepStartedAt;
    delete entry.pending![key];
    save();
  }

  function commit(key: string): void {
    const owner = ownerOf(key);
    handed.delete(key);
    if (!owner) return;
    const [routineId, pending] = owner;
    const entry = of(routineId);
    if (pending.mailCursor !== undefined) entry.mailCursor = Math.max(entry.mailCursor ?? 0, pending.mailCursor);
    if (pending.runsCursor !== undefined) entry.runsCursor = Math.max(entry.runsCursor ?? 0, pending.runsCursor);
    entry.judged = keepNewest([...new Set([...(entry.judged ?? []), ...pending.mail])], MAX_JUDGED);
    for (const meeting of pending.prep) {
      const record = entry.meetings?.[meeting];
      if (!record) continue;
      delete record.prepStartedAt;
      record.preppedAt = now();
    }
    delete entry.pending![key];
    save();
  }

  /** A read that failed counts toward its app's failure streak, so the brief says so once and reads back off. */
  function failed(entry: RoutineState, app: ReadApp, error: unknown): { app: ReadApp; signedOut: boolean } {
    const signedOut = error instanceof SourceError && error.signedOut;
    const previous = entry.failures?.[app];
    entry.failures = { ...entry.failures, [app]: { since: previous?.since ?? now(), count: (previous?.count ?? 0) + 1, lastAt: now(), ...(signedOut ? { signedOut } : {}) } };
    console.warn(`checks: could not read ${appName[app]}: ${error instanceof Error ? error.message : String(error)}`);
    return { app, signedOut };
  }
  const readsBackOff = (entry: RoutineState, app: ReadApp): boolean => {
    const failure = entry.failures?.[app];
    return failure !== undefined && now() < failure.lastAt + Math.min(READ_RETRY_MAX_MS, READ_RETRY_MS * 2 ** (failure.count - 1));
  };
  const succeeded = (entry: RoutineState, app: ReadApp): void => {
    if (entry.failures?.[app]) delete entry.failures[app];
  };

  async function check(routine: Routine, context: { manual: boolean; hold?: CheckHold }): Promise<RoutineCheckResult> {
    const checks = routine.checks ?? [];
    const entry = of(routine.id);
    const at = now();
    for (const [key, pending] of Object.entries(entry.pending ?? {})) {
      const run = deps.runs().find((candidate) => candidate.checkKey === key);
      if ((run && !ACTIVE.has(run.status)) || (!run && at - pending.at > PENDING_MS)) release(key);
    }
    // The first check fixes where mail is watched from, so mail a failed read or run gave back is read again.
    if (checks.includes("mail")) entry.mailCursor ??= emailSince({ now: at });
    const brief = routine.deliver === "brief";
    const aiAllowed = !context.hold && (routine.access !== "read-and-draft" || deps.fenced(routine.botId));
    const report: CheckReport = { routine, at };
    const trouble: Array<{ app: ReadApp; signedOut: boolean }> = [];
    const items: CheckItems = { mail: [], prep: [], runs: [] };
    const pending: Omit<Pending, "at"> = { mail: [], prep: [], replies: [] };
    const held = new Set(Object.values(entry.pending ?? {}).flatMap((one) => [...one.mail, ...one.prep]));
    let wakeAt: number | undefined;
    const apps = checks.includes("calendar") || checks.includes("mail") ? await deps.reads.connected().catch(() => null) : null;
    const session = deps.reads.session();
    report.session = session;
    const readable = (app: ReadApp): boolean => apps?.[app] === true && deps.mayRead(routine.botId, app) && !trouble.some((one) => one.app === app) &&
      (context.manual || !readsBackOff(entry, app));
    if (readable("gmail") && entry.address === undefined) {
      try { entry.address = await session.address(); } catch (error) { trouble.push(failed(entry, "gmail", error)); }
    }

    if (checks.includes("calendar") && readable("googlecalendar")) {
      try {
        const meetings = mergeMeetings(await session.events(at - 60 * MINUTE, at + LOOKAHEAD_MS), entry.address);
        succeeded(entry, "googlecalendar");
        entry.meetings = pruneMeetings(entry.meetings ?? {}, at);
        const records = entry.meetings;
        const jobs = planMeetings({ now: at, events: meetings, meetings: records, checkMs: CHECK_MS });
        const record = (event: CalendarEvent): MeetingRecord => (records[event.id] ??= { start: event.start, fingerprint: "" });
        for (const job of jobs) {
          const kept = record(job.event);
          if (kept.start !== job.event.start) Object.assign(kept, { start: job.event.start, preppedAt: undefined, remindedAt: undefined });
        }
        if (brief) {
          report.meetings = meetings;
          report.clashes = clashes(meetings, { now: at, timeZone: deps.timeZone() });
          report.remind = jobs.filter((job) => job.kind === "remind").map((job) => job.event);
          for (const event of report.remind) record(event).remindedAt = at;
        }
        for (const job of jobs) {
          if (job.kind !== "prep" || held.has(job.event.id)) continue;
          if (!aiAllowed) {
            if (!context.hold) report.unfenced = true;
            continue;
          }
          items.prep.push({ key: job.event.id, event: job.event, short: job.short });
          Object.assign(record(job.event), { prepStartedAt: at, fingerprint: fingerprint(job.event), start: job.event.start });
          pending.prep.push(job.event.id);
        }
        wakeAt = nextMeetingDue({ now: at, events: meetings, meetings: records });
      } catch (error) {
        trouble.push(failed(entry, "googlecalendar", error));
      }
    }

    if (checks.includes("mail") && readable("gmail")) {
      try {
        const since = emailSince({ now: at, emailCursor: entry.mailCursor });
        const { emails, more } = await session.emails(since, MAIL_READ_LIMIT);
        succeeded(entry, "gmail");
        const judged = new Set([...(entry.judged ?? []), ...held]);
        const plan = planMail({ now: at, emails, judged });
        const waiting = plan.waiting.length;
        const advanced = waiting || more ? undefined : at;
        const helpers = brief && deps.inbox?.ready() === true;
        if (helpers) report.helpersSort = true;
        const picked = helpers && plan.batch.length ? await deps.inbox!.triage(plan.batch, deps.dismissedFrom()) : null;
        if (picked) {
          // Sorted with no AI turn: every email of the batch is judged, and the picks become brief rows.
          report.picked = picked.flatMap((pick) => {
            const email = plan.batch.find((one) => one.id === pick.id);
            return email ? [{ email, why: pick.why, needsReply: pick.needsReply }] : [];
          });
          entry.judged = keepNewest([...new Set([...(entry.judged ?? []), ...plan.batch.map((email) => email.id), ...plan.quiet.map((email) => email.id)])], MAX_JUDGED);
          // Mail an earlier run still holds keeps the cursor back, so a failed run's mail is read again.
          const heldMail = Object.values(entry.pending ?? {}).some((one) => one.mail.length > 0);
          if (advanced !== undefined && !heldMail) entry.mailCursor = advanced;
        } else if (helpers && plan.batch.length && !aiAllowed) {
          // The helper models did not answer this time and no fenced AI may sort: the mail waits for the next check.
        } else if (plan.batch.length && aiAllowed) {
          items.mail = plan.batch;
          pending.mail = [...plan.batch.map((email) => email.id), ...plan.quiet.map((email) => email.id)];
          pending.replies = plan.batch.map((email) => ({ threadId: email.threadId, to: addressOf(email.from) }));
          if (advanced !== undefined) pending.mailCursor = advanced;
        } else {
          if (plan.batch.length && !context.hold) report.unfenced = true;
          const sorted = plan.batch.length && context.hold ? [] : [...plan.batch, ...plan.quiet];
          entry.judged = keepNewest([...new Set([...(entry.judged ?? []), ...sorted.map((email) => email.id)])], MAX_JUDGED);
          if (advanced !== undefined && !(plan.batch.length && context.hold)) entry.mailCursor = advanced;
        }
        if (brief && (waiting || more)) report.waiting = more ? true : waiting;
      } catch (error) {
        trouble.push(failed(entry, "gmail", error));
      }
    }

    if (checks.includes("runs")) {
      const since = entry.runsCursor ?? routine.createdAt;
      const finished = deps.runs().filter((run) => run.routineId !== routine.id && run.finishedAt !== undefined && run.finishedAt > since && ["completed", "failed", "missed"].includes(run.status));
      if (brief) {
        report.runs = finished;
        entry.runsCursor = at;
      } else if (finished.length && aiAllowed) {
        items.runs = finished;
        pending.runsCursor = at;
      } else if (!finished.length) entry.runsCursor = at;
    }

    if (apps) report.gmail = { connected: apps.gmail === true, ...(entry.address ? { address: entry.address } : {}) };
    if (trouble.length) report.trouble = trouble;
    let run: RoutineCheckResult["run"];
    const work = brief ? items.mail.length + items.prep.length : items.mail.length + items.prep.length + items.runs.length;
    if (work > 0) {
      const key = `chk-${randomUUID()}`;
      entry.pending = { ...entry.pending, [key]: { at, ...pending } };
      handed.set(key, { mail: items.mail, prep: items.prep.map(({ key: meeting, event }) => ({ key: meeting, event })) });
      run = {
        key,
        prompt: brief
          ? watchPrompt({ instructions: routine.prompt, items, timeZone: deps.timeZone(), dismissedFrom: deps.dismissedFrom() })
          : checkedPrompt({ instructions: routine.prompt, items, timeZone: deps.timeZone() }),
      };
    }
    save();
    if (brief) await deps.report(report);
    const sentence = troubleSentence(trouble);
    return { ...(run ? { run } : {}), ...(sentence ? { trouble: sentence } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}) };
  }

  function settled(run: RoutineRun): void {
    const key = run.checkKey;
    if (!key || !ownerOf(key)) return;
    if (run.status !== "completed") release(key);
    else if (run.deliver !== "brief") commit(key);
  }

  return {
    check, release, settled, commit,
    mayDraft(key, threadId, to) {
      const pending = ownerOf(key)?.[1];
      const target = pending?.replies.find((reply) => reply.threadId === threadId);
      return Boolean(target && !pending!.drafted?.includes(threadId) && (to === undefined || to.trim().toLowerCase() === target.to));
    },
    drafted(key, threadId) {
      const pending = ownerOf(key)?.[1];
      if (!pending) return;
      pending.drafted = [...new Set([...(pending.drafted ?? []), threadId])];
      save();
    },
    items: (key) => handed.get(key) ?? null,
    address: () => Object.values(state.routines).find((entry) => entry.address)?.address,
    pendingKeys: () => Object.values(state.routines).flatMap((entry) => Object.keys(entry.pending ?? {})),
    forget(routineId) {
      if (!state.routines[routineId]) return;
      delete state.routines[routineId];
      save();
    },
  };
}

