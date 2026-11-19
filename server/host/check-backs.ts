// Check-backs: a bot comes back to the same conversation at a time it chose, with a note of what to check. Each one is a
// record in `check-backs.json` and a quiet line in its conversation. When its time comes the bot takes an ordinary turn
// there, started for whoever's request set it (the same origin, so on a Team Cloud the asker owns the run and a private
// chat stays private). Nobody is asked anything at any point: the line's Cancel is the person's only control.
//
// A check-back starts at most once. The start is saved before the turn is asked for; a record found mid-start after a
// restart is closed, never started again. Time missed while the computer slept or the app was closed runs it once, late.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { CHECK_BACK_LIMITS, type CheckBackLine, type CheckBackStatus } from "../../shared/check-back.ts";
import { writeFileAtomic } from "../atomic.ts";
import { startDueTimer, type DueTimer } from "../due-timer.ts";
import { workOriginSchema, type WorkOrigin } from "../peer-provenance.ts";
import { wallClockLabel } from "./check-back-time.ts";

export const CHECK_BACK_FILE = "check-backs.json";
export const NOTE_MAX = 1_000;
export const CONDITION_MAX = 500;
/** How long a check-back whose bot or chat is busy waits before it looks again. */
export const BUSY_RETRY_MS = 15_000;
/** A start the server refused (a paused bot, maintenance, a move) is tried again this often, this many times. */
export const START_RETRY_MS = 60_000;
export const START_TRIES = 60;
/** Later than this past its time, a check-back says in its turn that it runs late. */
export const LATE_MS = 2 * 60_000;

const id = z.string().min(1).max(200);
const recordSchema = z.object({
  id, botId: id, threadId: id,
  note: z.string().min(1).max(NOTE_MAX), condition: z.string().max(CONDITION_MAX).optional(),
  dueAt: z.number(), createdAt: z.number(), zone: z.string().max(100),
  origin: workOriginSchema,
  lineMessageId: id.optional(),
  /** Set and saved right before the turn is asked for. */
  startingAt: z.number().optional(),
  tries: z.number().int().optional(),
});
const fileSchema = z.object({ version: z.literal(1), checkBacks: z.array(z.unknown()) });
export type CheckBackRecord = z.infer<typeof recordSchema>;

export interface NewCheckBack {
  botId: string; threadId: string; note: string; condition?: string; dueAt: number; zone: string; origin: WorkOrigin;
}
export type CreateResult = { ok: true; record: CheckBackRecord } | { ok: false; error: string };

export interface CheckBackDeps {
  file?: string;
  dataDir: string;
  now?: () => number;
  /** False once the bot or the conversation is gone, or the person who owns a private chat left. */
  alive(botId: string, threadId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  /** Writes or rewrites the record's line; returns the line's message id. */
  line(record: CheckBackRecord, line: CheckBackLine, messageId: string | undefined): string | undefined;
  /** Asks for the turn; rejects when the server refused to start it. */
  start(record: CheckBackRecord, prompt: string): Promise<void>;
  /** The refusal is the bot being paused or held: it waits for the bot, however long, without using up its tries. */
  paused?(error: unknown): boolean;
  log?(text: string): void;
}

export function checkBackPrompt(record: CheckBackRecord, startAt: number): string {
  const late = startAt - record.dueAt > LATE_MS
    ? ` It was due at ${new Date(record.dueAt).toISOString()}; this computer was asleep or MausBot was not running, so it runs now, once, late.`
    : "";
  const condition = record.condition ? ` Only if this holds: ${record.condition}. If it does not, end with one short line saying nothing was needed.` : "";
  return `[Check back: at ${new Date(record.createdAt).toISOString()} you set this to come back now (${wallClockLabel(record.dueAt, record.zone)}, ${record.zone}). What to check: ${record.note}${condition}${late} Check it now and carry on the work here; tell the person what you found in a sentence or two. Use check_back again only if it still needs a later look.]`;
}

const lineOf = (record: CheckBackRecord, status: CheckBackStatus, extra: Partial<CheckBackLine> = {}): CheckBackLine => ({
  id: record.id, dueAt: record.dueAt, status, note: record.note, ...extra,
});

export function createCheckBacks(deps: CheckBackDeps) {
  const file = deps.file ?? join(deps.dataDir, CHECK_BACK_FILE);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((text: string) => console.error(text));
  let records: CheckBackRecord[] = load();
  const waitUntil = new Map<string, number>();
  let timer: DueTimer | null = null;
  let running = false;
  let recovered = false;

  function load(): CheckBackRecord[] {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success ? parsed.data.checkBacks.flatMap((candidate) => {
        const record = recordSchema.safeParse(candidate);
        return record.success ? [record.data] : [];
      }) : [];
    } catch {
      return [];
    }
  }

