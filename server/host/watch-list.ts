// Each bot's watch list: what it keeps an eye on for the person until it settles (a reply, a delivery, a deadline, a fix
// to check again). Its open items are in the bot's instructions on every turn, as records, since their words may come
// from mail or pages the bot read. Items live in watch-list.json.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { WATCH_LIMITS, type WatchInput } from "../../shared/watch-list.ts";
import { writeFileAtomic } from "../atomic.ts";
import { clean, recordsBlock } from "../records-block.ts";

const DAY = 24 * 60 * 60_000;
/** A bot keeps at most this many open items, so its instructions stay short. */
export const MAX_OPEN = 30;
const KEEP_RESOLVED_MS = 30 * DAY;
const MAX_ITEMS = 1000;
export const WATCH_FILE = "watch-list.json";

const at = z.number().finite().nonnegative();
const itemSchema = z.object({
  id: z.string().min(1).max(WATCH_LIMITS.id), botId: z.string().min(1).max(512),
  title: z.string().min(1).max(WATCH_LIMITS.title), note: z.string().max(WATCH_LIMITS.note), source: z.string().max(WATCH_LIMITS.source).optional(),
  checkAfter: at.optional(), createdAt: at, updatedAt: at, resolvedAt: at.optional(), outcome: z.string().max(WATCH_LIMITS.outcome).optional(),
});
const stateSchema = z.object({ version: z.literal(1), items: z.array(itemSchema).max(MAX_ITEMS) });
export type WatchItem = z.infer<typeof itemSchema>;
export type WatchOutcome = { ok: true; text: string } | { ok: false; status: number; error: string };

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isoMinute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

export function createWatchList(deps: { dataDir: string; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, WATCH_FILE);
  let state: z.infer<typeof stateSchema> = { version: 1, items: [] };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`watch list: ${file} is not a watch-list file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`watch list: ${file} is unreadable; starting fresh`);
  }
  const save = (): void => {
    const cutoff = now() - KEEP_RESOLVED_MS;
    state = { version: 1, items: state.items.filter((item) => item.resolvedAt === undefined || item.resolvedAt > cutoff).slice(-MAX_ITEMS) };
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`watch list: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const open = (botId: string): WatchItem[] => state.items.filter((item) => item.botId === botId && item.resolvedAt === undefined);

  function apply(botId: string, input: WatchInput): WatchOutcome {
    const time = now();
    if (input.action === "track") {
      const mine = open(botId);
      const same = mine.find((item) => item.title.toLowerCase() === input.title.toLowerCase());
      if (same) return { ok: false, status: 409, error: `You already watch this as ${same.id}; update it instead.` };
      if (mine.length >= MAX_OPEN) return { ok: false, status: 409, error: `You already watch ${MAX_OPEN} things; resolve the ones that settled first.` };
      const item: WatchItem = { id: `w${randomBytes(4).toString("hex")}`, botId, title: input.title, note: input.note, createdAt: time, updatedAt: time,
        ...(input.source ? { source: input.source } : {}), ...(input.checkAfter !== undefined ? { checkAfter: input.checkAfter } : {}) };
      state.items.push(item);
      save();
      return { ok: true, text: `Watching ${item.id}: ${item.title}. It is in your instructions on every turn until you resolve it.` };
    }
    const item = open(botId).find((one) => one.id === input.id);
    if (!item) return { ok: false, status: 404, error: `Nothing open on your watch list has id ${input.id}.` };
    if (input.action === "update") {
      Object.assign(item, { note: input.note, updatedAt: time }, input.checkAfter !== undefined ? { checkAfter: input.checkAfter } : {});
      save();
      return { ok: true, text: `Updated ${item.id}: ${item.title}.` };
    }
    Object.assign(item, { resolvedAt: time, updatedAt: time, outcome: input.outcome });
    save();
    return { ok: true, text: `Resolved ${item.id}: ${item.title}. It leaves your watch list.` };
  }

  /** The bot's open items for its instructions, or nothing when it watches nothing. */
  function prompt(botId: string): string {
    const items = open(botId);
    if (!items.length) return "";
    const time = now();
    const lines = items.map((item) => [
      item.id, clean(item.title, WATCH_LIMITS.title), clean(item.note, WATCH_LIMITS.note), item.source ? clean(item.source, WATCH_LIMITS.source) : "",
      `since ${isoDay(item.createdAt)}`, item.checkAfter === undefined ? "" : item.checkAfter <= time ? "due to look at again" : `look again after ${isoMinute(item.checkAfter)}`,
    ].filter(Boolean).join(" · "));
    return "\n\nYour watch list (watch_list) holds what you keep an eye on for the person until it settles. Look again at what is due when you can, update an item when something about it changes, and resolve it once it has settled.\n"
      + recordsBlock("your watch list", lines);
  }

  return { apply, prompt, open };
}

export type WatchList = ReturnType<typeof createWatchList>;
