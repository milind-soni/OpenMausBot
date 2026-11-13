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
  const inherited = continuation && previousRequest?.messageId === requestMessageId ? previousRequest?.requestSessionId : undefined;
  const requestSessionId = explicitSessionId || inherited;
  return requestSessionId ? { requestSessionId } : {};
}

export function sharedComputerPrincipalForRequest<T>(requestSessionId: string | undefined, isLive: (id: string) => boolean, resolve: () => T | null): T | null {
  return requestSessionId && !isLive(requestSessionId) ? null : resolve();
}

export function requestSessionGuard(sessionId: string | undefined, isLive: (id: string) => boolean, refuse: () => Error): () => void {
  return () => { if (sessionId && !isLive(sessionId)) throw refuse(); };
}

export function queuedRequestSessionMayDispatch(head: { requestSessionId?: string | null; trigger?: { kind?: string } }, isLive: (id: string) => boolean): boolean {
  return head.requestSessionId === undefined
    ? head.trigger?.kind !== "user" && head.trigger?.kind !== "owner"
    : head.requestSessionId === null || isLive(head.requestSessionId);
}

export async function settledPrincipalRemainsAuthorized<T>(principal: T, settle: (stillAuthorized: () => boolean) => Promise<T>, stillAuthorized: () => boolean): Promise<boolean> {
  return await settle(stillAuthorized) === principal && stillAuthorized();
}
