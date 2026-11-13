import type { RoutineRunTrigger } from "../routines.ts";
import { OUTSIDE, type WorkOrigin } from "../peer-provenance.ts";
import type { TurnKind } from "../agents-turn.ts";

export interface DirectRequestOwner {
  generation: string;
  messageId?: string;
  generations: Set<string>;
  turnId: string | null;
  stopped?: boolean;
  requestSessionId?: string;
  automation?: RoutineRunTrigger;
  origin?: WorkOrigin;
  personLine?: true;
  kind?: TurnKind;
  gmailDrafts?: Set<string>;
}

export function turnOriginForRequest<T extends { externalRuntime?: unknown; roomHandoffId?: string; threadId: string; generation: string }>(
  capability: T,
  directRequest: (threadId: string) => DirectRequestOwner | undefined,
  roomOrigin: (handoffId: string) => WorkOrigin,
): WorkOrigin {
  if (capability.externalRuntime) return OUTSIDE;
  if (capability.roomHandoffId) return roomOrigin(capability.roomHandoffId);
  const owner = directRequest(capability.threadId);
  return owner?.origin && !owner.stopped && owner.generations.has(capability.generation) ? owner.origin : OUTSIDE;
}

export function requestSessionOptions<T extends { messageId?: string; requestSessionId?: string }>(
  explicitSessionId: string | undefined,
  continuation: boolean,
  previousRequest: T | undefined,
  requestMessageId: string | undefined,
): { requestSessionId?: string } {
  const inherited = continuation && requestMessageId !== undefined && previousRequest?.messageId === requestMessageId
    ? previousRequest?.requestSessionId
    : undefined;
  const requestSessionId = explicitSessionId || inherited;
  return requestSessionId ? { requestSessionId } : {};
}

export function sharedComputerPrincipalForRequest<T>(requestSessionId: string | undefined, isLive: (id: string) => boolean, resolve: () => T | null, requireSession = false): T | null {
  if (requireSession && !requestSessionId) return null;
  return requestSessionId && !isLive(requestSessionId) ? null : resolve();
}

/** A restored Cloud-home handoff may keep borrowing the computer only for the still-live session that authorized it. */
export function cloudHandoffSessionMayResume(cloudHome: boolean, lends: boolean, requestSessionId: string | undefined, isLive: (id: string) => boolean): boolean {
  return !cloudHome || !lends || Boolean(requestSessionId && isLive(requestSessionId));
}

export function requestSessionGuard(sessionId: string | undefined, isLive: (id: string) => boolean, refuse: () => Error): () => void {
  return () => { if (sessionId && !isLive(sessionId)) throw refuse(); };
}

/** Checks the session bound to the active request owner immediately before provider dispatch. */
export function directTurnRequestSessionMayDispatch(request: { requestSessionId?: string } | undefined, isLive: (id: string) => boolean): boolean {
  return !request?.requestSessionId || isLive(request.requestSessionId);
}

/** A deferred retry belongs to its captured generation and session, never a newer request on the same thread. */
export function quickRetryRequestMayDispatch(
  owner: { botId: string; generation: string; requestSessionId?: string } | undefined,
  currentGeneration: string | undefined,
  request: DirectRequestOwner | undefined,
  claimIsCurrent: (botId: string, generation: string) => boolean,
  isLive: (id: string) => boolean,
): boolean {
  return Boolean(owner && currentGeneration === owner.generation && claimIsCurrent(owner.botId, owner.generation) &&
    request?.generations.has(owner.generation) && request.requestSessionId === owner.requestSessionId && !request.stopped &&
    directTurnRequestSessionMayDispatch(request, isLive));
}

export function requireLiveBeforeSteerFallback(outcome: "steered" | "refused" | "indeterminate", requireLive: () => void): void {
  if (outcome === "refused") requireLive();
}

export function queuedRequestSessionMayDispatch(head: { requestSessionId?: string | null; trigger?: { kind?: string } }, isLive: (id: string) => boolean): boolean {
  return head.requestSessionId === undefined
    ? head.trigger?.kind !== "user" && head.trigger?.kind !== "owner"
    : head.requestSessionId === null || isLive(head.requestSessionId);
}

export async function settledPrincipalRemainsAuthorized<T>(principal: T, settle: (stillAuthorized: () => boolean) => Promise<T>, stillAuthorized: () => boolean): Promise<boolean> {
  return await settle(stillAuthorized) === principal && stillAuthorized();
}
