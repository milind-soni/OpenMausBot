// Which turns on a Cloud home may use the Mac lent to it, read from the harness's own records (server/cloud-lending.ts
// decides), and the plain words a turn that can't is told. A room member turn acts for the person's line that started
// its run, for that turn generation alone, while the run lasts.
import { cloudHomeLendingRefusal, cloudLendingRefusalText, type CloudLendingTurn } from "../cloud-lending.ts";
import { unstamped } from "../cloud-owner-lines.ts";
import { deviceWord } from "../lent-computers.ts";
import type { Routine, RoutineManager, RoutineRun } from "../routines.ts";
import type { Message, Store } from "../store.ts";

type Turn = { botId: string; threadId: string; generation: string };
/** A room run: the person's line it answers, if one started it, and whether it was stopped. */
type RoomRun = { requestMessageId?: string; cancelled: boolean };

export interface CloudLendingTurnsDeps {
  store: Pick<Store, "groupByThread" | "messagesFor" | "taskByThread">;
  cloudHome: boolean;
  /** The one-on-one request a conversation's turns answer (index.ts directRequestOwners). */
  directRequest(threadId: string): CloudLendingTurn["request"];
  threadStarter(threadId: string): string | undefined;
  ownerPerson(person: string | undefined): boolean;
  cardAnswerer: CloudLendingTurn["cardAnswerer"];
  activeRoutineRun(threadId: string): RoutineRun | null;
  ownerStartedRun(runId: string): boolean;
  routineRunIsOwners(run: RoutineRun, botId: string, threadId: string): boolean;
  /** Someone else's turn changed this bot's memory since the owner last reviewed it. */
  memoryChangedBySomeoneElse(botId: string): boolean;
  routines(): Pick<RoutineManager, "listRoutines"> | null;
  routineAuthors: { authored(id: string, routine: Routine): boolean } | null;
  lentPlatform(): Parameters<typeof deviceWord>[0];
}

export function createCloudLendingTurns(deps: CloudLendingTurnsDeps) {
  const { store } = deps;
  /** Each room member turn's generation, while its run lasts: the harness's own record of which line started it. */
  const roomTurnOperations = new Map<string, RoomRun>();

  /** A room member turn's request: the line its run answers, for this generation alone, stopped once the run is. */
  function roomTurnRequest(generation: string): CloudLendingTurn["request"] {
    const operation = roomTurnOperations.get(generation);
    return operation?.requestMessageId ? { messageId: operation.requestMessageId, generations: new Set([generation]), stopped: operation.cancelled } : undefined;
  }

  function cloudLendingTurn(capability: Turn): CloudLendingTurn {
    return {
      request: store.groupByThread(capability.threadId) ? roomTurnRequest(capability.generation) : deps.directRequest(capability.threadId),
      generation: capability.generation,
      thread: store.messagesFor(capability.threadId),
      starters: cloudThreadStarters(capability.threadId),
      reportsFromOthers: store.messagesFor(capability.threadId).some(cloudReportFromOthers),
      ownerPerson: deps.ownerPerson,
      cardAnswerer: deps.cardAnswerer,
      routineRun: () => {
        const run = deps.activeRoutineRun(capability.threadId);
        if (!run || run.threadId !== capability.threadId || store.taskByThread(capability.botId, capability.threadId)?.routineRunId !== run.id) return null;
        return {
          triggerSource: run.triggerSource ?? (run.manual ? "manual" : "schedule"),
          ownerStarted: deps.ownerStartedRun(run.id),
          ownerAuthored: deps.routineRunIsOwners(run, capability.botId, capability.threadId),
        };
      },
    };
  }

  /** Why this turn can't use the lent computer, in plain words; null when it can or nothing is lent. */
  function cloudLendingRefusalNotice(capability: Turn): string | null {
    const why = cloudLendingRefusal(capability);
    if (!why) return null;
    const others = store.messagesFor(capability.threadId).filter((line) => line.role === "user" && !deps.ownerPerson(line.peerAsk ? undefined : line.sender?.id));
    return cloudLendingRefusalText(why, { room: Boolean(store.groupByThread(capability.threadId)), fromBefore: others.length > 0 && others.every(unstamped),
      device: deviceWord(deps.lentPlatform()) });
  }

  function cloudLendingRefusal(capability: Turn): "unproven" | "not-owner" | "someone-else" | "memory-changed" | null {
    const refusal = cloudHomeLendingRefusal(cloudLendingTurn(capability));
    if (refusal) return refusal;
    return deps.memoryChangedBySomeoneElse(capability.botId) ? "memory-changed" : null;
  }

  function cloudThreadStarters(threadId: string): (string | undefined)[] {
    const room = store.groupByThread(threadId);
    return [deps.threadStarter(threadId), ...(room && room.threadId !== threadId ? [deps.threadStarter(room.threadId)] : [])];
  }

  /** On a Cloud home a turn that may use the lent Mac reads only the owner's own conversations. */
  function cloudLendingView(capability: Turn): boolean {
    return deps.cloudHome && cloudHomeLendingRefusal(cloudLendingTurn(capability)) === null;
  }

  function cloudReportFromOthers(line: Message): boolean {
    if (line.webhookPost) return true;
    const routineId = line.automation?.routineId ?? (line.kind === "routine.run" ? line.routineRun?.routineId : undefined);
    if (!routineId) return false;
    // An outside event's run belongs to no routine, so its words are never the owner's.
    const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === routineId);
    return !routine || deps.routineAuthors?.authored(routine.id, routine) !== true;
  }

  return {
    cloudLendingTurn, cloudLendingRefusalNotice, cloudLendingRefusal, cloudThreadStarters, cloudLendingView, cloudReportFromOthers,
    /** A room member turn of this run started: its generation acts for the line the run answers. */
    roomTurnStarted(generation: string, run: RoomRun): void { roomTurnOperations.set(generation, run); },
    /** The run ended: none of its turn generations act for anyone any more. */
    roomTurnEnded(run: RoomRun): void { for (const [generation, owner] of roomTurnOperations) if (owner === run) roomTurnOperations.delete(generation); },
  };
}
