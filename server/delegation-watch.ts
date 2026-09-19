// The delegation/coordination watch — extracted verbatim from index.ts.
// This module owns the direct-followup generation registries (the receipt a
// 1:1 turn hands the fold), the delegation watch map (mirroring a delegated
// turn's terminal state back into its channel), and the peer-wake machinery
// that resumes a source bot once its teammate replies. index.ts wires
// createDelegationWatch at the old direct-followup declaration site; the
// lateBound family holds thunks for consts index.ts declares after the
// watch is wired.
import { randomUUID } from "node:crypto";

import { getOrCreateChannel, mirrorActivity, mirrorReply, type CommsBus } from "./comms-visibility.ts";
import {
  buildDelegationFailurePrompt,
  buildDelegationRevivalPrompt,
  DelegationWakeBudget,
  recordDelegationReceipt,
  type DelegationReceipt,
} from "./delegations.ts";
import { Handoffs } from "./delta-context.ts";
import { INCIDENTS_THREAD_TITLE, IncidentLedger, chiefForBot, incidentChip, incidentText, type Incident, type IncidentKind } from "./incidents.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { canReachPeer } from "./peer-roster.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoomHandoffs } from "./room-handoffs.ts";
import type { RoutineManager, RoutineRun, RoutineRunOn } from "./routines.ts";
import { registry, store } from "./runtime.ts";
import { queueSteeredMessage } from "./steer-queue.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { botAtThreadCapacity, botForThread, threadBusy } from "./turn-admission.ts";
import { isTurnAdmissionBlocked, ProviderTurnGenerationRegistry } from "./turn-dispatch-guard.ts";

/** The settled-turn receipt the direct-followup machinery hands back. */
export type DirectTurnOutcome = { ok: boolean; text: string };

/** One watched delegated turn, keyed by the TARGET thread it runs on. */
export type DelegationWatchEntry = {
  channelId?: string;
  toBotId: string;
  toBotName?: string;
  taskId?: string;
  sourceThreadId?: string;
  sourceBotId?: string;
  /** Bind a late peer result to the run that requested it, not later user
   * work that happens to reuse that run's execution conversation. */
  routineRunId?: string;
  /** when the delegated turn was dispatched — elapsed time for status checks */
  startedAtMs?: number;
};

export type PendingDelegationWake = { botId: string; targetName: string; failureReason?: string; routineRunId?: string; budgetAcquired?: boolean };

/** Everything the watch reads from its host. The lateBound family holds
 * thunks for consts index.ts declares after the factory is wired. */
export interface DelegationWatchDeps {
  lateBound: {
    roomHandoffs(): RoomHandoffs;
    routines(): RoutineManager | null;
    startTurn(botId: string, text: string, opts?: { threadId?: string; cardContinuation?: boolean; unattended?: boolean; peerAsk?: Message["peerAsk"] }): Promise<unknown>;
    commsBus(): CommsBus;
  };
  helpers: {
    retireProviderTurn(turnId: string): void;
    isUnattended(botId?: string | null, threadId?: string): boolean;
    activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
    turnInstance(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): ReturnType<typeof registry.get>;
    notify(notification: Notification | null): void;
  };
}

