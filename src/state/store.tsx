// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { reviewedSkillSha256, skillRequestBehavior } from "../../shared/skill-request";
import { answerResponse, dismissResponse } from "@/lib/card-answer";
import { t } from "@/lib/i18n";
import { createBotPatchQueue, type BotPatchQueue } from "./bot-patch-queue";
import { clearThreadStream, createStreamDeltaBuffer, EMPTY_STREAM, mergeStreamDeltas, StreamContext, type StreamState } from "./stream-context";
import { currentTaskBot } from "./model";
import type { Bot, BotAnnouncement, Group, OptionCardData } from "./model";
import { initialState, openOnboardingCard, pinBotThreadAction, reducer } from "./reducer";
import type { Action, AppState } from "./reducer";
import { api, createBotWithRole, persistBotUpdate, persistTaskApproval, requestConfirmedBotDeletion } from "./api";
import { createTaskWriteQueue } from "./task-writes";
import { usePeripheralSync } from "./peripheral-sync";

// Wave 4 split: the overlays slice and the stream context now live in their
// own modules. Wave 5 moves the domain model to model.ts and the reducer
// machinery to reducer.ts. Wave 6 moves the provider-independent API client
// to api.ts. All re-exported here so the store's public API stays unchanged.
export { overlayOpen } from "./overlays";
export type { OverlayKind, OverlaySection, OverlaysState } from "./overlays";
export { createStreamDeltaBuffer, useStreaming } from "./stream-context";
export { configStatusFromFrame, currentTaskBot, messageVersions, visibleMessages } from "./model";
export type { AppSettingsSection, Bot, BotAnnouncement, BotProject, BotSettingsSection, BrowserEngineSummary, BrowserProfile, ConfigStatus, ConfigStatusFrame, ConnectorCardData, EngineInstall, Group, GroupDefaultResponder, GroupTask, InstanceInfo, Message, ModelSelection, ModelVariantSession, OptionCardData, ProjectUpdatePatch, SecretRequestCardData, Task, TaskUpdatePatch, TaskUsage, ThreadCloser, ThreadOpener } from "./model";
export { initialState, openNotificationTarget, openThread, pinBotThreadAction, reducer, visibleNotificationThread } from "./reducer";
export type { Action, AppState, ThreadTarget } from "./reducer";
export type { MausColor } from "@/lib/mascot";
export type { RoutineRunCardData } from "../../shared/routine-run";
export { ApiError, api, createBotWithRole, loadSnapshotBoundary, persistBotUpdate, persistTaskApproval, requestConfirmedBotDeletion } from "./api";
export type { PeripheralSnapshotLoad } from "./api";

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Commit any debounced profile edits before an operation reads the bot. */
  flushBotPatches: (botId: string) => Promise<BotAnnouncement | null>;
  /** Re-fetch engine availability — after an install, without a restart. */
  refreshInstances: () => Promise<void>;
  /** Explicit provider/network model discovery. */
  refreshModels: (instanceId: string) => Promise<void>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const deltaBuffer = useMemo(() => createStreamDeltaBuffer((entries) => {
    setStream((prev) => mergeStreamDeltas(prev, entries));
  }), []);
  const flushDeltas = deltaBuffer.flush;
  const clearStream = (threadId: string) => {
    // Drop the thread's un-flushed deltas too: the settled message that
    // triggered this clear already contains them. Without this, the pending
    // rAF re-creates a "ghost" stream bubble holding the tail fragment —
    // it renders below any card/chip that settled next (so a permission
    // card looks glued to the top), keeps the caret blinking while the bot
    // is actually waiting, and the next block's deltas append onto the
    // duplicated tail instead of starting a fresh bubble.
    deltaBuffer.clear(threadId);
    setStream((prev) => clearThreadStream(prev, threadId));
  };

  // The task-write queue is created before the bot-patch queue because its
  // overlay feeds the patch queue's fold-back; the profile-lane flush it
  // needs in return is resolved through botLaneRef at call time, so neither
  // factory has to be constructed after the other.
  const botLaneRef = useRef<BotPatchQueue | null>(null);
  const taskWrites = useMemo(
    () =>
      createTaskWriteQueue({
        send: (botId, threadId, patch) => {
          // The private path is required for Custom; use it for every
          // confirmed desktop switch so optimistic Ask cannot hide the
          // original mode while a pending write waits its turn.
          if (patch.resetApprovalToAsk && window.ogb?.approvals) {
            return window.ogb.approvals.setMode(botId, "ask", {
              threadId, modelSelection: patch.modelSelection, updateBotDefault: Boolean(patch.updateBotDefault),
            });
          }
          return persistTaskApproval(botId, threadId, patch, window.ogb?.approvals);
        },
        reconcile: async (botId) => {
          const result: { bots: BotAnnouncement[] } = await api("/api/bots");
          return result.bots.find((candidate) => candidate.id === botId) ?? null;
        },
        onAuthoritative: (bot) => {
          rawDispatch({ type: "botPatched", bot });
        },
        onError: (error) => {
          rawDispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
          setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
        },
        flushBotLane: (botId) => botLaneRef.current?.flush(botId) ?? Promise.resolve(null),
      }),
    [],
  );

  const botPatchQueue = useMemo(
    () =>
      createBotPatchQueue({
        send: (botId, patch, signal, currentBot) =>
          persistBotUpdate(botId, patch, signal, api, window.ogb?.approvals, currentBot),
        reconcile: async (botId, signal) => {
          const result: { bots: BotAnnouncement[] } = await api("/api/bots", { signal });
          return result.bots.find((candidate) => candidate.id === botId) ?? null;
        },
        onAuthoritative: (bot, optimisticOverlay) => {
          rawDispatch({ type: "botPatched", bot: taskWrites.overlayBot({ ...bot, ...optimisticOverlay }) });
        },
        onError: (error) => {
          rawDispatch({ type: "error", message: error.message });
          setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
        },
      }),
    [taskWrites],
  );
  botLaneRef.current = botPatchQueue;

  useEffect(() => {
    // StrictMode's dev probe runs this cleanup once against the same memoized
    // queue; revive undoes it so profile saves survive development mounts.
    botPatchQueue.revive();
    return () => botPatchQueue.dispose();
  }, [botPatchQueue]);

  useEffect(() => {
    taskWrites.revive();
    return () => taskWrites.dispose();
  }, [taskWrites]);

  const dispatch = useMemo(() => {
    const navigation = new Map<string, number>();
    let creatingBot = false;
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    /** Where a card action's message lives, and the card on it. A card asked
     * inside a room belongs to the room's list, never to one member's. */
    const cardTarget = (action: { botId: string; messageId: string; groupId?: string }) => {
      const host = action.groupId
        ? stateRef.current.groups.find((g) => g.id === action.groupId)
        : stateRef.current.bots.find((b) => b.id === action.botId);
      return { host, card: host?.messages.find((m) => m.id === action.messageId)?.card, inRoom: !!action.groupId };
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    /** Resolve every bot whose execution context belongs to this thread. A
     * direct chat may name an inactive task, while a channel request belongs
     * to every member that could be selected to run it. Capture the result
     * before the optimistic reducer runs so approval/model writes cannot race
     * a response that resumes (or starts) work. */
    const executionBotsForThread = (threadId: string): Bot[] => {
      const snapshot = stateRef.current;
      const botIds = new Set<string>();
      for (const bot of snapshot.bots) {
        if (bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId)) {
          botIds.add(bot.id);
        }
      }
      for (const group of snapshot.groups) {
        if (group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId)) {
          for (const memberId of group.memberIds) botIds.add(memberId);
        }
      }
      return snapshot.bots.filter((bot) => botIds.has(bot.id));
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      // Pin before any await or optimistic state change, including legacy
      // callers such as keyboard shortcuts and voice controls.
      action = pinBotThreadAction(action, stateRef.current.bots);
      if (action.type === "taskSwitched") action = { ...action, bot: taskWrites.overlayBot(action.bot) as Bot };
      if (action.type === "botPatched") action = { ...action, bot: taskWrites.overlayBot(action.bot) };
      // One identity drives the optimistic row, HTTP retry protection, and
      // canonical SSE reconciliation. Callers may omit it; the store may not.
      if ((action.type === "send" || action.type === "sendGroup") && !action.sendId) {
        action = { ...action, sendId: crypto.randomUUID() };
      }
      const botBeforeUpdate =
        action.type === "updateBot" || action.type === "setModel"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const botBeforeSend =
        action.type === "send"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const executionBotsBeforeAction = (() => {
        if (action.type === "editMessage" || action.type === "answerCard") {
          const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          return bot ? [bot] : [];
        }
        if (action.type === "decideRequest") {
          const bots = executionBotsForThread(action.threadId);
          if (!action.alwaysAllow || bots.some((bot) => bot.id === action.alwaysAllow?.botId)) {
            return bots;
          }
          const grantBot = stateRef.current.bots.find((bot) => bot.id === action.alwaysAllow?.botId);
          return grantBot ? [...bots, grantBot] : bots;
        }
        if (action.type === "sendGroup") {
          const memberIds = stateRef.current.groups.find((group) => group.id === action.groupId)?.memberIds ?? [];
          return stateRef.current.bots.filter((candidate) => memberIds.includes(candidate.id));
        }
        if (action.type === "runRoutine") {
          const routine = stateRef.current.routines.find((candidate) => candidate.id === action.routineId);
          if (!routine) return [];
          const ids = new Set([routine.botId]);
          if (routine.target === "room-goal" && routine.groupId) {
            const group = stateRef.current.groups.find((candidate) => candidate.id === routine.groupId);
            for (const memberId of group?.memberIds ?? []) ids.add(memberId);
          }
          return stateRef.current.bots.filter((candidate) => ids.has(candidate.id));
        }
        return [];
      })();
      const quizBeforeSend = (() => {
        if (action.type !== "send") return undefined;
        return botBeforeSend ? openOnboardingCard(botBeforeSend) : undefined;
      })();
      // A queued message is still real until the server confirms deletion.
      // Bot deletion is also server-authoritative: lifecycle guards may reject
      // it, and hiding the row first strands the computer the person must
      // remove. All other actions keep their existing optimistic behavior.
      if (
        action.type !== "cancelQueued" &&
        action.type !== "cancelGroupQueued" &&
        action.type !== "deleteBot"
      ) rawDispatch(action);
      switch (action.type) {
        case "notice":
          if (action.notice) setTimeout(() => rawDispatch({ type: "notice", notice: null }), 6000);
          break;
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          void taskWrites.waitForExecutionSettings(executionBotsBeforeAction)
            .then(() => api(`/api/routines/${action.routineId}/run`, { method: "POST" }))
            .then(({ run }) => action.onStarted?.(run))
            .catch((error) => {
              if (action.onError) action.onError(error);
              else showError(error);
            })
            .finally(() => action.onSettled?.());
          break;
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "markRoutineRunSeen":
          api(`/api/routine-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "cancelQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}`, { method: "DELETE", body: JSON.stringify({ threadId: action.threadId }) })
            .then(() => rawDispatch(action))
            .catch(showError);
          break;
        case "steerQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}/steer`, { method: "POST", body: JSON.stringify({ threadId: action.threadId }) })
            .then((body) => {
              if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
                for (const message of body.messages) {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message });
                }
                for (const queueId of body.queueIds ?? []) {
                  rawDispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
                }
              }
              action.onSettled?.();
            })
            .catch((error) => {
              showError(error);
              action.onError?.();
            });
          break;
        case "cancelGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => rawDispatch(action))
            .catch(showError);
          break;
        case "steerGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}/steer`, {
            method: "POST",
            body: JSON.stringify({ threadId: action.threadId }),
          })
            .then((body) => {
              if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
                for (const message of body.messages) {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message });
                }
                for (const queueId of body.queueIds ?? []) {
                  rawDispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
                }
              }
              action.onSettled?.();
            })
            .catch((error) => {
              showError(error);
              action.onError?.();
            });
          break;
        case "send": {
          // persist through the existing card route so an older server that
          // does not auto-dismiss still hides the quiz on this client
          if (quizBeforeSend) persistCard(action.botId, quizBeforeSend.id, { dismissed: true });
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void taskWrites.waitForExecutionSettings(botBeforeSend ? [botBeforeSend] : [], threadId)
            .then(() => api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.text, replyToId: action.replyToId, threadId, sendId }),
              }))
            .then((body) => {
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
              }
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "optimisticMessageRemoved",
                  threadId: body.threadId,
                  sendId,
                });
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                  reason: body.reason === "capacity" ? "capacity" : undefined,
                });
              }
            })
            .catch((error) => {
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId });
              }
              showError(error);
              action.onError?.();
            });
          break;
        }
        case "editMessage":
          void taskWrites.waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(() => api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
              method: "POST",
              body: JSON.stringify({ text: action.text, threadId: action.threadId }),
            }))
            .catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId, threadId: action.threadId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = () =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
                reviewedSha256: action.reviewedSha256,
                always: action.always,
              }),
            });
          void taskWrites.waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(async () => {
              if (action.alwaysAllow) {
                const bot = stateRef.current.bots.find((candidate) => candidate.id === action.alwaysAllow?.botId);
                const owner = bot?.tasks?.some((task) => task.threadId === action.threadId);
                const next = [...new Set([...(bot ? currentTaskBot(bot, action.threadId).alwaysAllow ?? [] : []), action.alwaysAllow.key])];
                // Save the grant BEFORE releasing the bot: it may ask again
                // within milliseconds. A failed preference save must still
                // let this one response through, but the person should see it.
                try {
                  await api(owner ? `/api/bots/${action.alwaysAllow.botId}/always-allow` : `/api/bots/${action.alwaysAllow.botId}`, {
                    method: owner ? "POST" : "PATCH",
                    body: JSON.stringify(owner ? { threadId: action.threadId, allowKey: action.alwaysAllow.key } : { alwaysAllow: next }),
                  });
                } catch (error) {
                  showError(error);
                }
              }
              const response = await respond();
              if (response?.settlementPending && typeof response.message === "string") {
                showError(new Error(response.message));
              }
            })
            .catch((error) => {
              // A settings flush failure deliberately stops the response;
              // otherwise it could resume work under a stale approval level.
              showError(error);
              action.onError?.(error instanceof Error ? error.message : String(error));
            });
          break;
        }
        case "answerCard": {
          const { host, card, inRoom } = cardTarget(action);
          void taskWrites.waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(() => {
              if (card?.requestId && host) {
                // allow/deny for a permission, the chosen text for a question
                // — decided from the card, never from the label (see
                // card-answer.ts). By THREAD, so a card raised inside a room
                // answers the same way a 1:1 one does.
                const response = card.skillRequest
                  ? { behavior: skillRequestBehavior(action.answer) }
                  : answerResponse(card, action.answer);
                return api(`/api/threads/${action.threadId ?? host.threadId}/respond`, {
                  method: "POST",
                  body: JSON.stringify({
                    requestId: card.requestId,
                    ...response,
                    reviewedSha256: response.behavior === "allow" && card.skillRequest
                      ? reviewedSkillSha256(card.skillRequest)
                      : undefined,
                  }),
                });
              }
              if (inRoom) return;
              persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
              return api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.answer, threadId: action.threadId }),
              });
            })
            .catch(showError);
          break;
        }
        case "dismissCard": {
          const { host, card, inRoom } = cardTarget(action);
          if (card?.requestId && host) {
            // a question is DECLINED rather than denied — the broker refuses
            // a deny on one (see card-answer.ts)
            api(`/api/threads/${action.threadId ?? host.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, ...dismissResponse(card) }),
            }).catch(() => {});
          } else if (!inRoom) {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot": {
          // The picker can close/remount before React paints pending state.
          if (creatingBot) break;
          creatingBot = true;
          rawDispatch({ type: "botCreationPending", on: true });
          void createBotWithRole(action.role)
            .then(({ bot, profileError }) => {
              rawDispatch({ type: "botAdded", bot });
              action.onCreated?.();
              if (profileError) {
                showError(t("newBot.profileFailed", { error: profileError }));
                rawDispatch({ type: "openOverlay", kind: "settings", open: true, section: "soul" });
              }
            })
            .catch((error) => {
              if (action.onError) action.onError(error instanceof Error ? error.message : String(error));
              else showError(error);
            })
            .finally(() => {
              creatingBot = false;
              rawDispatch({ type: "botCreationPending", on: false });
            });
          break;
        }
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const duplicateProfile = {
            name: `${source.name} copy`,
            title: source.title,
            description: source.description,
            soul: source.soul,
            notifications: source.notifications,
            modelSelection: source.modelSelection,
            computer: source.computer,
            cloudBackend: source.cloudBackend,
            autoStartVps: source.autoStartVps,
            avatarUrl: source.avatarUrl,
            avatarCrop: source.avatarCrop,
          };
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                // JSON.stringify omits undefined optional fields while preserving
                // an explicit null avatar clear, so duplication mirrors the source.
                body: JSON.stringify(duplicateProfile),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          rawDispatch({ type: "botDeletionPending", botId: action.botId, on: true });
          void requestConfirmedBotDeletion(
            action.botId,
            async (botId) => {
              // Preserve edits when lifecycle guards refuse deletion, while
              // preventing an older debounced PATCH from landing after a
              // successful DELETE.
              await botPatchQueue.flush(botId);
              return api(`/api/bots/${botId}`, { method: "DELETE" });
            },
            (botId) => {
              botPatchQueue.cancel(botId);
              rawDispatch({ type: "deleteBot", botId });
            },
          )
            .catch(showError)
            .finally(() => rawDispatch({ type: "botDeletionPending", botId: action.botId, on: false }));
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          const group = stateRef.current.groups.find((g) => g.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}/read`, { method: "POST", body: JSON.stringify({ threadId: bot.threadId }) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${action.id}/read`, { method: "POST" }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({
              memberIds: action.memberIds,
              name: action.name,
              section: action.section,
              ...(window.ogb?.remoteClient?.active
                ? { setup: { bulletin: "", defaultResponder: { kind: "mentions" } } }
                : {}),
            }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup": {
          const threadId =
            action.threadId ?? stateRef.current.groups.find((group) => group.id === action.groupId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void taskWrites.waitForExecutionSettings(executionBotsBeforeAction)
            .then(() => api(`/api/groups/${action.groupId}/messages`, {
              method: "POST",
              body: JSON.stringify({
                text: action.text,
                replyToId: action.replyToId,
                threadId,
                sendId,
                mode: action.mode ?? "chat",
              }),
            }))
            .then((body) => {
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
              }
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "optimisticMessageRemoved",
                  threadId: body.threadId,
                  sendId,
                });
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                });
              }
            })
            .catch((error) => {
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId });
              }
              showError(error);
              action.onError?.();
            });
          break;
        }
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "setModel":
          if (action.threadId) {
            taskWrites.persist(action.botId, action.threadId, {
              modelSelection: action.selection,
              ...(action.updateBotDefault ? { updateBotDefault: true } : {}),
              ...(action.resetApprovalToAsk ? { resetApprovalToAsk: true } : {}),
            });
            break;
          }
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(
              action.botId,
              { modelSelection: action.selection },
              botBeforeUpdate,
            );
          }
          break;
        case "updateTask":
          taskWrites.persist(action.botId, action.threadId, action.patch);
          break;
        case "createProject":
          api(`/api/bots/${action.botId}/projects`, { method: "POST", body: JSON.stringify({ name: action.name, emoji: action.emoji }) })
            .then(({ bot, project }) => {
              dispatch({ type: "botPatched", bot });
              action.onCreated?.(project);
            }).catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "updateProject":
          api(`/api/bots/${action.botId}/projects/${action.projectId}`, { method: "PATCH", body: JSON.stringify(action.patch) })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onSaved?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "deleteProject":
          api(`/api/bots/${action.botId}/projects/${action.projectId}`, { method: "DELETE" })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onDeleted?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "reorderProjects":
          api(`/api/bots/${action.botId}/projects/order`, { method: "PATCH", body: JSON.stringify({ projectIds: action.projectIds }) })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onSaved?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
          break;
        // tasks: the server answers with the bot AND the live transcript,
        // because switching changes which conversation is on screen
        case "newTask":
        case "switchTask": {
          const revision = (navigation.get(action.botId) ?? 0) + 1;
          navigation.set(action.botId, revision);
          const ready = action.type === "newTask"
            ? botPatchQueue.flush(action.botId)
            : Promise.resolve();
          void ready.then(() => api<{ bot: Bot }>(action.type === "newTask" ? `/api/bots/${action.botId}/tasks` : `/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "POST", body: JSON.stringify(action.type === "newTask" ? { projectId: action.projectId } : {}) }))
            .then((r) => {
              if (!r?.bot || navigation.get(action.botId) !== revision) return;
              dispatch({ type: "taskSwitched", bot: r.bot });
            })
            .catch(showError);
          break;
        }
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteTask":
          api<{ bot?: BotAnnouncement }>(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r) => r?.bot && dispatch({ type: "botPatched", bot: r.bot }))
            .catch(showError);
          break;
        // Channel tasks mirror bot tasks, but hydrate the whole channel so
        // switching atomically replaces its transcript, folder and pin.
        case "newGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks`, { method: "POST", body: "{}" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "switchGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "POST" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "renameGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
          break;
        case "updateBot": {
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, action.patch, botBeforeUpdate);
          }
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [botPatchQueue, taskWrites]);

  // ── initial load + SSE fold ──────────────────────────────────────────
  usePeripheralSync({
    rawDispatch,
    stateRef,
    dispatch,
    clearStream,
    deltaBuffer,
    flushDeltas,
    taskWrites,
    botPatchQueue,
  });

  // Re-probe the engines on demand. A CLI installed while the app is running
  // is invisible until something asks again — the setup screens expose this
  // as "Check again" so the user isn't told to restart when a refresh will do.
  const refreshInstances = useCallback(async () => {
    try {
      const { instances } = await api("/api/instances");
      rawDispatch({ type: "instances", instances });
    } catch {
      /* offline or server down — the existing list stays */
    }
  }, []);

  const refreshModels = useCallback(async (instanceId: string) => {
    const { instances } = await api(`/api/instances/${encodeURIComponent(instanceId)}/refresh-models`, {
      method: "POST",
    });
    rawDispatch({ type: "instances", instances });
  }, []);

  // Installing a CLI or signing one in happens in a terminal, outside this
  // window — so the moment the user comes back is exactly when our engine
  // snapshot is most likely stale. Re-probe on focus, throttled so that
  // ordinary alt-tabbing doesn't spawn a `--version` call per switch.
  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      void refreshInstances();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInstances]);

  const flushBotPatches = useCallback(
    (botId: string) => botPatchQueue.flush(botId),
    [botPatchQueue],
  );
  const value = useMemo(
    () => ({ state, dispatch, flushBotPatches, refreshInstances, refreshModels }),
    [state, dispatch, flushBotPatches, refreshInstances, refreshModels],
  );
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