  function save(): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ version: 1, checkBacks: records }, null, 2), { mode: 0o600 });
  }

  function commit(mutate: () => void): void {
    const before = records.map((record) => ({ ...record }));
    try {
      mutate();
      save();
    } catch (error) {
      records = before;
      throw error;
    }
    timer?.poke();
  }

  function drawLine(record: CheckBackRecord, line: CheckBackLine): void {
    try {
      const messageId = deps.line(record, line, record.lineMessageId);
      if (messageId && !record.lineMessageId) record.lineMessageId = messageId;
    } catch (error) {
      log(`check-back ${record.id}: could not draw its line: ${String(error)}`);
    }
  }

  function close(record: CheckBackRecord, line: CheckBackLine): void {
    commit(() => { records = records.filter((other) => other.id !== record.id); });
    waitUntil.delete(record.id);
    drawLine(record, line);
  }

  /** Pending ones whose bot and chat are still here; the others are dropped, so nothing of a gone chat stays on disk. */
  function live(): CheckBackRecord[] {
    const here = records.filter((record) => deps.alive(record.botId, record.threadId));
    if (here.length !== records.length) {
      try { commit(() => { records = records.filter((record) => here.includes(record)); }); } catch (error) { log(`check-back: could not drop gone ones: ${String(error)}`); }
    }
    return here;
  }

  function refusal(input: NewCheckBack, at: number): string | null {
    const ahead = input.dueAt - at;
    if (ahead < CHECK_BACK_LIMITS.minMs - 1_000) return "That is less than a minute away: do it now in this turn instead.";
    if (ahead > CHECK_BACK_LIMITS.maxMs) return "That is more than 90 days away. Pick a time within 90 days, or make a routine with trigger.";
    const mine = live().filter((record) => record.botId === input.botId);
    if (mine.filter((record) => record.threadId === input.threadId).length >= CHECK_BACK_LIMITS.perConversation) {
      return `This conversation already has ${CHECK_BACK_LIMITS.perConversation} check-backs waiting, the most it may. Cancel one first.`;
    }
    if (mine.length >= CHECK_BACK_LIMITS.perBot) return `You already have ${CHECK_BACK_LIMITS.perBot} check-backs waiting across your conversations, the most a bot may.`;
    return null;
  }

  async function startOne(record: CheckBackRecord, at: number): Promise<void> {
    commit(() => { record.startingAt = at; });
    try {
      await deps.start(record, checkBackPrompt(record, at));
    } catch (error) {
      const tries = (record.tries ?? 0) + (deps.paused?.(error) ? 0 : 1);
      const why = error instanceof Error ? error.message : String(error);
      if (tries >= START_TRIES || !deps.alive(record.botId, record.threadId)) {
        close(record, lineOf(record, "failed", { why: why.split("\n", 1)[0]!.slice(0, 200) }));
        return;
      }
      commit(() => { delete record.startingAt; record.tries = tries; });
      waitUntil.set(record.id, now() + START_RETRY_MS);
      return;
    }
    close(record, lineOf(record, "started", { startedAt: at }));
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      live();
      const at = now();
      for (const record of records.slice()) {
        if (record.startingAt !== undefined || at < record.dueAt || at < (waitUntil.get(record.id) ?? 0)) continue;
        if (deps.busy(record.botId, record.threadId)) { waitUntil.set(record.id, at + BUSY_RETRY_MS); continue; }
        await startOne(record, at);
      }
    } finally {
      running = false;
    }
  }

  return {
    create(input: NewCheckBack): CreateResult {
      const at = now();
      const refused = refusal(input, at);
      if (refused) return { ok: false, error: refused };
      const { lends: _lends, ...origin } = input.origin as WorkOrigin & { lends?: true };
      const record: CheckBackRecord = {
        id: randomUUID(), botId: input.botId, threadId: input.threadId, note: input.note.slice(0, NOTE_MAX),
        ...(input.condition ? { condition: input.condition.slice(0, CONDITION_MAX) } : {}),
        dueAt: input.dueAt, createdAt: at, zone: input.zone, origin: origin as WorkOrigin,
      };
      commit(() => { records.push(record); });
      drawLine(record, lineOf(record, "pending"));
      if (record.lineMessageId) {
        try { save(); } catch (error) { log(`check-back ${record.id}: could not store its line: ${String(error)}`); }
      }
      return { ok: true, record: { ...record } };
    },
    /** Pending ones in this conversation, soonest first. */
    list(botId: string, threadId: string): CheckBackRecord[] {
      return live().filter((record) => record.botId === botId && record.threadId === threadId && record.startingAt === undefined)
        .sort((a, b) => a.dueAt - b.dueAt).map((record) => ({ ...record }));
    },
    get(checkBackId: string): CheckBackRecord | null {
      const found = records.find((record) => record.id === checkBackId);
      return found ? { ...found } : null;
    },
    cancel(checkBackId: string): CheckBackRecord | null {
      const found = records.find((record) => record.id === checkBackId && record.startingAt === undefined);
      if (!found) return null;
      close(found, lineOf(found, "cancelled"));
      return { ...found };
    },
    /** When a sleeping Cloud should wake: the soonest check-back's time. */
    nextDueAt(): number | null {
      const pending = live().filter((record) => record.startingAt === undefined);
      return pending.length ? Math.min(...pending.map((record) => Math.max(record.dueAt, waitUntil.get(record.id) ?? 0))) : null;
    },
    start(): void {
      if (!recovered) {
        recovered = true;
        const cut = records.filter((record) => record.startingAt !== undefined);
        for (const record of cut) close(record, lineOf(record, "failed", { why: "MausBot stopped while it was starting this; it was not started again." }));
      }
      if (timer) return;
      timer = startDueTimer({
        run: () => tick(),
        next: () => records.reduce<number | null>((soonest, record) => record.startingAt !== undefined ? soonest
          : Math.min(soonest ?? Infinity, Math.max(record.dueAt, waitUntil.get(record.id) ?? 0)), null),
        now,
        retryMs: BUSY_RETRY_MS,
        onError: (error) => log(`check-back tick failed: ${String(error)}`),
      });
    },
    stop(): void {
      timer?.stop();
      timer = null;
    },
    tick,
    get isTicking(): boolean { return running; },
  };
}

export type CheckBacks = ReturnType<typeof createCheckBacks>;

/** What the bot reads back: each pending check-back with its id, its time and its note. */
export function checkBackList(records: readonly CheckBackRecord[]): string {
  return records.map((record) => `- ${record.id} · ${wallClockLabel(record.dueAt, record.zone)} (${new Date(record.dueAt).toISOString()}) · ${record.note}${record.condition ? ` · only if: ${record.condition}` : ""}`).join("\n");
}
