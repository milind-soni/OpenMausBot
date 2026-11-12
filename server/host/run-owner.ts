// Whoever asked owns the run, in a conversation more than one person reads on a Team Cloud (a bot's shared chats and the
// conversations opened from them, a group chat). A line from anyone else (a teammate, an app, the API, another bot) never
// steers the run, never stops it and never cuts it short to be answered first: it waits in the queue, which everyone
// there sees, and runs after as its own turn. Only the asker, or an Owner or Admin, stops it. A run no person asked for (a
// bot's own work, an app's or the API's line) is nobody's: anyone who may chat there stops it, and a person's line waits
// only until it ends. Team asker ownership is limited to shared Team conversations; direct paired turns retain their authenticated session boundary on personal and self-hosted homes.
import type { ResolvedSender, WireTask } from "../../shared/wire.ts";
import type { RequestAuth } from "../request-auth.ts";
import { shownPersonName } from "../../shared/bot-owner.ts";
import type { WorkOrigin } from "../peer-provenance.ts";
import { serverLine } from "../server-lines.ts";

const PERSON = /^p_[\w-]{22}$/;

/** The person whose own request a run answers, or null when no person asked for it. */
export type RunAsker = { person: string; name: string } | null;

/** Who acts: their person key when they are a signed-in person, and whether they are the team's Owner or an Admin. */
export interface Actor {
  person?: string;
  admin: boolean;
}

export type ArrivalDecision = "as-today" | "queue";

/** Sessionless work keeps its existing path; session-bound work requires an exact session match on every side. */
export function sameSessionExecutionContext(activeSessionId: string | undefined, incomingSessionId: string | undefined, queuedSessionIds: ReadonlyArray<string | null | undefined> = []): boolean {
  if (activeSessionId === undefined && incomingSessionId === undefined && queuedSessionIds.every((id) => id == null)) return true;
  return typeof activeSessionId === "string" && incomingSessionId === activeSessionId && queuedSessionIds.every((id) => id === activeSessionId);
}

export function runActorOf(auth: RequestAuth, personOf: (auth: RequestAuth & { kind: "session" }) => string): Actor {
  return auth.kind === "session" ? { person: personOf(auth), admin: auth.scopes.includes("admin") } : { admin: false };
}

/** A new line `from` a person (absent: not a person's own line) in a conversation whose run `asker` owns. */
export function arrivalDecision(input: { shared: boolean; asker: RunAsker; from?: string; activeSessionId?: string; incomingSessionId?: string }): ArrivalDecision {
  // A person key identifies the owner, not the device session that authorized this turn. If either
  // side has authenticated session provenance, only that exact session may add work to the turn.
  // Missing provenance cannot borrow the other session's authority.
  if (!sameSessionExecutionContext(input.activeSessionId, input.incomingSessionId)) return "queue";
  if (!input.shared) return "as-today";
  return input.asker !== null && input.from !== undefined && input.from === input.asker.person ? "as-today" : "queue";
}

export function mayStop(input: { shared: boolean; asker: RunAsker; by: Actor }): boolean {
  const { shared, asker, by } = input;
  return !shared || asker === null || by.admin || by.person === asker.person;
}

/** A waiting line is its writer's to remove; one no person wrote, an Owner's or Admin's. */
export function mayRemoveQueued(input: { shared: boolean; sender?: ResolvedSender; by: Actor }): boolean {
  const { shared, sender, by } = input;
  if (!shared) return true;
  const writer = sender?.id && PERSON.test(sender.id) ? sender.id : undefined;
  return writer ? writer === by.person : by.admin;
}

/** A request is its writer's to run again; an Owner or Admin runs anyone's again, and anyone one no person wrote. */
export function mayRetry(input: { shared: boolean; sender?: ResolvedSender; by: Actor }): boolean {
  const { shared, sender, by } = input;
  return !shared || !sender?.id || by.admin || sender.id === by.person;
}

