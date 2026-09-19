// The deferred-resume subsystem — extracted verbatim from index.ts: the
// three pending-resume queues that re-dispatch a blocked turn once the card
// it paused for settles. Team-setup resumes re-dispatch a Chief's confirmed
// setup or deletion; connector resumes re-dispatch after an inline
// connection finishes; secret resumes re-dispatch after a credential card is
// provided or dismissed. index.ts wires createDeferredResumes above the
// roomHandoffs construction; runGroupMemberTurn and startTurn are wrapper
// thunks over function declarations index.ts hoists after that site.
import { redactSecretsInText } from "./redact.ts";
import { isTurnAdmissionBlocked } from "./turn-dispatch-guard.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import type { GroupRecord, Message, Store } from "./store.ts";
import type { GroupTurnOperation } from "./index.ts";

/** Everything the resume queues read from their host. The lateBound family
 * holds wrapper thunks for functions index.ts hoists below the wiring site;
 * the helpers are hoisted function declarations, safe to pass by value, and
 * groupQueues and store are consts declared above the wiring site. */
/** The options the resume dispatches set on startTurn; index.ts's startTurn
 * accepts these alongside its fuller optional shape. */
type StartTurnOptions = {
  threadId?: string;
  cardContinuation?: boolean;
  onDispatchError?: (message: string) => void;
};

export interface DeferredResumesDeps {
  lateBound: {
    runGroupMemberTurn(
      groupId: string,
      threadId: string,
      botId: string,
      hop: number,
      spoken?: Set<string>,
      cardContinuation?: string,
      onDispatchError?: (message: string) => void,
      isCancelled?: () => boolean,
      onProviderHandshakeStarted?: () => void,
      onProviderHandshakeSettled?: () => void,
    ): Promise<boolean>;
    startTurn(botId: string, text: string, opts?: StartTurnOptions): Promise<unknown>;
  };
  helpers: {
    activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
    beginGroupTurnOperation(groupId: string, threadId: string, botIds?: Iterable<string>): GroupTurnOperation;
    finishGroupTurnOperation(groupId: string, operation: GroupTurnOperation): void;
    groupProviderHandshakeStarted(operation: GroupTurnOperation): void;
    groupProviderHandshakeSettled(operation: GroupTurnOperation): void;
    threadBusy(botId: string, threadId: string): boolean;
  };
  state: {
    groupQueues: Map<string, Promise<void>>;
    store: Store;
  };
}

export function createDeferredResumes(deps: DeferredResumesDeps) {
  const { runGroupMemberTurn, startTurn } = deps.lateBound;
  const {
    activeGroupTurnForBot, beginGroupTurnOperation, finishGroupTurnOperation,
    groupProviderHandshakeStarted, groupProviderHandshakeSettled, threadBusy,
  } = deps.helpers;
  const { groupQueues, store } = deps.state;

type TeamSetupResumeEntry = { request: TeamSetupRequest; messageId: string; generation: number };
const pendingTeamSetupResumes = new Map<string, TeamSetupResumeEntry>();
const teamSetupResumeGenerations = new Map<string, number>();
function cancelTeamSetupResumesForThread(threadId: string): void {
  // Invalidate before provider teardown can synchronously drain the queue.
  // The generation also prevents an in-flight dispatch failure requeueing
  // its old entry after Stop or deletion has already cancelled it.
  teamSetupResumeGenerations.set(threadId, (teamSetupResumeGenerations.get(threadId) ?? 0) + 1);
  for (const [key, entry] of pendingTeamSetupResumes) {
    if (entry.request.threadId === threadId) pendingTeamSetupResumes.delete(key);
  }
}
function dispatchTeamSetupResume(entry: TeamSetupResumeEntry): void {
  const { request, messageId } = entry;
  const cancelled = () => entry.generation !== (teamSetupResumeGenerations.get(request.threadId) ?? 0);
  if (cancelled()) return;
  const owner = connectorThread(request.botId, request.threadId);
  const message = store.messagesFor(request.threadId).find((item) => item.id === messageId);
  if (!owner || !message?.card?.teamSetupRequest?.result) return;
  if (owner.group ? owner.bot.busy : threadBusy(request.botId, request.threadId) || activeGroupTurnForBot(request.botId)) {
    pendingTeamSetupResumes.set(request.requestId, entry);
    return;
  }
  const prompt = `OpenMausBot team setup decision ${request.requestId}: ${JSON.stringify(request.result)}. Report this exact result and continue the user's already requested work. Do not ask for confirmation again or repeat this setup/deletion. A denied or cancelled operation did not authorize any substitute action. Existing thread models were not changed.`;
  const failed = (error: string) => {
    if (cancelled()) return;
    const current = store.messagesFor(request.threadId).find((item) => item.id === messageId);
    if (current?.card) store.patchMessage(request.threadId, messageId, { card: { ...current.card, held: `The decision was recorded, but the Chief could not continue: ${redactSecretsInText(error).slice(0, 300)}` } });
  };
  if (owner.group) {
    const groupId = owner.group.id;
    const operation = beginGroupTurnOperation(groupId, request.threadId, [request.botId]);
    const previous = groupQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (operation.cancelled || cancelled()) return;
      const current = connectorThread(request.botId, request.threadId);
      if (!current?.group) return;
      if (current.bot.busy) { pendingTeamSetupResumes.set(request.requestId, entry); return; }
      await runGroupMemberTurn(groupId, request.threadId, request.botId, 0, new Set(), prompt, failed,
        () => operation.cancelled, () => groupProviderHandshakeStarted(operation), () => groupProviderHandshakeSettled(operation));
    });
    groupQueues.set(groupId, next.finally(() => finishGroupTurnOperation(groupId, operation)).catch((error) => failed(error instanceof Error ? error.message : String(error))));
    return;
  }
  void startTurn(request.botId, prompt, { threadId: request.threadId, cardContinuation: true, onDispatchError: failed }).catch((error) => {
    if (cancelled()) return;
    if (isTurnAdmissionBlocked(error)) pendingTeamSetupResumes.set(request.requestId, entry);
    else failed(error instanceof Error ? error.message : String(error));
  });
}
function drainTeamSetupResumes(): void {
  for (const [key, entry] of pendingTeamSetupResumes) {
    const owner = connectorThread(entry.request.botId, entry.request.threadId);
    if (owner?.group ? owner.bot.busy : threadBusy(entry.request.botId, entry.request.threadId) || activeGroupTurnForBot(entry.request.botId)) continue;
    pendingTeamSetupResumes.delete(key);
    dispatchTeamSetupResume(entry);
  }
}

