import type { HandoffView } from "../coordinator.ts";
import type { EngineWaits } from "../engine-memory.ts";
import { serverLine } from "../server-lines.ts";
import type { SteerQueueReason } from "../../shared/wire.ts";
import type { QueuedReasonDeps } from "./queued-reason.ts";

/** Long enough that a hand-off held by a turn about to finish says nothing. */
export const QUEUED_NOTE_AFTER_MS = 30_000;

export interface WaitWordsDeps {
  language(threadId: string): string | undefined;
  /** This Cloud's plan runs on the smallest machine, so a bigger one is what gives it more room. */
  starter(): boolean;
  /** The record of what the turn this thread runs is waiting for. */
  held(threadId: string, why: string): void;
  changed(): void;
}

export function createWaitWords(deps: WaitWordsDeps): EngineWaits & { queued(threadId: string, reason: SteerQueueReason | undefined): string | undefined } {
  return {
    text(threadId, { first, running, ahead, limit }) {
      const language = deps.language(threadId);
      if (limit !== undefined) return serverLine(language, first ? "server.planTurns.wait" : "server.planTurns.still", { limit, ahead });
      if (!first) return serverLine(language, "server.memory.still", { running, ahead });
      const wait = serverLine(language, "server.memory.wait", { running, ahead });
      return deps.starter() ? `${wait} ${serverLine(language, "server.memory.starter")}` : wait;
    },
    began(threadId, { running, ahead, limit }) {
      deps.held(threadId, limit !== undefined ? `plan: ${limit} at once, ${ahead} ahead` : `memory: ${running} running, ${ahead} ahead${deps.starter() ? ", on Starter" : ""}`);
    },
    changed: deps.changed,
    queued(threadId, reason) {
      if (!reason) return undefined;
      return serverLine(deps.language(threadId), reason === "group-turn" ? "server.queued.groupTurn" : deps.starter() ? "server.queued.capacityStarter" : "server.queued.capacity");
    },
  };
}

export interface QueuedNotesDeps extends Pick<QueuedReasonDeps, "botName" | "threadBusy" | "slots" | "groupTurn" | "waitsForComputer" | "behindPerson"> {
  now(): number;
  language(threadId: string): string | undefined;
  parent(node: HandoffView): HandoffView | undefined;
  post(parent: HandoffView, node: HandoffView, line: string): void;
  node(id: string): HandoffView | undefined;
}

/** The runtime holds a resuming hand-off behind a busy turn too: counting only "queued" as still held let two such
 * hand-offs prune each other's note and post it again on every check. */
const stillHeld = (node: HandoffView | undefined): boolean => node?.status === "queued" || node?.status === "resume";

/** One line in the requester's chat once a hand-off has been held a while, naming the limit. A computer's wait and a person's
 * open card say so themselves. */
export function createQueuedNotes(deps: QueuedNotesDeps) {
  const noted = new Set<string>();
  return (node: HandoffView): void => {
    if (noted.has(node.id) || node.groupId || deps.now() - (node.lastProgressAt ?? node.createdAt) < QUEUED_NOTE_AFTER_MS) return;
    if (deps.waitsForComputer(node) || deps.behindPerson(node)) return;
    const parent = deps.parent(node);
    if (!parent) return;
    const language = deps.language(parent.threadId), bot = deps.botName(node.botId) ?? "?";
    const { busy, limit } = deps.slots(node.botId);
    const line = deps.threadBusy(node.botId, node.threadId) ? serverLine(language, "server.teammates.queued.thread", { bot })
      : busy.length >= limit ? serverLine(language, "server.teammates.queued.slots", { bot, busy: busy.length, limit })
        : deps.groupTurn(node.botId) ? serverLine(language, "server.teammates.queued.room", { bot }) : undefined;
    if (!line) return;
    for (const id of noted) if (!stillHeld(deps.node(id))) noted.delete(id);
    noted.add(node.id);
    deps.post(parent, node, line);
  };
}