/** Waiting lines join the running turn only when every one is the asker's own and the asker adds them. */
export function mayJoinRun(input: { shared: boolean; asker: RunAsker; senders: ReadonlyArray<ResolvedSender | undefined>; by: Actor }): boolean {
  const { shared, asker, senders, by } = input;
  if (!shared) return true;
  return asker !== null && by.person === asker.person && senders.every((sender) => sender?.id === asker.person);
}

type Line = { id: string; role: string; kind: string; peerAsk?: unknown; relayed?: boolean; aside?: boolean; via?: string; sender?: ResolvedSender };

/** A person's own line, as the server recorded it: never a bot's, a relay's, an aside or one sent through the API. */
function linePerson(line: Line | undefined): RunAsker {
  if (!line || line.role !== "user" || line.kind !== "text" || line.peerAsk || line.relayed || line.aside || line.via === "api") return null;
  const person = line.sender?.id;
  return person && PERSON.test(person) ? { person, name: line.sender!.name } : null;
}

export interface RunOwnersDeps {
  /** More than one person reads this conversation: a Team Cloud conversation that is not someone's private one. */
  shared(threadId: string): boolean;
  /** The one-on-one conversation's running request (index.ts directRequestOwners). */
  directRequest(threadId: string): { messageId?: string; requestSessionId?: string; stopped?: boolean; automation?: unknown; origin?: WorkOrigin } | undefined;
  /** The person's line the group chat's live run answers, if one does. */
  roomRequestMessageId(threadId: string): string | undefined;
  isRoom(threadId: string): boolean;
  messages(threadId: string): readonly Line[];
  personName(person: string): string | undefined;
  language(threadId: string): string | undefined;
}

export function createRunOwners(deps: RunOwnersDeps) {
  const lineAsker = (threadId: string, messageId: string | undefined): RunAsker =>
    messageId ? linePerson(deps.messages(threadId).find((line) => line.id === messageId)) : null;

  const named = (owner: RunAsker): RunAsker => owner && { person: owner.person, name: shownPersonName(deps.personName(owner.person) ?? owner.name) };

  /** A routine, a webhook or an app's event runs nobody's request; work handed on for a person runs theirs. */
  const asker = (threadId: string): RunAsker => named(askerOf(threadId));
  const askerOf = (threadId: string): RunAsker => {
    if (deps.isRoom(threadId)) return lineAsker(threadId, deps.roomRequestMessageId(threadId));
    const request = deps.directRequest(threadId);
    if (!request || request.stopped || request.automation !== undefined) return null;
    const own = lineAsker(threadId, request.messageId);
    if (own) return own;
    const handedFor = request.origin?.kind === "user" ? request.origin.person : undefined;
    return handedFor ? { person: handedFor, name: handedFor } : null;
  };

  return {
    shared: deps.shared,
    asker,
    /** A waiting line's writer as the chat names them, where several people write; nothing elsewhere. */
    shownSender(threadId: string, sender: ResolvedSender): ResolvedSender | undefined {
      return deps.shared(threadId) ? { ...sender, name: shownPersonName((sender.id && deps.personName(sender.id)) || sender.name) } : undefined;
    },
    /** The conversation's wire field naming whose request runs, while it works where several people write. */
    askedBy(task: { threadId: string; busy?: boolean }): Pick<WireTask, "askedBy"> {
      const owner = task.busy && deps.shared(task.threadId) ? asker(task.threadId) : null;
      return owner ? { askedBy: { name: owner.name, id: owner.person } } : {};
    },
    /** A new line while this conversation's run goes on: as today, or into the queue behind it. */
    arrival(threadId: string, sender: ResolvedSender | undefined, ownLine: boolean, incomingSessionId?: string): ArrivalDecision {
      const request = deps.isRoom(threadId) ? undefined : deps.directRequest(threadId);
      const shared = deps.shared(threadId);
      return arrivalDecision({
        shared,
        asker: shared ? asker(threadId) : null,
        from: ownLine ? sender?.id : undefined,
        activeSessionId: request?.requestSessionId,
        incomingSessionId,
      });
    },
    /** The sentence someone who may not stop this conversation's run reads, or null when they may. */
    stopRefusal(threadId: string, by: Actor): string | null {
      const shared = deps.shared(threadId);
      const owner = shared ? asker(threadId) : null;
      return mayStop({ shared, asker: owner, by }) ? null : serverLine(deps.language(threadId), "server.runOwner.onlyAskerStops", { name: owner!.name });
    },
    /** Where several read, the running request's asker: their own line added to it goes ahead of everyone else's waiting
     * lines, as it does in a private chat. */
    askerFirst(threadId: string): string | undefined {
      return deps.shared(threadId) ? asker(threadId)?.person : undefined;
    },
    removeRefusal(threadId: string, sender: ResolvedSender | undefined, by: Actor): string | null {
      return mayRemoveQueued({ shared: deps.shared(threadId), sender, by }) ? null : serverLine(deps.language(threadId), "server.runOwner.notYourQueued");
    },
    joinRefusal(threadId: string, senders: ReadonlyArray<ResolvedSender | undefined>, by: Actor): string | null {
      const shared = deps.shared(threadId);
      return mayJoinRun({ shared, asker: shared ? asker(threadId) : null, senders, by }) ? null : serverLine(deps.language(threadId), "server.runOwner.waitsItsTurn");
    },
    /** A queued direct message may be manually steered only by the session that owns the live turn. */
    steerSessionRefusal(threadId: string, incomingSessionId: string | undefined, queuedSessionIds: ReadonlyArray<string | null | undefined>): string | null {
      if (deps.isRoom(threadId)) return null;
      const activeSessionId = deps.directRequest(threadId)?.requestSessionId;
      return sameSessionExecutionContext(activeSessionId, incomingSessionId, queuedSessionIds)
        ? null
        : serverLine(deps.language(threadId), "server.runOwner.waitsItsTurn");
    },
    /** The sentence someone who may not run this request again reads, or null when they may. */
    retryRefusal(threadId: string, sender: ResolvedSender | undefined, by: Actor): string | null {
      if (mayRetry({ shared: deps.shared(threadId), sender, by })) return null;
      return serverLine(deps.language(threadId), "server.runOwner.onlyAskerRetries", { name: shownPersonName(deps.personName(sender!.id!) ?? sender!.name) });
    },
  };
}

