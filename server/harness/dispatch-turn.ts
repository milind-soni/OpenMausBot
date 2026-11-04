/**
 * Turn dispatch seam: re-exports the fail-closed dispatch guard used by beginTurn / room turns.
 */
export {
  guardTurnDispatch,
  PendingTurnCancellations,
  ProviderTurnGenerationRegistry,
  RetiredTurnRegistry,
  isTurnEventQuarantined,
} from "../turn-dispatch-guard.ts";
