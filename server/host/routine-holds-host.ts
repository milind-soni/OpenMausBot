// Why every routine waits now (routine-holds.ts), on a Cloud home, read from three places: whether any AI of the owner's
// own can still run here (cloud-credit-moves.ts `away`, read with the engines), whether the owner removed every connected
// app and MCP server (marked when the last one goes, cleared when one comes back), and whether the plan was cancelled (the
// Admin's signed request, routes/cloud-signed.ts). What was last read is kept in routine-holds.json, so a restart neither
// frees nor pauses anything before the engines are read again. A cause that begins and pauses routines writes one quiet
// line in the owner's Chief's chat; nothing else is sent, so nobody who left is messaged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoutineHoldCause } from "../../shared/routines.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { RoutineManager } from "../routines.ts";
import type { Store } from "../store.ts";

/** While every connection is gone, whether one came back elsewhere (an app connected from another device) is read again at
 * most this often. */
const RECHECK_MS = 15 * 60_000;

/** The owner's one line when a cause begins and pauses routines. */
export const ROUTINE_HOLD_LINES: Record<RoutineHoldCause, string> = {
  plan_cancelled: "Your routines are paused because the plan was cancelled. To keep one running until the plan ends, turn it back on in Routines.",
  no_engine: "Your routines are paused: none of your AI accounts is signed in here any more. They turn back on by themselves when you sign in again.",
  no_connections: "Your routines are paused: every connected app and MCP server was removed. They turn back on when you connect one, or turn one back on in Routines.",
};

interface Saved { away?: true; planCancelled?: true; connectionsGone?: true }

export interface RoutineHoldsHostDeps {
  dataDir: string;
  store: Pick<Store, "bots" | "appendMessage">;
  /** MCP servers saved here. */
  mcpServers: () => number;
  /** Whether any app is connected here; null when that can't be read now. */
  appsConnected: () => Promise<boolean | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export function createRoutineHoldsHost(deps: RoutineHoldsHostDeps) {
  const file = join(deps.dataDir, "routine-holds.json");
  const now = deps.now ?? Date.now;
  let saved: Saved = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    saved = { ...(raw.away === true ? { away: true } : {}), ...(raw.planCancelled === true ? { planCancelled: true } : {}), ...(raw.connectionsGone === true ? { connectionsGone: true } : {}) };
  } catch { /* none kept yet */ }
  let rechecked = 0;
  let rechecking = false;
  /** The routines, once index.ts has made them (`attach`): what is read before then waits for them. */
  let routines: Pick<RoutineManager, "holdFor"> | null = null;

  function save(next: Saved): boolean {
    if (JSON.stringify(next) === JSON.stringify(saved)) return false;
    saved = next;
    try { writeFileAtomic(file, JSON.stringify(saved), { mode: 0o600 }); }
    catch (error) { deps.log?.(`[routines] could not keep why routines wait (${error instanceof Error ? error.name : "error"})`); }
    return true;
  }

  function causes(): RoutineHoldCause[] {
    return [...(saved.planCancelled ? ["plan_cancelled" as const] : []), ...(saved.away ? ["no_engine" as const] : []), ...(saved.connectionsGone ? ["no_connections" as const] : [])];
  }

  /** The owner's Chief: the place's own one, else the first made (a Team Cloud's founder's). */
  function tell(line: string): void {
    const chief = deps.store.bots.filter((bot) => !bot.hidden && bot.chiefOfStaff)
      .sort((a, b) => Number(Boolean(b.defaultBot)) - Number(Boolean(a.defaultBot)) || a.createdAt - b.createdAt)[0];
    if (chief) deps.store.appendMessage(chief.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${line}`, ok: true } });
  }

  /** Never throws: it runs inside reading the engines, which must not fail for it. */
  function review(): void {
    if (!routines) return;
    try {
      for (const cause of routines.holdFor(causes())) tell(ROUTINE_HOLD_LINES[cause]);
    } catch (error) {
      deps.log?.(`[routines] could not pause or resume routines (${error instanceof Error ? error.message : "error"})`);
    }
    if (saved.connectionsGone && !rechecking && now() - rechecked >= RECHECK_MS) void connections("recheck");
  }

  /** A connection removed (the hold begins when none is left), added (it ends), or read again while none was left. */
  async function connections(change: "removed" | "added" | "recheck"): Promise<void> {
    if (change === "added") {
      if (save({ ...saved, connectionsGone: undefined })) review();
      return;
    }
    if (change === "removed" && saved.connectionsGone) return;
    rechecking = true;
    try {
      const left = deps.mcpServers() > 0 ? true : await deps.appsConnected().catch(() => null);
      rechecked = now();
      // Unreadable: nothing changes on a guess.
      if (left === null) return;
      if (save({ ...saved, connectionsGone: left ? undefined : true })) review();
    } finally {
      rechecking = false;
    }
  }

  return {
    /** The routines are made: what was last read applies to them now. */
    attach(manager: Pick<RoutineManager, "holdFor">): void {
      routines = manager;
      review();
    },
    review,
    /** The engines were read: whether no AI of the owner's own can run here, for sure. */
    engines(away: boolean): void {
      save({ ...saved, away: away ? true : undefined });
      review();
    },
    /** The Admin's word on the plan: cancelled (routines pause), or renewing again (they turn back on). */
    plan(cancelled: boolean): void {
      save({ ...saved, planCancelled: cancelled ? true : undefined });
      review();
    },
    connections,
    /** The causes holding routines now. */
    causes,
  };
}

export type RoutineHoldsHost = ReturnType<typeof createRoutineHoldsHost>;
