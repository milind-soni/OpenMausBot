// The store's reducer: AppState, the reducer switch, and initialState.
// The Action union lives in action.ts, queue reconciliation in
// queue-receipts.ts, notification/thread routing in thread-routing.ts, and
// the per-domain case bodies under reducer/. No React and no I/O here —
// store.tsx owns the provider, effects, and API client, and re-exports the
// public surface.

import type { MausMotion } from "@/lib/mascot";
import type { Routine, RoutineRun } from "../../shared/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "../../shared/webhooks";
import type { Action } from "./action";
import { reconcileSnapshotQueues } from "./queue-receipts";
import type { OverlaysState } from "./overlays";
import type { Bot, ConfigStatus, Group, InstanceInfo, ModelVariantSession } from "./model";
import { reconcileModelVariantSessions, updateBot, withMascotMotion } from "./reducer/helpers";
import { reduceBots } from "./reducer/bots";
import { reduceGroups } from "./reducer/groups";
import { reduceHydrate } from "./reducer/hydrate";
import { reduceMessages } from "./reducer/messages";
import { reduceNavigation } from "./reducer/navigation";
import { reduceQueues } from "./reducer/queues";
import { reduceRoutines } from "./reducer/routines";
import { reduceWebhooks } from "./reducer/webhooks";

export interface AppState {
  bots: Bot[];
  groups: Group[];
  /** Persisted named teams; older servers omit this, so clients also derive labels. */
  sections?: string[];
  instances: InstanceInfo[];
  /** Session discoveries stay with their conversation and never enter persisted settings. */
  modelVariantSessions: Record<string, ModelVariantSession>;
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "team-map" | "routines";
  routines: Routine[];
  routineRuns: RoutineRun[];
  routinesLoadState: "loading" | "ready" | "error";
  routinesFocus: { section?: "schedule" | "logs"; view?: "calendar" | "list"; botId?: string; routineId?: string; nonce: number };
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  /** The modal/panel family: what is open (ordered) plus each overlay's
   *  remembered section. See OverlaysState. */
  overlays: OverlaysState;
  /** Creation continues even when the role picker is dismissed. */
  botCreationPending: boolean;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string; threadId?: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  /** Bot removals waiting for the server to verify that no persistent
   * computer would be orphaned. The bot stays visible until that succeeds. */
  deletingBots: Record<string, true>;
  /** who is driving each bot's computer: held = the person has the wheel
   * (the bot's hands are refused server-side); helpReason = the bot's open
   * plea for the person to take over */
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  /** a search hit to scroll to once its thread is on screen; nonce lets the
   * same message be focused twice in a row */
  focusMessage: { threadId: string; messageId: string; nonce: number; consumed: boolean } | null;
  connected: boolean;
  error: string | null;
  /** a quiet, non-error line above the transcript; clears itself */
  notice: { kind: "thread-gone"; botName: string | null } | null;
  /** a thread the person asked to open (chip or #Title link): the sidebar
   * expands its bot and scrolls the row into view once it is current */
  revealThread: { threadId: string; nonce: number } | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
  /** Queued follow-up lines waiting for drain; keyed by threadId.
   * Each entry is identified by the server queueId, not by text. */
  pendingQueued: Record<string, Array<{ queueId: string; text: string; reason?: "capacity" }>>;
  /** queueIds whose drain frame beat the POST continuation. One-shot and
   * bounded to a short event window so other clients cannot grow it forever. */
  consumedQueueIds: Record<string, true>;
  /** Frames arriving outside the visible thread, including the small gap
   * between a switch snapshot and its HTTP response. */
  backgroundThreadEvents: Record<string, Array<Extract<Action, { type: "messageAdded" | "messagePatched" | "threadActive" | "optimisticMessageRemoved" }>>>;
}

export { openOnboardingCard } from "./reducer/helpers";
export type { Action } from "./action";
export { openNotificationTarget, openThread, visibleNotificationThread } from "./thread-routing";
export type { ThreadTarget } from "./thread-routing";
export function pinBotThreadAction(action: Action, bots: Bot[]): Action {
  if (!("botId" in action) || ("threadId" in action && action.threadId) ||
      !["send", "interrupt", "editMessage", "switchBranch", "answerCard", "dismissCard", "cancelQueued", "steerQueued"].includes(action.type)) return action;
  const botId = action.botId;
  const threadId = bots.find((bot) => bot.id === botId)?.threadId;
  return { ...action, threadId } as Action;
}