const pendingConnectorResumes = new Map<
  string,
  { botId: string; threadId: string; resumeKey: string; labels: string[] }
>();

function connectorThread(botId: string, threadId: string) {
  const bot = store.bot(botId);
  if (!bot) return null;
  if (store.taskByThread(botId, threadId)) return { bot, group: undefined };
  const group = store.groupByThread(threadId);
  if (group?.memberIds.includes(botId)) return { bot, group };
  return null;
}

function connectorMessage(botId: string, threadId: string, messageId: string) {
  if (!connectorThread(botId, threadId)) return null;
  const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
  return message?.kind === "connector" && message.connector ? message : null;
}

function connectorCards(threadId: string, resumeKey: string) {
  return store.messagesFor(threadId).filter(
    (message) => message.kind === "connector" && message.connector?.resumeKey === resumeKey,
  );
}

function markConnectorResumeFailed(threadId: string, resumeKey: string, error: string) {
  for (const message of connectorCards(threadId, resumeKey)) {
    if (!message.connector) continue;
    store.patchMessage(threadId, message.id, {
      connector: { ...message.connector, resumed: false, error: error.slice(0, 180) },
    });
  }
}

function dispatchConnectorResume(entry: { botId: string; threadId: string; resumeKey: string; labels: string[] }) {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const names = entry.labels.join(", ");
  const prompt = `OpenMausBot connection update: the user securely connected ${names}. Continue the task that paused for this connection. Do not ask them to connect it again.`;
  if (owner.group ? owner.bot.busy : threadBusy(entry.botId, entry.threadId) || activeGroupTurnForBot(entry.botId)) {
    pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
    return;
  }
  if (owner.group) {
    const groupId = owner.group.id;
    const operation = beginGroupTurnOperation(groupId, entry.threadId, [entry.botId]);
    const previous = groupQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (operation.cancelled) return;
      const current = connectorThread(entry.botId, entry.threadId);
      if (!current?.group) return;
      if (current.bot.busy) {
        pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
        return;
      }
      await runGroupMemberTurn(
        current.group.id,
        entry.threadId,
        entry.botId,
        0,
        new Set(),
        prompt,
        (message) => markConnectorResumeFailed(entry.threadId, entry.resumeKey, message),
        () => operation.cancelled,
        () => groupProviderHandshakeStarted(operation),
        () => groupProviderHandshakeSettled(operation),
      );
    });
    const tracked = next.finally(() => finishGroupTurnOperation(groupId, operation));
    groupQueues.set(
      groupId,
      tracked.catch((error) => {
        markConnectorResumeFailed(entry.threadId, entry.resumeKey, error instanceof Error ? error.message : String(error));
      }),
    );
    return;
  }
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message) => markConnectorResumeFailed(entry.threadId, entry.resumeKey, message),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isTurnAdmissionBlocked(error)) pendingConnectorResumes.set(`${entry.threadId}:${entry.resumeKey}`, entry);
    else markConnectorResumeFailed(entry.threadId, entry.resumeKey, message);
  });
}

function maybeResumeConnectors(botId: string, threadId: string, resumeKey: string) {
  const cards = connectorCards(threadId, resumeKey);
  if (!cards.length || cards.some((message) => message.connector?.dismissed || message.connector?.status !== "connected")) return false;
  if (cards.every((message) => message.connector?.resumed)) return true;
  const labels = cards.map((message) => message.connector!.label);
  for (const message of cards) {
    store.patchMessage(threadId, message.id, { connector: { ...message.connector!, resumed: true, error: undefined } });
  }
  dispatchConnectorResume({ botId, threadId, resumeKey, labels });
  return true;
}

