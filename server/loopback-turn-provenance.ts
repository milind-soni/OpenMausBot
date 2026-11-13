import { lendingPerson, OWN_SERVER_LENDER, type OwnServer } from "./person-key.ts";
import type { LoopbackTurnProvenance } from "./direct-send.ts";
import { loopbackCredentialId, type RequestAuth } from "./request-auth.ts";
import type { PublicSession } from "./sessions.ts";
import { provenRequestPerson } from "./shared-computers.ts";
import { linePersonKey } from "./host/thread-person.ts";
import type { Message } from "./store.ts";

type LenderSession = Pick<PublicSession, "id" | "email" | "scopes" | "owner" | "teamRole" | "token">;

export type SharedComputerRequest = {
  requestProvenance?: LoopbackTurnProvenance;
  messageId?: string;
  stopped?: boolean;
  generations: Set<string>;
};

export class SharedComputerTurnAuthorization {
  private readonly queued = new Map<string, LoopbackTurnProvenance>();
  private readonly revokedCompanions = new Set<string>();

  async afterWake(
    principal: string | null,
    active: () => boolean,
    current: () => string | null,
    wait: (principal: string | null, check: () => boolean) => Promise<unknown>,
  ): Promise<string | null> {
    const stillAuthorized = () => active() && current() === principal;
    await wait(principal, stillAuthorized);
    return stillAuthorized() ? principal : null;
  }

  queue(id: string, proof: LoopbackTurnProvenance | undefined): void { if (proof) this.queued.set(id, proof); }

  queueWith<T extends { id: string }>(proof: LoopbackTurnProvenance | undefined, create: () => T): T {
    const item = create();
    this.queue(item.id, proof);
    return item;
  }

  afterSteer(messageId: string, proof: LoopbackTurnProvenance | undefined, create: () => { id: string }): void {
    this.queue(messageId, proof);
    this.queueWith(proof, create);
  }

  take(messageId: string, queueId?: string): LoopbackTurnProvenance | undefined {
    const proof = (queueId ? this.queued.get(queueId) : undefined) ?? this.queued.get(messageId);
    if (queueId) this.queued.delete(queueId);
    this.queued.delete(messageId);
    return proof;
  }

  takeOption(messageId: string, queueId?: string): { requestProvenance?: LoopbackTurnProvenance } {
    const requestProvenance = this.take(messageId, queueId);
    return requestProvenance ? { requestProvenance } : {};
  }

  forTurn(requested: LoopbackTurnProvenance | undefined, queued: LoopbackTurnProvenance | undefined, continued: LoopbackTurnProvenance | undefined): LoopbackTurnProvenance | undefined {
    return requested ?? queued ?? continued;
  }

  revokeCompanion(deviceId: string, requests: Iterable<SharedComputerRequest>): void {
    this.revokedCompanions.add(deviceId);
    for (const request of requests) if (request.requestProvenance?.kind === "companion" && request.requestProvenance.deviceId === deviceId) request.stopped = true;
  }

  principal(
    request: SharedComputerRequest | undefined,
    generation: string,
    own: OwnServer,
    sessions: readonly LenderSession[],
    sessionLive: (id: string) => boolean,
    messages: readonly Message[],
  loopbackCredentialIsCurrent: (proof: Extract<LoopbackTurnProvenance, { kind: "desktop-owner" | "companion" }>) => boolean = () => false,
  ): string | null {
    if (request?.requestProvenance) {
      if (!request.messageId || request.stopped || !request.generations.has(generation)) return null;
      return requestSharedComputerPrincipal(request.requestProvenance, own, sessions, sessionLive, (id) => this.revokedCompanions.has(id), loopbackCredentialIsCurrent);
    }
    return lendingPerson(provenRequestPerson(request, generation,
      (id) => linePersonKey(messages.find((message) => message.id === id))), own, () => sessions);
  }
}

export function requestTurnProvenance(auth: RequestAuth, ownServer: OwnServer, sessionPerson: (auth: Extract<RequestAuth, { kind: "session" }>) => string): LoopbackTurnProvenance | undefined {
  return auth.kind === "session" ? { kind: "session", sessionId: auth.session.id, person: sessionPerson(auth) } : loopbackTurnProvenance(auth, ownServer);
}

export function loopbackCredentialIsCurrent(proof: Extract<LoopbackTurnProvenance, { kind: "desktop-owner" | "companion" }>, desktopToken: string | undefined, companionToken: string | undefined): boolean {
  return proof.kind === "desktop-owner"
    ? Boolean(desktopToken) && proof.credentialId === loopbackCredentialId(desktopToken!)
    : Boolean(companionToken) && proof.credentialId === loopbackCredentialId(companionToken!);
}

export function loopbackTurnProvenance(auth: RequestAuth, ownServer: OwnServer): LoopbackTurnProvenance | undefined {
  if (auth.kind !== "loopback" || !ownServer) return undefined;
  if (!auth.loopbackCredentialId) return undefined;
  if (auth.desktopOwner) return { kind: "desktop-owner", credentialId: auth.loopbackCredentialId };
  if (auth.companionDevice) return { kind: "companion", deviceId: auth.companionDevice, credentialId: auth.loopbackCredentialId };
  return undefined;
}

export function loopbackSharedComputerPrincipal(
  proof: LoopbackTurnProvenance | undefined,
  ownServer: OwnServer,
  companionRevoked: (deviceId: string) => boolean = () => false,
  credentialIsCurrent: (proof: Extract<LoopbackTurnProvenance, { kind: "desktop-owner" | "companion" }>) => boolean = () => false,
): string | null {
  if (!proof || proof.kind === "session" || !ownServer || !credentialIsCurrent(proof) || (proof.kind === "companion" && companionRevoked(proof.deviceId))) return null;
  return OWN_SERVER_LENDER;
}

export function requestSharedComputerPrincipal(
  proof: LoopbackTurnProvenance | undefined,
  ownServer: OwnServer,
  sessions: readonly LenderSession[],
  sessionLive: (id: string) => boolean,
  companionRevoked: (deviceId: string) => boolean = () => false,
  credentialIsCurrent: (proof: Extract<LoopbackTurnProvenance, { kind: "desktop-owner" | "companion" }>) => boolean = () => false,
): string | null {
  if (proof?.kind === "session") {
    return sessionLive(proof.sessionId) ? lendingPerson(proof.person, ownServer, () => sessions) : null;
  }
  return loopbackSharedComputerPrincipal(proof, ownServer, companionRevoked, credentialIsCurrent);
}
