// Starts the per-bot memory cap (bot-memory-cap.ts) with this server's process list, bots, browsers and room.
import { readFileSync } from "node:fs";

import { startBotMemoryCap, type BotMemoryWatchdog, type CapPressure } from "../bot-memory-cap.ts";
import { engineMemory, readHostMemory, type EngineMemory, type HostMemory } from "../engine-memory.ts";
import type { FootprintOwner } from "../perf/bot-footprint.ts";
import { parseProcStat } from "../perf/process-buckets.ts";
import { linuxProcessList } from "../perf/process-sampler.ts";
import { gateHost } from "../process-room.ts";

const MB = 1_048_576;

const startOf = (pid: number): string | null => {
  try { return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"))?.start ?? null; } catch { return null; }
};

/** The room the watchdog weighs: engine-memory's room factor where turns wait for room (memory's and the pids limit's);
 * elsewhere (an explicit cap on a server without the gate) the same arithmetic from memory read directly. Short means
 * memory itself, below the floor admission keeps (never only the pids limit): the line a stopped turn ends with says so. */
export function capPressure(memory: Pick<EngineMemory, "enabled" | "roomFactor"> = engineMemory, read: () => HostMemory | null = () => readHostMemory()): CapPressure {
  const host = read();
  const free = host ? host.availableBytes + host.swapFreeBytes / 2 : null;
  const floor = host ? Math.max(320 * MB, host.totalBytes * 0.1) : 0;
  const short = host !== null && free !== null && free < floor;
  if (memory.enabled) return { room: memory.roomFactor(), short, freeBytes: free };
  if (!host || free === null) return { room: 1, short: false, freeBytes: null };
  return { room: Math.min(1, Math.max(0.1, (free - floor) / (host.totalBytes / 2))), short, freeBytes: free };
}

export function startBotMemoryCapHost(deps: { owners: () => readonly FootprintOwner[]; botName: (botId: string) => string | undefined; closeBrowsers: (threadIds: readonly string[]) => Promise<void> }): BotMemoryWatchdog | null {
  return startBotMemoryCap({
    gate: gateHost(), turns: () => engineMemory.most(), owners: deps.owners, botName: (botId) => deps.botName(botId) ?? "This bot",
    closeBrowsers: deps.closeBrowsers, list: () => linuxProcessList().rows, startOf, pressure: () => capPressure(),
  });
}
