// Pausing a bot, a department or every bot: it takes no new work, and what it is doing now stops, until it is resumed. The
// server sends the new state to every open app in its config frame.
import type { ConfigStatus } from "@/state/store";
import { api } from "@/state/api";

export type PauseKind = "bot" | "department";

export interface PausedByPerson {
  bots: string[];
  departments: string[];
  all?: true;
}

const NONE: PausedByPerson = { bots: [], departments: [] };

export const pausedByPerson = (config: Pick<ConfigStatus, "pausedByPerson"> | null | undefined): PausedByPerson => config?.pausedByPerson ?? NONE;

/** Paused by itself (a bot) or by name (a department); a bot paused only with its department is resumed from there. */
export function isPausedHere(config: Pick<ConfigStatus, "pausedByPerson"> | null | undefined, kind: PauseKind, id: string): boolean {
  const state = pausedByPerson(config);
  return kind === "bot" ? state.bots.includes(id) : state.departments.includes(id.trim());
}

export const isEveryBotPaused = (config: Pick<ConfigStatus, "pausedByPerson"> | null | undefined): boolean => pausedByPerson(config).all === true;

/** Taking no new work, by itself, with its department or with every bot. */
export const isBotHeld = (config: Pick<ConfigStatus, "heldBots"> | null | undefined, botId: string): boolean => config?.heldBots?.includes(botId) === true;

export async function setPaused(kind: PauseKind, id: string, paused: boolean): Promise<{ stopped: number }> {
  return api<{ stopped: number }>("/api/paused", { method: "POST", body: JSON.stringify({ kind, id, paused }), timeoutMs: 60_000 });
}

export async function setEveryBotPaused(paused: boolean): Promise<{ stopped: number }> {
  return api<{ stopped: number }>("/api/paused", { method: "POST", body: JSON.stringify({ kind: "all", paused }), timeoutMs: 60_000 });
}
