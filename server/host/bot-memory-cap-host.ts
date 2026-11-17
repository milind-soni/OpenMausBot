// Starts the per-bot memory cap (bot-memory-cap.ts) with this server's process list, bots and browsers.
import { readFileSync } from "node:fs";

import { startBotMemoryCap, type BotMemoryWatchdog } from "../bot-memory-cap.ts";
import { engineMemory } from "../engine-memory.ts";
import type { FootprintOwner } from "../perf/bot-footprint.ts";
import { parseProcStat } from "../perf/process-buckets.ts";
import { linuxProcessList } from "../perf/process-sampler.ts";
import { gateHost } from "../process-room.ts";

const startOf = (pid: number): string | null => {
  try { return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"))?.start ?? null; } catch { return null; }
};

export function startBotMemoryCapHost(deps: { owners: () => readonly FootprintOwner[]; botName: (botId: string) => string | undefined; closeBrowsers: (botId: string) => Promise<void> }): BotMemoryWatchdog | null {
  return startBotMemoryCap({
    gate: gateHost(), turns: () => engineMemory.most(), owners: deps.owners, botName: (botId) => deps.botName(botId) ?? "This bot",
    closeBrowsers: deps.closeBrowsers, list: () => linuxProcessList().rows, startOf,
  });
}
