// What bots find on their own and report with report_finding: a card in the bot's chat now, and a row in MausBot's brief
// until the person says Got it. A bot never tells the person the same thing twice: the key of each finding is kept for
// 60 days. Updates and keys live in found.json; an update's text is the bot's own words, so it is shown as plain text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { FOUND_LIMITS, type FindingInput } from "../../shared/found-update.ts";
import { WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import { writeFileAtomic } from "../atomic.ts";
import { createAgentCard } from "../chat-widgets.ts";
import type { BotRecord, Store } from "../store.ts";
import { oneLine } from "./text-clip.ts";

const DAY = 24 * 60 * 60_000;
/** A key reported this recently is refused, so the same news never reaches the person twice. */
export const TOLD_MS = 60 * DAY;
const KEEP_MS = 7 * DAY;
const MAX_UPDATES = 200;
const MAX_TOLD = 2000;
export const FOUND_FILE = "found.json";

const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(512);
const link = z.object({ label: z.string().min(1).max(FOUND_LIMITS.linkLabel), url: z.string().min(1).max(2048) });
const updateSchema = z.object({
  id, botId: id, threadId: id, messageId: id, key: z.string().min(1).max(FOUND_LIMITS.key),
  title: z.string().min(1).max(FOUND_LIMITS.title), details: z.string().max(FOUND_LIMITS.details), source: z.string().max(FOUND_LIMITS.source).optional(),
  links: z.array(link).max(FOUND_LIMITS.links), at, seenAt: at.optional(),
});
const stateSchema = z.object({
  version: z.literal(1),
  updates: z.array(updateSchema).max(MAX_UPDATES),
  told: z.array(z.object({ botId: id, key: z.string().min(1).max(FOUND_LIMITS.key), at })).max(MAX_TOLD),
});

export type FoundUpdate = z.infer<typeof updateSchema>;
export type FindingOutcome = { ok: true; messageId: string } | { ok: false; status: number; error: string };

/** The card a finding puts in the bot's chat: what was found, where, and its links. */
export function foundCard(update: Pick<FoundUpdate, "title" | "details" | "source" | "links">): WidgetRoot {
  const links = update.links.map((one) => ({ type: "Button", label: oneLine(one.label, WIDGET_LIMITS.label), style: "secondary", onClickAction: { type: "open_url", payload: { url: one.url } } }));
  return {
    type: "Card", title: update.title, ...(update.source ? { caption: update.source } : {}),
    children: [{ type: "Text", value: update.details }, ...(links.length ? [{ type: "Row", gap: 2, wrap: true, children: links }] : [])],
  } as unknown as WidgetRoot;
}

export interface FoundDeps {
  store: Pick<Store, "messagesFor" | "appendMessage" | "patchMessage" | "groupByThread" | "patchTask">;
  dataDir: string;
  now?: () => number;
  /** A finding landed: the brief shows it from now on. */
  reported?(): void;
}

export function createFoundUpdates(deps: FoundDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, FOUND_FILE);
  let state: z.infer<typeof stateSchema> = { version: 1, updates: [], told: [] };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`found: ${file} is not a found-updates file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`found: ${file} is unreadable; starting fresh`);
  }
  const save = (): void => {
    const at = now();
    state = {
      version: 1,
      updates: state.updates.filter((one) => at - one.at <= KEEP_MS).slice(-MAX_UPDATES),
      told: state.told.filter((one) => at - one.at <= TOLD_MS).slice(-MAX_TOLD),
    };
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`found: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Posts the finding in `threadId`, the bot's own chat, unless this bot already reported its key in the last 60 days. */
  function report(bot: Pick<BotRecord, "id" | "name" | "color">, threadId: string, input: FindingInput): FindingOutcome {
    const at = now();
    const told = state.told.find((one) => one.botId === bot.id && one.key === input.key && at - one.at <= TOLD_MS);
    if (told) {
      const day = new Date(told.at).toISOString().slice(0, 10);
      return { ok: false, status: 409, error: `You already reported this (key "${input.key}") on ${day}, so the person was told. Do not report it again; if something about it changed, report that with a new key that says what changed.` };
    }
    if (deps.store.groupByThread(threadId)) return { ok: false, status: 409, error: "report_finding is not available in rooms." };
    const posted = createAgentCard({ store: deps.store as Parameters<typeof createAgentCard>[0]["store"], bot, threadId, input: { tool: "show_widget", widget: foundCard(input) }, serverCard: true });
    if (!posted.ok) return posted;
    deps.store.patchTask(bot.id, threadId, { unread: true });
    state.updates.push({ id: posted.messageId, botId: bot.id, threadId, messageId: posted.messageId, at, ...input });
    state.told.push({ botId: bot.id, key: input.key, at });
    save();
    deps.reported?.();
    return { ok: true, messageId: posted.messageId };
  }

  return {
    report,
    /** What was reported since a time and is not yet marked Got it, newest first. */
    recent: (since: number): FoundUpdate[] => state.updates.filter((one) => one.at >= since && one.seenAt === undefined).reverse(),
    gotIt(updateId: string): boolean {
      const update = state.updates.find((one) => one.id === updateId);
      if (!update || update.seenAt !== undefined) return false;
      update.seenAt = now();
      save();
      return true;
    },
  };
}

export type FoundUpdates = ReturnType<typeof createFoundUpdates>;