function drainConnectorResumes() {
  for (const [key, entry] of pendingConnectorResumes) {
    const owner = connectorThread(entry.botId, entry.threadId);
    if (owner?.group ? owner.bot.busy : threadBusy(entry.botId, entry.threadId) || activeGroupTurnForBot(entry.botId)) continue;
    pendingConnectorResumes.delete(key);
    dispatchConnectorResume(entry);
  }
}

type SecretResumeEntry = {
  botId: string;
  threadId: string;
  messageId: string;
  label: string;
  outcome: "provided" | "dismissed";
};
const pendingSecretResumes = new Map<string, SecretResumeEntry>();

function secretMessage(botId: string, threadId: string, messageId: string): Message | null {
  const owner = connectorThread(botId, threadId);
  if (!owner) return null;
  // A credential card is actionable only while it is visible on the chosen
  // conversation branch. In a channel, the sender attribution is also the
  // durable owner: any member may share the thread, but only the bot that
  // requested this credential may bind it into HPKE AAD or resume its turn.
  const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
  if (owner.group && message?.from?.botId !== botId) return null;
  return message?.kind === "secret" && message.secret ? message : null;
}

function markSecretResumeFailed(threadId: string, messageId: string, error: string) {
  const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
  if (!message?.secret) return;
  store.patchMessage(threadId, message.id, {
    secret: { ...message.secret, resumed: false, error: error.slice(0, 180) },
  });
}

function dispatchSecretResume(entry: SecretResumeEntry) {
  const owner = connectorThread(entry.botId, entry.threadId);
  if (!owner) return;
  const prompt =
    entry.outcome === "provided"
      ? `OpenMausBot credential update: the user securely provided ${entry.label}. Continue the task that paused for it. You do not receive the secret and must not ask them to paste it into chat.`
      : `OpenMausBot credential update: the user declined to provide ${entry.label}. Continue without it if possible, or briefly explain the limitation. Do not ask them to paste it into chat.`;
  if (owner.group ? owner.bot.busy : threadBusy(entry.botId, entry.threadId) || activeGroupTurnForBot(entry.botId)) {
    pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
    return;
  }
  if (owner.group) {
    const groupId = owner.group.id;
    const operation = beginGroupTurnOperation(groupId, entry.threadId, [entry.botId]);
    const previous = groupQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (operation.cancelled) return;
      const current = connectorThread(entry.botId, entry.threadId);
      if (!current?.group) return;
      if (current.bot.busy) {
        pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
        return;
      }
      await runGroupMemberTurn(
        current.group.id,
        entry.threadId,
        entry.botId,
        0,
        new Set(),
        prompt,
        (message) => markSecretResumeFailed(entry.threadId, entry.messageId, message),
        () => operation.cancelled,
        () => groupProviderHandshakeStarted(operation),
        () => groupProviderHandshakeSettled(operation),
      );
    });
    const tracked = next.finally(() => finishGroupTurnOperation(groupId, operation));
    groupQueues.set(
      groupId,
      tracked.catch((error) => {
        markSecretResumeFailed(
          entry.threadId,
          entry.messageId,
          error instanceof Error ? error.message : String(error),
        );
      }),
    );
    return;
  }
  void startTurn(entry.botId, prompt, {
    threadId: entry.threadId,
    cardContinuation: true,
    onDispatchError: (message) => markSecretResumeFailed(entry.threadId, entry.messageId, message),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isTurnAdmissionBlocked(error)) {
      pendingSecretResumes.set(`${entry.threadId}:${entry.messageId}`, entry);
    } else {
      markSecretResumeFailed(entry.threadId, entry.messageId, message);
    }
  });
}

function resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: SecretResumeEntry["outcome"]) {
  const message = secretMessage(botId, threadId, messageId);
  if (!message?.secret) return false;
  if (message.secret.resumed) return true;
  store.patchMessage(threadId, message.id, {
    secret: {
      ...message.secret,
      provided: outcome === "provided" ? true : message.secret.provided,
      dismissed: outcome === "dismissed" ? true : message.secret.dismissed,
      resumed: true,
      error: undefined,
    },
  });
  dispatchSecretResume({ botId, threadId, messageId, label: message.secret.label, outcome });
  return true;
}

function drainSecretResumes() {
  for (const [key, entry] of pendingSecretResumes) {
    const owner = connectorThread(entry.botId, entry.threadId);
    if (owner?.group ? owner.bot.busy : threadBusy(entry.botId, entry.threadId) || activeGroupTurnForBot(entry.botId)) continue;
    pendingSecretResumes.delete(key);
    dispatchSecretResume(entry);
  }
}
  return {
    pendingTeamSetupResumes, teamSetupResumeGenerations,
    cancelTeamSetupResumesForThread, dispatchTeamSetupResume, drainTeamSetupResumes,
    connectorThread, connectorMessage, maybeResumeConnectors, drainConnectorResumes,
    secretMessage, resumeSecretCard, drainSecretResumes,
  };
}
