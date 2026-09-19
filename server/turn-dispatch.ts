// The delegated-turn wiring, extracted from index.ts: createRunDelegatedTurn
// is the drained-delegation-to-startTurn adapter. index.ts wires it where
// the inline function stood, with startTurn crossing as a lateBound thunk.
import { drainDelegations } from "./delegations.ts";
import { withPeerProvenance } from "./peer-provenance.ts";
import type { RoutineRun } from "./routines.ts";
import type { Message, Store } from "./store.ts";

/** Everything the delegated-turn adapter reads from its host. The store,
 * the unattended mark, and the delegation-watch helpers cross by value from
 * index.ts; startTurn crosses as a thunk because index.ts declares it as a
 * hoisted function the factory must not capture by reference order. */
export interface RunDelegatedTurnDeps {
  helpers: {
    store: Store;
    isUnattended(botId?: string | null, threadId?: string): boolean;
    delegationWatch: Map<string, {
      channelId?: string;
      toBotId: string;
      toBotName?: string;
      taskId?: string;
      sourceThreadId?: string;
      sourceBotId?: string;
      /** Bind a late peer result to the run that requested it, not later user
       * work that happens to reuse that run's execution conversation. */
      routineRunId?: string;
      /** when the delegated turn was dispatched — elapsed time for status checks */
      startedAtMs?: number;
    }>;
    activeRoutineRunForThread(threadId: string): RoutineRun | null;
    finalizeDelegationWatch(threadId: string, ok: boolean, reply: string, failureName: string): boolean;
  };
  lateBound: {
    startTurn: (botId: string, text: string, opts?: {
      threadId?: string;
      commsDepth?: number;
      unattended?: boolean;
      peerAsk?: Message["peerAsk"];
      onDispatchError?: (message: string) => void;
    }) => Promise<unknown>;
  };
}

// Drain queued delegations for a source thread after its turn settles.
// Run as a separate subscriber so the drain logic stays out of the main
// fold (which has its own switch/case noise) and its approval + startTurn
// calls never have to share locals with the fold's state machine.
/** How a drained delegation becomes a real turn on the target. Shared by
 * the settle-time drain and the boot-time drain of what a previous process
 * left queued. */
export function createRunDelegatedTurn(deps: RunDelegatedTurnDeps): Parameters<typeof drainDelegations>[3] {
  const { store, isUnattended, delegationWatch, activeRoutineRunForThread, finalizeDelegationWatch } = deps.helpers;
  // index.ts binds startTurn as a hoisted declaration; every read resolves the thunk.
  const startTurn = deps.lateBound.startTurn;
  return (toBotId, rawText, commsDepth, sourceThreadId, channel, taskId, sourceBotId, openedThreadId) => {
    // startTurn REJECTS on an ordinary condition — busy target, deleted bot,
    // unavailable provider. Unhandled, that rejection is fatal to the
    // harness (Node's default), which in the packaged app kills the server
    // child. Every delegation failure has to land as a chip instead.
    // A fresh-thread handoff runs in the thread the opener created — the
    // drain already dropped it if that thread is gone — never in whatever
    // the person is looking at.
    const targetThreadId = openedThreadId ?? store.bot(toBotId)?.threadId;
    const target = store.bot(toBotId);
    const opener = store.bot(sourceBotId);
    const unattended = isUnattended(sourceBotId, sourceThreadId);
    // The inbound line is another bot's words whichever way it arrived: an
    // opened thread's first line carries the shared provenance note, a
    // classic handoff the "[Delegated by @X" prefix from the drain. Both
    // record the author structurally (peerAsk) as well as in the text, so
    // a renderer never has to take the line for the person's own message.
    const peerAsk: Message["peerAsk"] | undefined = opener
      ? { botId: opener.id, name: opener.name, unattended: unattended || undefined }
      : undefined;
    const text = openedThreadId && opener
      ? withPeerProvenance(rawText, { botName: opener.name, delivery: "start_thread", unattended })
      : rawText;
    if (targetThreadId) {
      delegationWatch.set(targetThreadId, {
        channelId: channel?.id,
        toBotId,
        toBotName: target?.name,
        taskId,
        sourceThreadId,
        sourceBotId,
        routineRunId: activeRoutineRunForThread(sourceThreadId)?.id,
        startedAtMs: Date.now(),
      });
    }
    let failureReported = false;
    const reportStartFailure = (error: unknown) => {
      if (failureReported) return;
      failureReported = true;
      const bot = store.bot(toBotId);
      const why = error instanceof Error ? error.message : String(error);
      if (targetThreadId) {
        const finalized = finalizeDelegationWatch(
          targetThreadId,
          false,
          "",
          `Delegated turn could not start — ${why.slice(0, 120)}`,
        );
        if (finalized) return;
      }
      const source = store.botByThread(sourceThreadId);
      if (!source) return;
      store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: delegation to @${bot?.name ?? toBotId} could not start — ${why.slice(0, 120)}`, ok: false },
      });
    };
    return startTurn(toBotId, text, {
      threadId: targetThreadId,
      commsDepth,
      unattended,
      peerAsk,
      // startTurn schedules provider/integration setup after marking the bot
      // busy. Those asynchronous setup failures do not emit turn.completed,
      // so clear the watch and report them through this callback too.
      onDispatchError: reportStartFailure,
    }).then(() => undefined).catch((err) => {
      reportStartFailure(err);
    });
  };
}
