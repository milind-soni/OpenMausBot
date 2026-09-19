// Bot lifecycle, computer, and task cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceBots below.

import type { Action } from "../action";
import type { AppState } from "../reducer";
import { currentTaskBot, taskPatchFields } from "../model";
import { reconcileModelVariantSessions, updateBot, withMascotMotion } from "./helpers";

export type BotsAction = Extract<Action, { type: "renameTask" | "botAdded" | "deleteBot" | "botDeletionPending" | "markUnread" | "screenFrame" | "provisioning" | "computerControl" | "modelVariantRuntime" | "updateTask" | "updateBot" | "threadActive" | "switchBranch" }>;

export function reduceBots(state: AppState, action: BotsAction): AppState {
  switch (action.type) {
    case "botAdded":
      return withMascotMotion({
        ...state,
        // An HTTP create/import response and its SSE broadcast can race. Fold
        // both paths without ever showing the same bot twice.
        bots: [action.bot, ...state.bots.filter((bot) => bot.id !== action.bot.id)],
        activeView: "chat",
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      const { [action.botId]: _deleted, ...deletingBots } = state.deletingBots;
      return reconcileModelVariantSessions({ ...state, bots, selectedId, deletingBots });
    }
    case "botDeletionPending": {
      if (action.on) {
        if (state.deletingBots[action.botId]) return state;
        return { ...state, deletingBots: { ...state.deletingBots, [action.botId]: true } };
      }
      if (!state.deletingBots[action.botId]) return state;
      const { [action.botId]: _settled, ...deletingBots } = state.deletingBots;
      return { ...state, deletingBots };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime, threadId: action.threadId } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "computerControl":
      return {
        ...state,
        computerControl: {
          ...state.computerControl,
          [action.botId]: { held: action.held, helpReason: action.helpReason },
        },
      };
    case "modelVariantRuntime": {
      const event = action.event;
      if (!event.turnId) return state;
      const owner = state.bots.find((bot) => bot.threadId === event.threadId || bot.tasks?.some((task) => task.threadId === event.threadId));
      if (!owner) return state;
      const selection = currentTaskBot(owner, event.threadId).modelSelection;
      if (selection.instanceId !== event.providerInstanceId ||
          !state.instances.find((instance) => instance.instanceId === selection.instanceId)?.capabilities?.modelVariants) return state;
      const previous = state.modelVariantSessions[event.threadId];
      if (event.type === "turn.started") {
        if (previous && (previous.turnId === event.turnId || Date.parse(previous.startedAt) > Date.parse(event.createdAt))) return state;
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: {
          instanceId: selection.instanceId, model: selection.model, turnId: event.turnId, startedAt: event.createdAt, acceptingUpdates: true,
        } } };
      }
      if (!previous?.acceptingUpdates || previous.turnId !== event.turnId || previous.instanceId !== selection.instanceId || previous.model !== selection.model) return state;
      if (event.type === "session.model-variants" && event.model === selection.model) {
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: { ...previous, variants: event.variants } } };
      }
      if (event.type === "turn.completed") {
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: { ...previous, acceptingUpdates: false } } };
      }
      return state;
    }
    case "updateTask": {
      const patch = taskPatchFields(action.patch);
      return reconcileModelVariantSessions(updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? [{ threadId: bot.threadId, title: "New thread", createdAt: Date.now() }]).map((task) =>
          task.threadId === action.threadId ? { ...task, ...patch } : task),
      })));
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const target = animated.bots.find((bot) => bot.id === action.botId);
      const chiefSection = (action.patch.section ?? target?.section)?.trim() || "";
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId || (b.section?.trim() || "") !== chiefSection
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const {
        acknowledgeLocalAuto: _localAck,
        confirmFullAccess: _fullConfirmation,
        computer,
        ...rest
      } = action.patch;
      const botPatch = computer === null
        ? { ...rest, computer: undefined }
        : computer === undefined
          ? rest
          : { ...rest, computer };
      return updateBot(next, action.botId, (b) => ({ ...b, ...botPatch }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    case "renameTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) =>
          task.threadId === action.threadId ? { ...task, title: action.title } : task,
        ),
      }));
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(state, action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
  }
  return action satisfies never;
}
