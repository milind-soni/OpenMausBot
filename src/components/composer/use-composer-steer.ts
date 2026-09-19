// Wave 20 split: the queued-message/steer island moved verbatim out of
// Composer into this hook. Composer passes the store bindings and the
// turn-derived flags in through deps; the hook call sits where the
// island used to, so its effects keep their original relative order.
import { useEffect, useRef, useState, type Dispatch } from "react";
import type { Action, AppState } from "@/state/reducer";
import type { Bot, Group } from "@/state/store";
import type { Pending } from "../PendingApproval";
import {
  composerCanSteerQueuedMessages,
  doubleEnterSteerWindowExpiresAt,
} from "../ComposerQueuedMessages";

/** The Composer bindings the steer/queue island closes over. */
export interface ComposerSteerDeps {
  state: AppState;
  dispatch: Dispatch<Action>;
  bot: Bot | undefined;
  group: Group | undefined;
  threadId: string;
  busy: boolean;
  locked: boolean;
  canSteer: boolean;
  approval: Pending | undefined;
}

export function useComposerSteer(deps: ComposerSteerDeps) {
  const { state, dispatch, bot, group, threadId, busy, locked, canSteer, approval } = deps;
  // Busy sends are owned by the harness immediately for both channels and
  // 1:1 chats. Keeping a channel follow-up in this component used to lose its
  // auto-send intent whenever navigation unmounted the composer.
  const pendingCount = (state.pendingQueued[threadId] ?? []).length;
  const queuedMessages = state.pendingQueued[threadId] ?? [];
  const canSteerQueued = composerCanSteerQueuedMessages(
    busy,
    locked,
    pendingCount,
    Boolean(approval),
  );
  const [steering, setSteering] = useState(false);
  const interruptTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
  };
  const queueHeadId = queuedMessages[0]?.queueId;
  const steerQueued = () => {
    if (!queueHeadId) return;
    setSteering(true);
    const settle = () => setSteering(false);
    if (group && canSteer) {
      // A steer-capable room folds the queued head into the running turn
      // through the server; it never interrupts the turn to do it.
      dispatch({ type: "steerGroupQueued", groupId: group.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (group) {
      // A room whose running engine cannot steer keeps the old behavior:
      // Steer ends the running turn so the next queued message starts.
      dispatch({ type: "interruptGroup", groupId: group.id, threadId, onError: settle });
    } else if (bot && canSteer) {
      // A steer-capable engine folds the queued words into the running turn
      // through the server; it never interrupts the turn to do it.
      dispatch({ type: "steerQueued", botId: bot.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (bot) {
    // Unlike the general Stop control, Steer belongs to this exact queue.
    // Scoping prevents a 1:1 queue from interrupting the same bot in a room
    // (or a routine) whose work is unrelated to the words shown here.
      dispatch({ type: "interrupt", botId: bot.id, threadId, onError: settle });
    }
  };
  useEffect(() => setSteering(false), [threadId, queueHeadId]);
  // Double-Enter gesture: when a send lands as a queued chip on a busy
  // steer-capable thread (live steer lost its race, an attachment, an
  // older CLI), a second Enter within a short window pulls that queue into
  // the running turn. Plain sends never consult the window, so they keep
  // their normal latency.
  const steerAgainUntilRef = useRef(0);
  const prevPendingCountRef = useRef(pendingCount);
  useEffect(() => {
    const expiresAt = doubleEnterSteerWindowExpiresAt(
      prevPendingCountRef.current,
      pendingCount,
      busy,
      canSteer,
    );
    if (expiresAt !== null) steerAgainUntilRef.current = expiresAt;
    prevPendingCountRef.current = pendingCount;
  }, [pendingCount, busy, canSteer]);
  // Most engines acknowledge interruption quickly, but a lost response must
  // not leave a control claiming to steer forever. Queue drain or turn end
  // clears it immediately; twenty seconds is the final recovery floor.
  useEffect(() => {
    if (!busy || pendingCount === 0) {
      setSteering(false);
      return;
    }
    if (!steering) return;
    const timeout = window.setTimeout(() => setSteering(false), 20_000);
    return () => window.clearTimeout(timeout);
  }, [busy, pendingCount, steering]);
  return {
    pendingCount,
    queuedMessages,
    canSteerQueued,
    steering,
    interruptTurn,
    steerQueued,
    steerAgainUntilRef,
  };
}
