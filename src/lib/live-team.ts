import type { Bot, InstanceInfo } from "@/state/store";
import type { StudioSnapshot, StudioStation } from "../../shared/live-team";

export type StationState = "waiting" | "working" | "queued" | "unavailable" | "ready" | "stale";
export function stationState(bot: Bot, station: StudioStation | undefined, snapshot: StudioSnapshot, instances: InstanceInfo[], stale: boolean): StationState {
  if (stale) return "stale";
  if ((station?.attentionCount ?? 0) > 0 || snapshot.attention.items.some((item) => item.botId === bot.id) || station?.threads.some((thread) => thread.activity === "waiting-on-you")) return "waiting";
  if (station?.threads.some((thread) => thread.busy || thread.activity === "working")) return "working";
  if (station?.threads.some((thread) => thread.queued > 0)) return "queued";
  const instance = instances.find((item) => item.instanceId === bot.modelSelection.instanceId);
  if (!instance || instance.snapshot.state !== "available" || bot.activity === "dead" || bot.activity === "no-signal") return "unavailable";
  return "ready";
}

/** Identity order, rather than live state order, keeps desks from moving during work. */
export function studioPage<T extends { id: string }>(bots: T[], query: string, page: number, name: (bot: T) => string): { items: T[]; page: number; pages: number; total: number } {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = bots.filter((bot) => name(bot).toLocaleLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { items: filtered.slice(current * 12, (current + 1) * 12), page: current, pages, total: filtered.length };
}
