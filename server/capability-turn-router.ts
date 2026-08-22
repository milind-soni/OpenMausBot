export interface CapabilityTurnOwnerProbe {
  ownsTurn(token: string): boolean;
}

export type CapabilityTurnResolution<T extends CapabilityTurnOwnerProbe> =
  | { status: "owned"; owner: "full-task" | "observer"; gateway: T }
  | { status: "none" | "ambiguous" };

/**
 * Resolve an opaque lease token to exactly one gateway. A token that belongs
 * to neither gateway, or somehow appears in both, is deliberately unusable.
 */
export function resolveCapabilityTurnOwner<T extends CapabilityTurnOwnerProbe>(
  token: string,
  fullTaskGateway: T,
  observerGateway: T,
): CapabilityTurnResolution<T> {
  const fullTaskOwns = fullTaskGateway.ownsTurn(token);
  const observerOwns = observerGateway.ownsTurn(token);
  if (fullTaskOwns && observerOwns) return { status: "ambiguous" };
  if (fullTaskOwns) return { status: "owned", owner: "full-task", gateway: fullTaskGateway };
  if (observerOwns) return { status: "owned", owner: "observer", gateway: observerGateway };
  return { status: "none" };
}
