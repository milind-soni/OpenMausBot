import type { RuntimeEvent } from "./contracts.ts";

type PermissionEvent = RuntimeEvent & {
  type: "request.opened";
  requestType: "permission";
};

export type GraphRuntimeRouteResult<GraphOwner, GraphAcceptance> =
  | {
      routed: false;
      reason: "turn-token-rejected" | "graph-manager-rejected";
      graphOwner: GraphOwner;
      graphAcceptance: null;
    }
  | {
      routed: true;
      reason: null;
      graphOwner: GraphOwner | null;
      graphAcceptance: GraphAcceptance | null;
    };

export interface GraphRuntimeRouteOptions<GraphOwner, GraphAcceptance> {
  /**
   * Resolve ownership once, before any fold can mutate the task or bot
   * projection. A graph-owned turn remains owned while cancellation is
   * pending, even when its permission authorization has already been
   * revoked.
   */
  graphOwner: GraphOwner | null;
  /** Validate the opaque, in-memory lease for this exact graph turn. */
  eventTokenMatches: (event: RuntimeEvent, graphOwner: GraphOwner) => boolean;
  /**
   * Ask the durable graph manager to accept and bind the exact provider,
   * thread, and turn before downstream code can answer a permission or fold
   * the event into the mutable bot/task projection.
   */
  acceptGraphRuntimeEvent: (event: RuntimeEvent, graphOwner: GraphOwner) => GraphAcceptance | null;
  /** Optional production fold hooks keep ordering testable without test IPC. */
  respondToPermission?: (
    event: PermissionEvent,
    context: { graphOwner: GraphOwner | null; graphAcceptance: GraphAcceptance | null },
  ) => void;
  foldProjection?: (
    event: RuntimeEvent,
    context: { graphOwner: GraphOwner | null; graphAcceptance: GraphAcceptance | null },
  ) => void;
}

/**
 * Route one runtime event across the graph authority boundary.
 *
 * For ordinary turns this is a transparent pass-through. For graph-owned
 * turns it fails closed unless both the volatile turn token and the durable
 * manager's exact provider/thread/turn binding accept the event. Permission
 * response and projection callbacks therefore cannot run on a stale or
 * forged graph event.
 */
export function routeGraphRuntimeEvent<GraphOwner, GraphAcceptance>(
  event: RuntimeEvent,
  options: GraphRuntimeRouteOptions<GraphOwner, GraphAcceptance>,
): GraphRuntimeRouteResult<GraphOwner, GraphAcceptance> {
  const graphOwner = options.graphOwner;
  let graphAcceptance: GraphAcceptance | null = null;

  if (graphOwner !== null) {
    if (!options.eventTokenMatches(event, graphOwner)) {
      return {
        routed: false,
        reason: "turn-token-rejected",
        graphOwner,
        graphAcceptance: null,
      };
    }
    graphAcceptance = options.acceptGraphRuntimeEvent(event, graphOwner);
    if (graphAcceptance === null) {
      return {
        routed: false,
        reason: "graph-manager-rejected",
        graphOwner,
        graphAcceptance: null,
      };
    }
  }

  const context = { graphOwner, graphAcceptance };
  if (event.type === "request.opened" && event.requestType === "permission") {
    options.respondToPermission?.(event as PermissionEvent, context);
  }
  options.foldProjection?.(event, context);
  return { routed: true, reason: null, ...context };
}

export interface StalledTurn {
  botId: string;
  threadId: string;
}

export type StalledTurnRouteResult<GraphOwner> =
  | { route: "graph-cancel"; graphOwner: GraphOwner }
  | { route: "ordinary-interrupt"; graphOwner: null };

export interface StalledTurnRouteOptions<GraphOwner extends { id: string }> {
  graphOwnerForThread: (threadId: string) => GraphOwner | null;
  cancelGraph: (graphOwner: GraphOwner, turn: StalledTurn) => void | Promise<void>;
  interruptOrdinaryTurn: (turn: StalledTurn) => void | Promise<void>;
}

/**
 * Route watchdog recovery without broadening graph authority. A graph-owned
 * stall is cancelled through the graph manager, which revokes its exact
 * capability lease and interrupts only its owned provider turn. The normal
 * bot interrupt path is reserved for turns with no active graph owner.
 */
export async function routeStalledTurn<GraphOwner extends { id: string }>(
  turn: StalledTurn,
  options: StalledTurnRouteOptions<GraphOwner>,
): Promise<StalledTurnRouteResult<GraphOwner>> {
  const graphOwner = options.graphOwnerForThread(turn.threadId);
  if (graphOwner) {
    await options.cancelGraph(graphOwner, turn);
    return { route: "graph-cancel", graphOwner };
  }
  await options.interruptOrdinaryTurn(turn);
  return { route: "ordinary-interrupt", graphOwner: null };
}
