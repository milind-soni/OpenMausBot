import type { Dispatch } from "react";
import type { Action, AppState, Bot } from "./store";

/** A blank new chat with one bot: shown in place of its open conversation and made into one by the first send. */
export type NewChat = { session: number; botId: string; projectId?: string; held: HeldAction[] };
type HeldAction = Extract<Action, { type: "setModel" } | { type: "updateTask" }>;

const THREAD_PREFIX = "new-chat-";
export const newChatThreadId = (botId: string) => `${THREAD_PREFIX}${botId}`;
export const isNewChatThread = (threadId: unknown): threadId is string => typeof threadId === "string" && threadId.startsWith(THREAD_PREFIX);

const LEAVING = new Set<Action["type"]>(["select", "switchTask", "taskSwitched", "newGroupTask", "switchGroupTask", "showRoutines", "showTeamMap", "showFiles", "showWebPanel", "showPublishedApps", "showSkillBurgers", "showTeamFiles", "showAnnouncements"]);

/** The reducer's first step: `done` when the action belongs to the blank chat alone and the rest of the reducer must not
 * see it. */
export function reduceNewChat(state: AppState, action: Action): [state: AppState, done: boolean] {
  const open = state.newChat ?? null;
  if (action.type === "newTask" && action.cwd === undefined) {
    if (open?.botId !== action.botId) return [{ ...state, newChat: { session: action.blankChat ?? 0, botId: action.botId, projectId: action.projectId, held: [] } }, false];
    return [open.projectId === action.projectId ? state : { ...state, newChat: { ...open, projectId: action.projectId } }, false];
  }
  if ("threadId" in action && isNewChatThread(action.threadId)) {
    const held = open && action.threadId === newChatThreadId(open.botId) && (action.type === "setModel" || action.type === "updateTask");
    return [held ? { ...state, newChat: { ...open, held: [...open.held, action] } } : state, true];
  }
  if (open && LEAVING.has(action.type) && (action.type !== "taskSwitched" || action.bot.id === open.botId)) return [{ ...state, newChat: null }, false];
  return [state, false];
}

/** The bot as the chat draws it while its blank chat is open: no messages, not busy, the choices made so far. */
export function newChatBot(bot: Bot, open: NewChat | null | undefined): Bot {
  if (open?.botId !== bot.id) return bot;
  let shown: Bot = {
    ...bot, threadId: newChatThreadId(bot.id), messages: [], activeLeafId: null, hasMore: false, busy: false, activity: undefined,
    turnStartedAt: null, waitingForTeammates: false, pinnedMessageId: undefined, awaitingThreadSnapshot: false, switchingTo: undefined,
  };
  for (const held of open.held) {
    if (held.type === "setModel") shown = { ...shown, modelSelection: held.selection };
    else {
      const { modelSelection, approvalMode, autoApprove } = held.patch;
      shown = { ...shown, ...(modelSelection ? { modelSelection } : {}), ...(approvalMode ? { approvalMode } : {}), ...(autoApprove === undefined ? {} : { autoApprove }) };
    }
  }
  return shown;
}

type Effects = {
  state: () => AppState;
  rawDispatch: Dispatch<Action>;
  dispatch: Dispatch<Action>;
  create: (botId: string, projectId: string | undefined) => Promise<{ bot: Bot }>;
  navigated: (botId: string) => void;
  showError: (error: unknown) => void;
};

/** The store's effects for the blank chat, answering true for an action they took. While a bot's blank chat is open, a
 * send to the conversation it covers goes into the blank chat too. The first send makes the conversation, once per blank
 * chat however many arrive while it is being made, then each is sent into it. The conversation opens only if the person
 * is still in that blank chat when it is made. */
export function createNewChat(effects: Effects) {
  const making = new Map<number, Promise<string>>(), heldWhileMaking = new Map<number, HeldAction[]>();
  let sessions = 0;
  const make = (open: NewChat) => {
    heldWhileMaking.set(open.session, open.held);
    const made = effects.create(open.botId, open.projectId).then(({ bot }) => {
      const now = effects.state().newChat;
      if (now?.session === open.session && now.botId === open.botId) effects.dispatch({ type: "taskSwitched", bot });
      for (const held of heldWhileMaking.get(open.session) ?? open.held) effects.dispatch({ ...held, threadId: bot.threadId });
      return bot.threadId;
    });
    making.set(open.session, made);
    void made.finally(() => { making.delete(open.session); heldWhileMaking.delete(open.session); }).catch(() => {});
    return made;
  };
  return (action: Action): boolean => {
    if (action.type === "newTask" && action.cwd === undefined) {
      effects.navigated(action.botId);
      effects.rawDispatch({ ...action, blankChat: ++sessions });
      focusComposer();
      return true;
    }
    const state = effects.state(), open = state.newChat;
    const intoBlank = action.type === "send" && open?.botId === action.botId && action.threadId === state.bots.find((bot) => bot.id === action.botId)?.threadId;
    if (!intoBlank && !("threadId" in action && isNewChatThread(action.threadId))) return false;
    if (action.type !== "send") {
      effects.rawDispatch(action);
      const after = effects.state().newChat;
      if (after && heldWhileMaking.has(after.session)) heldWhileMaking.set(after.session, after.held);
      return true;
    }
    const made = open?.botId === action.botId ? making.get(open.session) ?? make(open) : null;
    if (!made) {
      action.onError?.();
      return true;
    }
    made.then((threadId) => effects.dispatch({ ...action, threadId }), (error: unknown) => {
      effects.showError(error);
      action.onError?.();
    });
    return true;
  };
}

function focusComposer() {
  if (typeof requestAnimationFrame !== "function" || window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('main[data-look="chat"] textarea')?.focus()));
}
