import type { AutoVmClaimTable } from "./auto-vm-claims.ts";
import type { RoomHandoff } from "./room-handoffs.ts";
import type { Message } from "./store/records.ts";
import type { TurnOwner } from "./turn-resources.ts";

/** The store surface the turn-cleanup paths read. */
export interface TurnCleanupStore {
  taskByThread(botId: string, threadId: string): { title: string } | undefined;
  bot(botId: string): { id?: string; name?: string } | null | undefined;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): void;
}

export interface TurnCleanupDeps {
  store: TurnCleanupStore;
  turnResources: { release(owner: TurnOwner): void };
  turnResourceOwners: Map<string, TurnOwner>;
  turnComputerResources: Map<string, { owner: TurnOwner; resource: string }>;
  teamComputerTurns: Map<string, { owner: TurnOwner; computerId: string; botId: string; remoteAgent: boolean }>;
  directTurnGenerationByThread: Map<string, string>;
  stopScreenPoller(botId: string, threadId?: string): void;
  roomHandoffs(): { stopAwaitingDirect(threadId: string): RoomHandoff[] };
  botForThread(botId: string, threadId: string): { id: string; modelSelection: { instanceId: string } } | null | undefined;
  cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  runningTurnInstance(bot: { modelSelection: { instanceId: string } }, threadId: string): { adapter: { interruptTurn(threadId: string): Promise<unknown> } } | null | undefined;
  closeOpenApprovals(threadId: string): void;
}

export function createTurnCleanup(deps: TurnCleanupDeps) {
  const {
    store, turnResources, turnResourceOwners, turnComputerResources, teamComputerTurns,
    directTurnGenerationByThread, stopScreenPoller, roomHandoffs, botForThread,
    cancelDirectTurnDispatch, revokeInternalCapabilitiesForThread, runningTurnInstance,
    closeOpenApprovals,
  } = deps;
  const settlingResourceOwners = new Map<string, string>();
  // Lazy Auto-VM claims (issue #1361): a thread whose auto-resolved Local VM
  // attach deferred the exclusive claim registers here so the first screen
  // tools/call gate can fire it. Dispatch claims eagerly today, so entries
  // exist only as a no-op handoff to the gate.
  const autoVmClaims: AutoVmClaimTable = new Map();

  function releaseTurnResources(owner: TurnOwner | undefined): void {
    if (!owner) return;
    if (autoVmClaims.get(owner.threadId)?.owner.generation === owner.generation) autoVmClaims.delete(owner.threadId);
    if (settlingResourceOwners.get(owner.threadId) === owner.generation) settlingResourceOwners.delete(owner.threadId);
    turnResources.release(owner);
    if (turnResourceOwners.get(owner.threadId)?.generation === owner.generation) turnResourceOwners.delete(owner.threadId);
    if (turnComputerResources.get(owner.threadId)?.owner.generation === owner.generation) turnComputerResources.delete(owner.threadId);
    const teamTurn = teamComputerTurns.get(owner.threadId);
    if (teamTurn?.owner.generation === owner.generation) {
      stopScreenPoller(teamTurn.botId, owner.threadId);
      teamComputerTurns.delete(owner.threadId);
    }
  }

  async function interruptDirectThread(botId: string, threadId: string): Promise<void> {
    // Stop belongs to the conversation it was pressed in. This bot's turn ends
    // and this conversation stops awaiting its teammates, so nothing resumes
    // into a stopped chat; assignments that never started are dropped. A
    // teammate already mid-turn keeps its own provider process, finishes, and
    // its result is still recorded here.
    noteTeammatesLeftRunning(botId, threadId, roomHandoffs().stopAwaitingDirect(threadId));
    const owner = botForThread(botId, threadId);
    const generation = directTurnGenerationByThread.get(threadId);
    cancelDirectTurnDispatch(botId, threadId);
    revokeInternalCapabilitiesForThread(threadId);
    // Main routes Stop to the engine that started the turn; keep this branch's
    // generation fence so a replacement turn's approvals are never closed here.
    try {
      await (owner ? runningTurnInstance(owner, threadId) : null)?.adapter.interruptTurn(threadId);
    } finally {
      // generation-fenced so a replacement turn's approvals are never closed here
      if (directTurnGenerationByThread.get(threadId) === generation) closeOpenApprovals(threadId);
    }
  }

  /** Stop left teammates mid-turn: say so in the transcript, name them, and
   * give the person the second gesture. One pill each, like the "Sent to"
   * receipt, so it survives Tool calls being hidden and one click away is
   * the teammate's own conversation — where Stop really reaches that turn. */
  function noteTeammatesLeftRunning(botId: string, threadId: string, running: RoomHandoff[]): void {
    if (!store.taskByThread(botId, threadId)) return;
    for (const node of running) {
      const name = store.bot(node.botId)?.name ?? "A teammate";
      const task = store.taskByThread(node.botId, node.threadId);
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Stopped here — ${name} is still working; open to stop it too`, ok: true },
        ...(task ? { threadRef: { botId: node.botId, threadId: node.threadId, title: task.title } } : {}),
      });
    }
  }

  return { releaseTurnResources, interruptDirectThread, settlingResourceOwners, autoVmClaims, turnResourceOwners, turnComputerResources, teamComputerTurns };
}

export type TurnCleanup = ReturnType<typeof createTurnCleanup>;
