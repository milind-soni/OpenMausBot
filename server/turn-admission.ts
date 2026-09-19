// Turn admission, extracted from index.ts: the resource and dispatch-slot
// claims every turn kind passes through, plus the shared precondition
// helpers (bot lookup, busy/capacity checks) the routes and dispatch paths
// consult. The mutable maps are module-level singletons exactly as they
// were in index.ts; index.ts and the fold import them from here so
// admission stays one table per server process. The singletons come from
// ./runtime.ts — importing this module must never cycle back into index.ts.
import { maxConcurrentBotThreads } from "./config.ts";
import { cfg, store } from "./runtime.ts";
import type { BotRecord } from "./store.ts";
import { TurnResources, type TurnOwner } from "./turn-resources.ts";

export type DirectTurnDispatchClaim = {
  id: string;
  botId: string;
  threadId: string;
  phase: "setup" | "dispatching";
};
export const directTurnDispatchClaims = new Map<string, DirectTurnDispatchClaim>();

// Keep the exact provider/profile settings that own a running conversation.
// Selecting another thread or changing a default must not retarget its tools.
export const directTurnBots = new Map<string, BotRecord>();
export const turnResources = new TurnResources();
export const turnResourceOwners = new Map<string, TurnOwner>();
export const turnComputerResources = new Map<string, { owner: TurnOwner; resource: string }>();

export function claimTurnResource(owner: TurnOwner, resource: string): boolean {
  if (!turnResources.claim(resource, owner)) return false;
  turnResourceOwners.set(owner.threadId, owner);
  return true;
}

export function botForThread(botId: string, threadId: string): BotRecord | null {
  return directTurnBots.get(threadId) ?? store.projectBotForTask(botId, threadId) ?? store.bot(botId);
}

export function threadBusy(botId: string, threadId: string): boolean {
  return store.taskByThread(botId, threadId)?.busy === true || directTurnDispatchClaims.has(threadId);
}

export function botAtThreadCapacity(botId: string): boolean {
  // Setup/dispatch reservations still occupy a slot even if an early
  // completion event has already cleared the stored busy flag.
  return store.tasks(botId).filter((task) => threadBusy(botId, task.threadId)).length >= maxConcurrentBotThreads(cfg);
}

export function hasDirectDispatch(botId: string): boolean {
  return [...directTurnDispatchClaims.values()].some((claim) => claim.botId === botId);
}

export function requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord {
  const profile = store.bot(botId);
  if (!profile) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (rawThreadId !== undefined && (typeof rawThreadId !== "string" || !/^[\w-]+$/.test(rawThreadId))) {
    throw Object.assign(new Error("threadId must be a task id"), { status: 400 });
  }
  const threadId = typeof rawThreadId === "string" ? rawThreadId : profile.threadId;
  const task = store.projectBotForTask(botId, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  return task;
}
