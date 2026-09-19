// Hydration and connection/config cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceHydrate below.

import type { Action } from "../action";
import type { AppState } from "../reducer";
import { reconcileSnapshotQueues, replaceBotQueues } from "../queue-receipts";
import { withMascotMotion } from "./helpers";

export type HydrateAction = Extract<Action, { type: "hydrate" | "sections" | "botQueues" | "instances" | "configStatus" | "connected" | "error" }>;

export function reduceHydrate(state: AppState, action: HydrateAction): AppState {
  switch (action.type) {
    case "hydrate": {
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      const selectedId =
        state.selectedId && known(state.selectedId) ? state.selectedId : (action.bots[0]?.id ?? "");
      const hydrated = {
        ...state,
        bots: action.bots,
        groups: action.groups,
        sections: action.sections ?? [],
        computerControl: action.computerControl,
        selectedId,
        backgroundThreadEvents: {},
        modelVariantSessions: {},
      };
      return reconcileSnapshotQueues(
        action.botQueuedMessages ? replaceBotQueues(hydrated, action.botQueuedMessages) : hydrated,
        [...action.bots, ...action.groups],
      );
    }
    case "sections":
      return { ...state, sections: action.sections };
    case "botQueues":
      return reconcileSnapshotQueues(replaceBotQueues(state, action.queues), [...state.bots, ...state.groups]);
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
  }
  return action satisfies never;
}