export function createDelegationWatch(deps: DelegationWatchDeps) {
  const { roomHandoffs, routines, startTurn, commsBus } = deps.lateBound;
  const { retireProviderTurn, isUnattended, activeGroupTurnForBot, turnInstance, notify } = deps.helpers;

  const directFollowupTurns = new ProviderTurnGenerationRegistry<DirectTurnOutcome>();
  const directFollowupSettlers = new Map<string, { threadId: string; settle?: () => void }>();
  const directCoordinationSettlers = new Map<string, (outcome: DirectTurnOutcome) => void>();
  function settleDirectCoordination(generation: string | undefined, outcome: DirectTurnOutcome) {
    if (!generation) return;
    roomHandoffs().sourceSettled(generation, outcome.ok);
    const settle = directCoordinationSettlers.get(generation);
    directCoordinationSettlers.delete(generation);
    settle?.(outcome);
  }
  function settleDirectFollowup(generation: string | undefined): void {
    if (!generation) return;
    settleDirectCoordination(generation, { ok: false, text: "The coordinated turn was interrupted" });
    const pending = directFollowupSettlers.get(generation);
    if (!pending) return;
    directFollowupSettlers.delete(generation);
    // Failure/Stop can precede the adapter's terminal event. Quarantine only
    // this generation's bound ids, including after the watchdog frees its slot.
    for (const turnId of directFollowupTurns.deleteGeneration(pending.threadId, generation)) retireProviderTurn(turnId);
    pending.settle?.();
  }

  /** A delegated turn's terminal state belongs in the A⇄B channel:
   * the request was mirrored there when the delegation drained, and a
   * channel that only ever shows requests is half a record. Mirror the
   * reply on success; mirror a failed/stopped terminal chip otherwise. */
  const delegationWatch = new Map<string, DelegationWatchEntry>();

  // Peer wake: when a delegated reply lands, resume the source bot so it can
  // fold the result in and answer the user instead of sitting idle. Mirrors
  // the cardContinuation resume pattern used for connector/credential cards.
  const delegationWakeBudget = new DelegationWakeBudget();
  const pendingDelegationWakes = new Map<string, PendingDelegationWake>();

  function activeRoutineRunForThread(threadId: string): RoutineRun | null {
    const run = routines()?.runForThread(threadId);
    return run && ["running", "waiting"].includes(run.status) ? run : null;
  }

  function routineDelegationCanResume(threadId: string, routineRunId?: string): boolean {
    return !routineRunId || activeRoutineRunForThread(threadId)?.id === routineRunId;
  }

  function dispatchDelegationWake(botId: string, threadId: string, targetName: string, failureReason?: string, routineRunId?: string, budgetAcquired = false): void {
    if (!store.taskByThread(botId, threadId)) return;
    if (!routineDelegationCanResume(threadId, routineRunId)) return;
    if (!budgetAcquired && !delegationWakeBudget.tryAcquire(threadId)) {
      routines()?.failThread(threadId, "Delegation follow-up limit reached; review the run before retrying");
      return;
    }
    const prompt = failureReason
      ? buildDelegationFailurePrompt(targetName, failureReason)
      : buildDelegationRevivalPrompt(targetName);
    void startTurn(botId, prompt, {
      threadId,
      cardContinuation: true,
      unattended: isUnattended(botId, threadId),
    })
      .then(() => undefined)
      .catch((error) => {
        if (!store.taskByThread(botId, threadId)) return;
        const message = error instanceof Error ? error.message : String(error);
        // Raced with a user turn claiming the bot — retry once it settles.
        // This is the same logical wake, so keep its original budget charge.
        if (isTurnAdmissionBlocked(error)) {
          pendingDelegationWakes.set(threadId, { botId, targetName, failureReason, routineRunId, budgetAcquired: true });
          return;
        }
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          tool: {
            name: `error: could not resume after delegation — ${message.slice(0, 120)}`,
            ok: false,
          },
        });
        routines()?.failThread(threadId, `Could not resume after delegation: ${message}`);
      });
  }

  function wakeDelegationSource(source: BotRecord, threadId: string, targetName: string, failureReason?: string, routineRunId?: string): void {
    if (!store.taskByThread(source.id, threadId)) return;
    if (!routineDelegationCanResume(threadId, routineRunId)) return;
    // Busy? Hold the wake until the source settles, then drain it — the
    // delegated reply is already in the thread, so nothing is lost, and the
    // source processes it the moment it is free rather than only on a later
    // user nudge.
    if (threadBusy(source.id, threadId) || activeGroupTurnForBot(source.id)) {
      pendingDelegationWakes.set(threadId, { botId: source.id, targetName, failureReason, routineRunId });
      return;
    }
    dispatchDelegationWake(source.id, threadId, targetName, failureReason, routineRunId);
  }

  // ── incidents: a broken run reaches the Chief of Staff ──────────────────
  // A failed, stalled or unstartable run used to leave one chip in the thread
  // it died in and nothing anywhere else; the person found it hours later,
  // from a phone, by opening the desktop and reading every thread. The team
  // already has a role for this — the Chief coordinates the section — so the
  // incident becomes a turn of the Chief's, in its "Team incidents" thread,
  // with a link to the broken thread and retry_thread to act on it. The person
  // reads one place. Policy in server/incidents.ts.
  const incidentLedger = new IncidentLedger();

  /** What the broken thread was about: the last line the person (or the
   * requester) sent there, and the last thing the bot said. */
  function incidentContext(threadId: string): { lastRequest: string | null; lastReply: string | null } {
    const messages = [...store.messagesFor(threadId)].reverse();
    return {
      lastRequest: messages.find((message) => message.role === "user" && message.kind === "text" && message.text)?.text ?? null,
      lastReply: messages.find((message) => message.role === "bot" && message.kind === "text" && message.text)?.text ?? null,
    };
  }

  function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void {
    const { bot, threadId } = input;
    const task = store.taskByThread(bot.id, threadId);
    // A thread another bot opened and is watching is that bot's to handle:
    // the delegator is woken with the failure already (wakeDelegationSource).
    if (task?.openedBy?.delegationId || delegationWatch.has(threadId) || roomHandoffs().activeDirect(threadId)) return;
    const group = store.groupByThread(threadId);
    const incident: Incident = {
      kind: input.kind,
      bot,
      threadId,
      title: task?.title ?? null,
      room: group?.name ?? null,
      detail: redactSecretsInText(input.detail),
      ...incidentContext(threadId),
    };
    const count = incidentLedger.note(threadId);
    // a crash loop is one incident, not a storm
    if (count.muted) return;
    const chief = chiefForBot(store.bots, bot);
    // A run that could not start and a failed routine have already buzzed
    // the person (turn-failed, routine-failed) by the time they get here; a
    // failure or stall mid-run has not. One notification per failure, never two.
    const alreadyNotified = input.kind === "could-not-start" || input.kind === "routine-failed";
    const tellThePerson = () => {
      if (alreadyNotified) return;
      notify(buildNotification("incident", bot, threadId, incidentChip(incident), {
        avatarUrl: bot.avatarUrl,
        ...(group ? { group: { id: group.id, name: group.name } } : {}),
      }));
    };
    // no Chief on duty, or the Chief itself broke: the person is next
    if (!chief) {
      tellThePerson();
      return;
    }
    const incidents = store.tasks(chief.id).find((candidate) => candidate.title === INCIDENTS_THREAD_TITLE && !candidate.archivedAt)
      ?? store.createTask(chief.id, INCIDENTS_THREAD_TITLE, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() });
    if (!incidents || incidents.threadId === threadId) {
      tellThePerson();
      return;
    }
    store.appendMessage(incidents.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: incidentChip(incident), ok: false },
      threadRef: { botId: bot.id, threadId, title: task?.title ?? (group ? group.name : `${bot.name}'s conversation`) },
    });
    const text = incidentText(incident, count);
    // the report carries the broken bot's name as its provenance: it is about
    // that bot's work and nobody was at the keyboard
    const peerAsk = { botId: bot.id, name: bot.name, unattended: true };
    if (botAtThreadCapacity(chief.id) || activeGroupTurnForBot(chief.id)) {
      queueSteeredMessage(chief.id, incidents.threadId, text, { reason: "capacity", unattended: true, peerAsk });
      return;
    }
    void startTurn(chief.id, text, { threadId: incidents.threadId, unattended: true, peerAsk }).catch((error) => {
      const why = error instanceof Error ? error.message : String(error);
      store.appendMessage(incidents.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: the incident could not reach ${chief.name} — ${why.slice(0, 120)}`, ok: false },
      });
      tellThePerson();
    });
  }

  function drainDelegationWakes(): void {
    for (const [threadId, entry] of pendingDelegationWakes) {
      if (!store.taskByThread(entry.botId, threadId) || !routineDelegationCanResume(threadId, entry.routineRunId)) {
        pendingDelegationWakes.delete(threadId);
        continue;
      }
      if (threadBusy(entry.botId, threadId) || activeGroupTurnForBot(entry.botId)) continue;
      pendingDelegationWakes.delete(threadId);
      dispatchDelegationWake(entry.botId, threadId, entry.targetName, entry.failureReason, entry.routineRunId, entry.budgetAcquired);
    }
  }

  function wakeUndispatchedDelegation(receipt: DelegationReceipt, routineRunId?: string): void {
    const source = store.botByThread(receipt.sourceThreadId);
    if (!source) return;
    markTaskContextExternallyUpdated(source, receipt.sourceThreadId);
    wakeDelegationSource(source, receipt.sourceThreadId, receipt.toBotName, receipt.result || "the handoff did not run", routineRunId);
  }

  // Provider-native sessions only know about messages produced inside their
  // own turns. A delegated result is appended later by the harness, so mark the
  // source task with a persisted, impossible-to-resume owner. Its next turn
  // will replay the active branch once before replacing this marker with the
  // real provider instance id. A unique suffix also closes the setup race: if
  // another result arrives while that replay is launching, the newer marker is
  // left intact for one more replay instead of being accidentally consumed.
  const EXTERNAL_CONTEXT_MARKER_PREFIX = "__openmaus_external_context__:";

  function isExternalContextMarker(value: string | undefined): boolean {
    return Boolean(value?.startsWith(EXTERNAL_CONTEXT_MARKER_PREFIX));
  }

  function markTaskContextExternallyUpdated(bot: BotRecord, threadId: string): void {
    const task = store.taskByThread(bot.id, threadId);
    if (!task) return;
    // An engine that records which messages its current session was handed
    // keeps that session: its next turn is sent what it has not seen. Without a
    // record for that exact session (another engine, one switched in since, a
    // replaced session, or a task from before records existed) the next turn
    // replays once, as before.
    const owner = task.lastInstanceId;
    const record = owner ? task.handedMessages?.[owner] : undefined;
    if (owner && record?.session !== undefined && record.session === task.resumeCursors[owner] &&
      turnInstance(botForThread(bot.id, threadId) ?? bot, undefined, threadId)?.instanceId === owner &&
      registry.get(owner)?.adapter.capabilities.strictResume) {
      store.patchTask(bot.id, threadId, { unread: true });
      return;
    }
    store.patchTask(bot.id, threadId, {
      resumeCursors: {},
      lastInstanceId: `${EXTERNAL_CONTEXT_MARKER_PREFIX}${randomUUID()}`,
      unread: true,
    });
  }

  /** Active-branch messages a provider reads as conversation context. */
  function isContextMessage(m: Message): boolean {
    return Boolean((m.kind === "text" && m.text) || m.roomRequest?.phase === "result");
  }

  const handoffs = new Handoffs({
    order: (threadId) => store.activePath(threadId).filter(isContextMessage).map((m) => m.id),
    read: (botId, threadId, instanceId) => store.taskByThread(botId, threadId)?.handedMessages?.[instanceId],
    write: (botId, threadId, instanceId, state) => store.setHandedMessages(botId, threadId, instanceId, state),
    replies: (threadId, turnId) => store.activePath(threadId)
      .filter((m) => m.role === "bot" && m.kind === "text" && !m.from && m.turnId === turnId).map((m) => m.id),
  });

  /** Consume one delegated-turn watch and mirror exactly one terminal state.
   * Some harness paths settle a busy bot without a provider turn.completed
   * event, so they call this same finalizer explicitly. */
  function finalizeDelegationWatch(
    threadId: string,
    ok: boolean,
    reply = "",
    failureName = "Delegated turn did not finish",
  ): boolean {
    const watched = delegationWatch.get(threadId);
    if (!watched) return false;
    delegationWatch.delete(threadId);
    const target = store.bot(watched.toBotId);
    const targetName = target?.name ?? watched.toBotName ?? watched.toBotId;
    const source = watched.sourceBotId
      ? store.bot(watched.sourceBotId)
      : (watched.sourceThreadId ? store.botByThread(watched.sourceThreadId) : undefined);
    if (source && target && !canReachPeer(source, target)) {
      ok = false;
      reply = "";
      failureName = "Result withheld: team or peer access changed while the teammate was working";
    }
    // The receipt is written before any mirror short-circuits: the delegating
    // bot's check/wait_delegation must see a terminal state even when the
    // channel or target is gone.
    if (watched.taskId && watched.sourceThreadId) {
      recordDelegationReceipt({
        id: watched.taskId,
        sourceThreadId: watched.sourceThreadId,
        toBotId: watched.toBotId,
        toBotName: store.bot(watched.toBotId)?.name ?? watched.toBotId,
        status: ok ? "done" : "failed",
        result: ok ? reply : failureName,
      });
    }
    let channel: GroupRecord | undefined = watched.channelId ? store.group(watched.channelId) : undefined;
    let terminalThreadId: string | undefined = watched.sourceThreadId;

    if (source && watched.sourceThreadId) {
      const sourceGroup = store.groupByThread(watched.sourceThreadId);
      if (sourceGroup) {
        // Shared-channel (or DM) source: revalidate membership, since a roster
        // change while the target ran must not force a result into a group
        // that no longer contains both bots.
        const sourceStillMember = sourceGroup.memberIds.includes(source.id);
        const targetStillMember = target ? sourceGroup.memberIds.includes(target.id) : false;
        if (!sourceStillMember || !targetStillMember) {
          if (target) {
            channel = getOrCreateChannel(store, source, target);
            terminalThreadId = channel.threadId;
          } else {
            // Target is gone: the source may still see the original group, but
            // there is no peer to share a DM with. Keep the group for source.
            terminalThreadId = sourceStillMember ? watched.sourceThreadId : undefined;
            channel = undefined;
          }
        }
        if (terminalThreadId) {
          if (ok && reply.trim()) {
            const sourceReply: Omit<Message, "id" | "at"> = {
              role: "bot",
              kind: "text",
              text: `@${targetName} replied to the delegated task:\n\n${reply.trim()}`,
            };
            if (target) sourceReply.from = { botId: target.id, name: target.name, color: target.color };
            store.appendMessage(terminalThreadId, sourceReply);
          } else {
            store.appendMessage(terminalThreadId, {
              role: "bot",
              kind: "activity",
              tool: {
                name: ok
                  ? `Delegation to @${targetName} completed without a text reply`
                  : `Delegation to @${targetName} failed — ${failureName}`,
                ok,
              },
            });
          }
          if (channel && terminalThreadId === channel.threadId && !channel.dm) {
            store.patchGroup(channel.id, { unread: true });
          }
        }
        // Group/DM sources do not have a single direct task to mark or wake.
        // The delegated result is already in the shared transcript; a group
        // continuation is the responsibility of the room's own turn engine.
      } else if (store.taskByThread(source.id, watched.sourceThreadId)) {
        // 1:1 source: the source thread is the delegating bot's own task.
        if (ok && reply.trim()) {
          const sourceReply: Omit<Message, "id" | "at"> = {
            role: "bot",
            kind: "text",
            text: `@${targetName} replied to the delegated task:\n\n${reply.trim()}`,
          };
          if (target) sourceReply.from = { botId: target.id, name: target.name, color: target.color };
          store.appendMessage(watched.sourceThreadId, sourceReply);
        } else {
          store.appendMessage(watched.sourceThreadId, {
            role: "bot",
            kind: "activity",
            tool: {
              name: ok
                ? `Delegation to @${targetName} completed without a text reply`
                : `Delegation to @${targetName} failed — ${failureName}`,
              ok,
            },
          });
        }
        markTaskContextExternallyUpdated(source, watched.sourceThreadId);
        // Peer wake: a settled delegated turn resumes the source bot so it
        // folds the result in and answers the user, instead of sitting idle
        // with the reply only visible in the thread (the "delegated and went
        // silent" gap). Failures wake it too — the user must hear the task did
        // not finish. Idle-checked and burst-capped so a busy source or a
        // re-delegating loop cannot spin up runs.
        if (ok) {
          wakeDelegationSource(source, watched.sourceThreadId, targetName, undefined, watched.routineRunId);
        } else if (!ok) {
          wakeDelegationSource(source, watched.sourceThreadId, targetName, failureName || "the delegated turn did not finish", watched.routineRunId);
        }
      }
    }

    if (target && channel) {
      if (ok && reply.trim()) mirrorReply(commsBus(), target, reply, channel);
      else if (ok) mirrorActivity(commsBus(), target, channel, "Delegated turn completed", true);
      else mirrorActivity(commsBus(), target, channel, failureName, false);
    }
    return true;
  }

  return {
    directFollowupTurns,
    directFollowupSettlers,
    directCoordinationSettlers,
    settleDirectCoordination,
    settleDirectFollowup,
    delegationWatch,
    delegationWakeBudget,
    pendingDelegationWakes,
    activeRoutineRunForThread,
    wakeUndispatchedDelegation,
    drainDelegationWakes,
    finalizeDelegationWatch,
    isExternalContextMarker,
    markTaskContextExternallyUpdated,
    reportIncident,
    handoffs,
    isContextMessage,
  };
}
