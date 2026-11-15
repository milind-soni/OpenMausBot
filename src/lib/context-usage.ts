import type { Bot, Group, TaskUsage } from "@/state/store";
import { t } from "./i18n";
import type { ContextTone } from "./usage";

export const CONTEXT_CATEGORIES = ["systemPrompt", "memoryFiles", "tools", "skills", "toolCalls", "messages", "other"] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/** What fills the context, by kind, when the engine can tell. `providerCompacts`: the provider folds the conversation
 * on its own as it nears the window. */
export interface ContextBreakdown {
  categories: ReadonlyArray<{ id: string; tokens: number }>;
  providerCompacts?: boolean;
}

export interface ContextReading {
  tokens: number;
  window?: number;
  percent?: number;
  tone: ContextTone;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function contextReading(tokens: unknown, window: unknown): ContextReading | null {
  if (!positive(tokens)) return null;
  const size = positive(window) ? window : undefined;
  const percent = size ? Math.min(999, Math.round((tokens / size) * 100)) : undefined;
  return { tokens, window: size, percent, tone: percent === undefined || percent < 50 ? "quiet" : percent < 80 ? "warning" : "danger" };
}

export function roomContextReadings(group: Pick<Group, "memberContext">, members: readonly Bot[]):
  Array<{ bot: Bot; reading: ContextReading; requested: boolean }> {
  return members.flatMap((bot) => {
    const measured = group.memberContext?.[bot.id];
    const reading = measured ? contextReading(measured.tokens, measured.window) : null;
    return reading ? [{ bot, reading, requested: measured?.compactRequested === true }] : [];
  });
}

export type ContextRow = { id: ContextCategory | "free"; tokens: number; percent?: number };

/** A kind this app has no name for counts as Other; free space closes the list when the window is known. */
export function contextRows(context: TaskUsage["context"]): ContextRow[] | null {
  const listed = context?.breakdown?.categories;
  if (!context || !Array.isArray(listed)) return null;
  const totals = new Map<ContextCategory, number>();
  for (const entry of listed) {
    if (!positive(entry?.tokens)) continue;
    const id = (CONTEXT_CATEGORIES as readonly string[]).includes(entry.id) ? entry.id as ContextCategory : "other";
    totals.set(id, (totals.get(id) ?? 0) + entry.tokens);
  }
  if (!totals.size) return null;
  const window = positive(context.window) ? context.window : undefined;
  const share = (tokens: number) => window ? Math.round((tokens / window) * 1000) / 10 : undefined;
  const rows: ContextRow[] = CONTEXT_CATEGORIES.filter((id) => totals.has(id)).map((id) => ({ id, tokens: totals.get(id)!, percent: share(totals.get(id)!) }));
  if (window) {
    const free = Math.max(0, window - Math.max(context.tokens, rows.reduce((sum, row) => sum + row.tokens, 0)));
    rows.push({ id: "free", tokens: free, percent: share(free) });
  }
  return rows;
}

export function contextRowLabel(id: ContextRow["id"]): string {
  switch (id) {
    case "systemPrompt": return t("contextMenu.category.systemPrompt");
    case "memoryFiles": return t("contextMenu.category.memoryFiles");
    case "tools": return t("contextMenu.category.tools");
    case "skills": return t("contextMenu.category.skills");
    case "toolCalls": return t("contextMenu.category.toolCalls");
    case "messages": return t("contextMenu.category.messages");
    case "other": return t("contextMenu.category.other");
    case "free": return t("contextMenu.category.free");
  }
}