export type RunOwners = ReturnType<typeof createRunOwners>;

export type RouteRunOwners = Pick<RunOwners, "shared" | "stopRefusal" | "removeRefusal" | "joinRefusal" | "steerSessionRefusal" | "retryRefusal">;

/** The rule as a route asks it, by the request's sign-in. A route built without it (a server one person uses, or a
 * route's own test) refuses nothing and sees no admin, so nothing changes there. */
export function routeRunOwners(owners: RouteRunOwners | undefined, actorOf: ((auth: RequestAuth) => Actor) | undefined) {
  const by = (auth: RequestAuth): Actor => actorOf?.(auth) ?? { admin: false };
  return {
    admin: (auth: RequestAuth) => by(auth).admin,
    /** Where several people write, who wrote a request decides who runs it again or rewords it, not who opened the conversation. */
    decidesRetry: (threadId: string) => owners?.shared(threadId) ?? false,
    stopRefusal: (auth: RequestAuth, threadId: string) => owners?.stopRefusal(threadId, by(auth)) ?? null,
    removeRefusal: (auth: RequestAuth, threadId: string, sender: ResolvedSender | undefined) => owners?.removeRefusal(threadId, sender, by(auth)) ?? null,
    joinRefusal: (auth: RequestAuth, threadId: string, senders: ReadonlyArray<ResolvedSender | undefined>) => owners?.joinRefusal(threadId, senders, by(auth)) ?? null,
    steerSessionRefusal: (auth: RequestAuth, threadId: string, queuedSessionIds: ReadonlyArray<string | null | undefined>) =>
      owners?.steerSessionRefusal(threadId, auth.kind === "session" ? auth.session.id : undefined, queuedSessionIds) ?? null,
    retryRefusal: (auth: RequestAuth, threadId: string, sender: ResolvedSender | undefined) => owners?.retryRefusal(threadId, sender, by(auth)) ?? null,
  };
}
