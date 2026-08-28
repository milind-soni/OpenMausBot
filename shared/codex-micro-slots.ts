import { partitionSidebarBots, type SidebarMember } from "./sidebar-layout.ts";

export const CODEX_MICRO_SLOT_COUNT = 6;

export type CodexMicroStatus = "ready" | "working" | "waiting" | "needsYou" | "error" | "offline";

export interface CodexMicroAgent {
  id: string;
  name: string;
  status: CodexMicroStatus;
}

/** First six sidebar bots: unsectioned Chief of Staff, then pinned, then the rest. */
export function codexMicroSlotBots<T extends SidebarMember>(bots: T[], limit = CODEX_MICRO_SLOT_COUNT): T[] {
  const parts = partitionSidebarBots(bots);
  const ordered = [
    ...(parts.unsectionedChief ? [parts.unsectionedChief] : []),
    ...parts.pinnedUnderChief,
    ...parts.unsectionedBots,
    ...parts.sectionChiefs,
    ...parts.sectionedBots,
  ];
  const seen = new Set<string>();
  const slots: T[] = [];
  for (const bot of ordered) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    slots.push(bot);
    if (slots.length >= limit) break;
  }
  return slots;
}

export function botCodexStatus(bot: {
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  busy?: boolean;
}): CodexMicroStatus {
  if (bot.activity === "working" || bot.busy) return "working";
  if (bot.activity === "waiting-on-you") return "needsYou";
  if (bot.activity === "no-signal") return "waiting";
  if (bot.activity === "dead") return "error";
  return "ready";
}

export interface CodexMicroRoster {
  agents: CodexMicroAgent[];
}

export function codexMicroRoster(
  bots: Array<
    SidebarMember & {
      name?: string;
      activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
      busy?: boolean;
    }
  >,
): CodexMicroRoster {
  return {
    agents: codexMicroSlotBots(bots).map((bot) => ({
      id: bot.id,
      name: bot.name?.trim() || bot.id,
      status: botCodexStatus(bot),
    })),
  };
}
