import type { ContextBreakdown } from "../../shared/context-breakdown";
import type { Bot, Group } from "@/state/store";
import { t } from "./i18n";
import type { ContextTone } from "./usage";

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

const ROWS = ["systemPrompt", "memoryFiles", "tools", "skills", "toolCalls", "messages", "other", "reserved", "free"] as const;
export type ContextRow = { id: (typeof ROWS)[number]; tokens: number; percent: number };

const ROW_OF: Record<string, ContextRow["id"]> = {
  system_prompt: "systemPrompt", memory_files: "memoryFiles",
  system_tools: "tools", mcp_tools: "tools", mcp_instructions: "tools",
  skills: "skills", custom_agents: "skills", messages: "messages",
};

/** The engine's categories as the rows people read: tool calls and their results come out of the messages, a kind
 * this app has no name for counts as Other, and what the engine holds back for compacting is not free space. */
export function contextRows(breakdown: ContextBreakdown | null | undefined): ContextRow[] | null {
  if (!breakdown || !positive(breakdown.window) || !Array.isArray(breakdown.categories)) return null;
  const totals = new Map<ContextRow["id"], number>();
  const add = (id: ContextRow["id"], tokens: number) => { if (positive(tokens)) totals.set(id, (totals.get(id) ?? 0) + tokens); };
  for (const entry of breakdown.categories) {
    add(entry.kind === "free" ? "free" : entry.kind === "buffer" ? "reserved" : ROW_OF[entry.id] ?? "other", entry.tokens);
  }
  const tools = Math.min(totals.get("messages") ?? 0, (breakdown.messages?.toolCalls ?? 0) + (breakdown.messages?.toolResults ?? 0));
  if (tools > 0) {
    add("toolCalls", tools);
    if (totals.get("messages") === tools) totals.delete("messages");
    else totals.set("messages", totals.get("messages")! - tools);
  }
  if (![...totals.keys()].some((id) => id !== "free" && id !== "reserved")) return null;
  return ROWS.filter((id) => totals.has(id)).map((id) => ({ id, tokens: totals.get(id)!, percent: Math.round((totals.get(id)! / breakdown.window) * 1000) / 10 }));
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
    case "reserved": return t("contextMenu.category.reserved");
    case "free": return t("contextMenu.category.free");
  }
}