export function reducer(state: AppState, action: Action): AppState {
  if (action.type === "messageAdded" || action.type === "messagePatched" || action.type === "threadActive" || action.type === "optimisticMessageRemoved") {
    const owner = state.bots.find((bot) => (bot.threadId !== action.threadId || bot.awaitingThreadSnapshot) && bot.tasks?.some((task) => task.threadId === action.threadId));
    if (owner) {
      // ponytail: a bounded race buffer, not a second transcript store. The
      // server supplies complete history whenever this thread is reopened.
      const frames = [...(state.backgroundThreadEvents[action.threadId] ?? []), action].slice(-256);
      return { ...state, backgroundThreadEvents: { ...state.backgroundThreadEvents, [action.threadId]: frames } };
    }
  }
  switch (action.type) {
    case "hydrate":
    case "sections":
    case "botQueues":
      return reduceHydrate(state, action);
    case "showRoutines":
    case "showChat":
    case "showTeamMap":
      return reduceNavigation(state, action);
    case "routinesHydrated":
    case "routinesLoadFailed":
    case "routinePatched":
    case "routineDeleted":
    case "routineRunPatched":
      return reduceRoutines(state, action);
    case "webhooksHydrated":
    case "webhookPatched":
    case "webhookDeleted":
    case "webhookAttempted":
      return reduceWebhooks(state, action);
    case "groupPatched":
    case "groupDeleted":
      return reduceGroups(state, action);
    case "instances":
    case "configStatus":
      return reduceHydrate(state, action);
    case "select":
      return reduceNavigation(state, action);
    case "answerCard":
    case "dismissCard":
      return reduceMessages(state, action);
    case "decideRequest":
      return state; // the server's request.resolved patch settles the card
    case "botAdded":
    case "deleteBot":
    case "botDeletionPending":
    case "markUnread":
      return reduceBots(state, action);
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      // Bot frames are complete except for their transcript. An unknown one
      // was created by another client (the phone, another app window, or a
      // team import), so add it now; the following message frames will fill
      // its greeting without waiting for a full-page hydration.
      if (!before) {
        const added = {
          ...state,
          bots: [{ ...action.bot, messages: action.bot.messages ?? [] }, ...state.bots],
        };
        return reconcileSnapshotQueues(added, [action.bot]);
      }
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const animated = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      const next = action.bot.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.bot.id || (b.section?.trim() || "") !== (action.bot.section?.trim() || "")
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const switchedThread =
        typeof action.bot.threadId === "string" && action.bot.threadId !== before.threadId &&
        !action.bot.tasks?.some((task) => task.threadId === before.threadId);
      // As with explicit navigation, the snapshot already includes events
      // buffered while its thread was in the background. Replay only races
      // after this switch begins, not older approval patches.
      let switching = next;
      if (switchedThread) {
        const { [action.bot.threadId]: _stale, ...otherThreadEvents } = next.backgroundThreadEvents;
        switching = { ...next, backgroundThreadEvents: otherThreadEvents };
      }
      if ((switchedThread || (before.awaitingThreadSnapshot && action.bot.threadId === before.threadId)) &&
          Array.isArray(action.bot.messages)) {
        // The slim deletion broadcast can arrive before the full snapshot.
        // Finish that switch once, replaying any events received in between.
        // Later duplicate HTTP snapshots must not overwrite newer messages.
        return reducer(switching, { type: "taskSwitched", bot: { ...before, ...action.bot, computer: action.bot.computer, section: action.bot.section, messages: action.bot.messages, browserProfile: action.bot.browserProfile } });
      }
      const patched = updateBot(switching, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        threadId: switchedThread ? action.bot.threadId : b.threadId,
        activeLeafId: switchedThread ? null : b.activeLeafId,
        awaitingThreadSnapshot: switchedThread || b.awaitingThreadSnapshot,
        // Complete bot frames omit this optional field after switching back
        // to Own browser (or deleting a shared profile). Do not retain the
        // previous profile's name and selection in another window.
        browserProfile: action.bot.browserProfile,
        // Resetting Works on to Auto removes the field from the complete
        // server frame; merging alone would keep the old target highlighted.
        computer: action.bot.computer,
        // A complete frame omits section after another client moves the bot
        // into General. Retaining the old label strands an empty team in UI.
        section: action.bot.section,
        // Clear immediately on deletion: old approvals must never be sent
        // to the replacement thread while waiting for its transcript.
        messages: switchedThread ? [] : b.messages,
      }));
      return reconcileModelVariantSessions(patched);
    }
    case "messageAdded":
    case "optimisticMessageRemoved":
    case "messagePatched":
      return reduceMessages(state, action);
    case "screenFrame":
    case "provisioning":
    case "computerControl":
    case "modelVariantRuntime":
      return reduceBots(state, action);
    case "setModel":
      if (action.threadId) return reducer(state, { type: "updateTask", botId: action.botId, threadId: action.threadId,
        patch: { modelSelection: action.selection, resetApprovalToAsk: action.resetApprovalToAsk } });
      return reconcileModelVariantSessions(updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection })));
    case "updateTask":
      return reduceBots(state, action);
    case "connected":
    case "error":
      return reduceHydrate(state, action);
    case "openOverlay":
    case "closeOverlay":
    case "closeAllOverlays":
      return reduceNavigation(state, action);
    case "botCreationPending":
      return { ...state, botCreationPending: action.on };
    case "notice":
    case "revealThread":
    case "focusMessage":
    case "focusMessageConsumed":
      return reduceNavigation(state, action);
    case "updateBot":
    case "threadActive":
    case "switchBranch":
      return reduceBots(state, action);
    case "patchGroup":
      return reduceGroups(state, action);
    case "pendingQueued":
    case "consumePendingQueued":
    case "cancelQueued":
      return reduceQueues(state, action);
    case "steerQueued":
      // API-only: the effect folds in messageAdded/consumePendingQueued on
      // success, so the chips clear exactly when the words truly landed.
      return state;
    case "cancelGroupQueued":
      return reduceQueues(state, action);
    case "send":
    case "editMessage":
      return reduceMessages(state, action);
    case "deleteTask":
    case "newGroupTask":
    case "switchGroupTask":
    case "deleteGroupTask":
      return state;
    case "newTask":
    case "switchTask":
      return reduceNavigation(state, action);
    case "renameTask":
      return reduceBots(state, action);
    case "renameGroupTask":
      return reduceGroups(state, action);
    case "taskSwitched": {
      let switched = updateBot(state, action.bot.id, (bot) => ({
        ...bot,
        ...action.bot,
        computer: action.bot.computer,
        messages: action.bot.messages ?? [],
        awaitingThreadSnapshot: false,
      }));
      for (const frame of state.backgroundThreadEvents[action.bot.threadId] ?? []) switched = reducer(switched, frame);
      const { [action.bot.threadId]: _settled, ...backgroundThreadEvents } = switched.backgroundThreadEvents;
      switched = { ...switched, backgroundThreadEvents };
      return reconcileModelVariantSessions(reconcileSnapshotQueues(switched, [action.bot]));
    }
    case "newBot":
    case "duplicateBot":
    case "createProject":
    case "updateProject":
    case "deleteProject":
    case "reorderProjects":
    case "interrupt":
    case "createGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "steerGroupQueued":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "markRoutineRunSeen":
      return state;
    case "sendGroup":
      return reduceGroups(state, action);
  }
}

export const initialState: AppState = {
  modelVariantSessions: {},
  backgroundThreadEvents: {},
  bots: [],
  groups: [],
  sections: [],
  instances: [],
  config: null,
  selectedId: "",
  activeView: "chat",
  routines: [],
  routineRuns: [],
  routinesLoadState: "loading",
  routinesFocus: { nonce: 0 },
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  overlays: {
    open: [],
    pluginsSurface: "apps",
    appSettingsSection: "general",
    botSettingsSection: "overview",
    botSettingsExpandAccordion: false,
  },
  botCreationPending: false,
  screens: {},
  provisioning: {},
  deletingBots: {},
  computerControl: {},
  focusMessage: null,
  connected: false,
  error: null,
  notice: null,
  revealThread: null,
  mascotMotion: null,
  pendingQueued: {},
  consumedQueueIds: {},
};
