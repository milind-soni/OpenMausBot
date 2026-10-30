// "Switch AI" on the first-reply rescue, as one scoped intent: { bot, thread, turn } and the picker it opens (the bot
// panel's in Simple mode, the chat header's in Advanced). Only that picker takes it. While it holds the intent it opens
// even though the turn runs, and nothing happens to the turn until the person picks another AI: then that exact turn
// is stopped, and once the chat has gone idle the new AI is set (wherever the person is by then). The same message is
// sent again on it only while the row is still on screen, the message is still the conversation's last word from the
// person, no other turn has run since, and a resend would carry all of it; otherwise Retry stays theirs to press.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { api } from "@/state/api";
import type { Action, Bot, Message } from "@/state/store";
import { turnStartCount } from "./stop-turn";

/** How long the chat must stay idle before the switch lands: a queued message starts its turn right after the stop. */
export const AI_SWITCH_SETTLE_MS = 500;

export interface AiSwitchIntent {
  botId: string;
  threadId: string;
  turnId: string;
  /** The person's message the turn answers: what is sent again on the new AI. */
  requestMessageId?: string;
  place: "panel" | "header";
}

type SetModel = Extract<Action, { type: "setModel" }>;
/** `opened`: its picker has opened for it once; a picker that mounts again does not open again. */
type Held = AiSwitchIntent & { nonce: number; opened: boolean };
/** A pick waiting for its turn to end: `stopped` is null until the Stop is answered, false when the turn was over.
 * `starts`: how many turns this client had seen start in the thread when the pick was made. `refused`: how many
 * times the server said the chat was working when the switch landed (a turn began just before it). */
type Pending = { intent: Held; action: SetModel; stopped: boolean | null; starts: number; refused: number; version?: number };

/** After this many refusals the switch gives up and says why. */
const MAX_REFUSALS = 8;

let intent: Held | null = null;
/** One pick per conversation: a pick in another chat never replaces this one. Replaced, never mutated, on change. */
let pending: ReadonlyMap<string, Pending> = new Map();
let version = 0;
const pendingKey = (held: { botId: string; threadId: string }) => `${held.botId}\n${held.threadId}`;
const setPending = (key: string, next: Pending | null) => {
  const map = new Map(pending);
  if (next) map.set(key, { ...next, version: ++version });
  else map.delete(key);
  pending = map;
  notify();
};
let nonce = 0;
const rowsOnScreen = new Set<string>();
const watchers = new Set<() => void>();
const notify = () => { for (const watch of Array.from(watchers)) watch(); };
const subscribe = (watch: () => void) => {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
};
const rowKey = (match: { threadId: string; turnId: string }) => `${match.threadId}\n${match.turnId}`;

/** A pick already made keeps going: a new intent only replaces the one waiting for a pick. */
export function requestAiSwitch(next: AiSwitchIntent): void {
  intent = { ...next, nonce: ++nonce, opened: false };
  notify();
}

/** The row's turn is no longer the one running, or the row is gone: its picker goes back to waiting for whatever
 * runs. A pick already made keeps going. */
export function releaseAiSwitchIntent(match: { threadId: string; turnId: string }): void {
  if (!intent || intent.threadId !== match.threadId || intent.turnId !== match.turnId) return;
  intent = null;
  notify();
}

/** Tests only: no intent, no pick, no rows. */
export function resetAiSwitch(): void {
  intent = null;
  pending = new Map();
  rowsOnScreen.clear();
  notify();
}

const sameAi = (a: SetModel["selection"], b: SetModel["selection"]) => a.instanceId === b.instanceId && a.model === b.model;

function beginSwitch(held: Held, action: SetModel, showError: (message: string) => void): void {
  intent = null;
  const key = pendingKey(held);
  const starts = turnStartCount(held.threadId);
  setPending(key, { intent: held, action, stopped: null, starts, refused: 0 });
  const mine = () => pending.get(key)?.intent === held;
  // The Stop names the row's turn: if another turn runs by now, the server stops nothing.
  api(`/api/bots/${held.botId}/interrupt`, { method: "POST", body: JSON.stringify({ threadId: held.threadId, turnId: held.turnId }) })
    .then((result: { outcome?: unknown } | null) => {
      if (mine()) setPending(key, { intent: held, action, stopped: result?.outcome !== "already-stopped", starts, refused: 0 });
    })
    .catch((error: unknown) => {
      if (mine()) setPending(key, null);
      showError(error instanceof Error ? error.message : String(error));
    });
}

/** For a model picker: the bot and dispatch it should use. Holding the intent, it opens once, opens while the turn
 * runs, and hands a pick of another AI to the switch instead of the store. */
export function useAiSwitch(input: {
  bot: Bot;
  threadId: string | undefined;
  contained: boolean;
  dispatch: (action: Action) => void;
  setOpen: (open: boolean) => void;
}): { bot: Bot; dispatch: (action: Action) => void } {
  const { bot, threadId, contained, dispatch, setOpen } = input;
  const current = useSyncExternalStore(subscribe, () => intent, () => null);
  const mine = current && current.botId === bot.id && current.threadId === threadId
    && current.place === (contained ? "panel" : "header") ? current : null;
  useEffect(() => {
    if (!mine || mine.opened) return;
    mine.opened = true;
    setOpen(true);
  }, [mine, setOpen]);
  return useMemo(() => {
    if (!mine) return { bot, dispatch };
    const busy = Boolean(bot.busy);
    return {
      bot: busy ? { ...bot, busy: false } : bot,
      dispatch: (action: Action) => {
        const ours = action.type === "setModel" && action.botId === mine.botId && (action.threadId ?? bot.threadId) === mine.threadId;
        const switching = ours && !sameAi(action.selection, bot.modelSelection);
        if (switching && busy) beginSwitch(mine, action, (message) => dispatch({ type: "error", message }));
        // The same AI mid-turn (a thinking level, say): the server refuses any change until the turn ends.
        else if (ours && busy) return;
        else dispatch(action);
        // The turn ended before the pick: an ordinary switch, and the picker is ordinary again.
        if (switching && !busy) releaseAiSwitchIntent(mine);
      },
    };
  }, [mine, bot, dispatch]);
}

/** For the rescue row: says it is on screen (what a resend needs), and gives up the intent once its turn is no longer
 * the one running or the row goes. */
export function useAiSwitchRow(input: { threadId: string; turnId: string; live: boolean }): void {
  const { threadId, turnId, live } = input;
  useEffect(() => {
    const key = rowKey({ threadId, turnId });
    rowsOnScreen.add(key);
    return () => {
      rowsOnScreen.delete(key);
      releaseAiSwitchIntent({ threadId, turnId });
    };
  }, [threadId, turnId]);
  useEffect(() => {
    if (!live) releaseAiSwitchIntent({ threadId, turnId });
  }, [live, threadId, turnId]);
}

const threadBusy = (bot: Bot | undefined, threadId: string) => {
  const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
  return task ? Boolean(task.busy) : Boolean(bot && bot.threadId === threadId && bot.busy);
};

/** What is sent again, or nothing: the request must still be the person's last word in the conversation on screen,
 * and all of it must ride in its words (images and files do, as tags). */
function resendable(waiting: Pending, bot: Bot | undefined): Message | undefined {
  const { threadId, turnId, requestMessageId } = waiting.intent;
  if (!waiting.stopped || !requestMessageId || !bot || bot.threadId !== threadId) return undefined;
  if (!rowsOnScreen.has(rowKey({ threadId, turnId })) || turnStartCount(threadId) !== waiting.starts) return undefined;
  const last = bot.messages.findLast((message) => message.role === "user");
  if (!last || last.id !== requestMessageId || last.kind !== "text" || !last.text?.trim()) return undefined;
  // The wire carries a data-context row on the message even where this client's type leaves it out.
  const { dataContext } = last as Message & { dataContext?: unknown };
  const carried = !last.attachments?.length && !last.pointed?.length && !dataContext && !last.fromApp && last.via !== "call";
  return carried ? last : undefined;
}

/** Saves the new AI on the conversation the way the store does, so the keeper hears whether the server took it. */
async function saveSwitch(action: SetModel): Promise<unknown> {
  const threadId = action.threadId!;
  const { selection: modelSelection, updateBotDefault, resetApprovalToAsk } = action;
  if (resetApprovalToAsk && window.ogb?.approvals) {
    return window.ogb.approvals.setMode(action.botId, "ask", { threadId, modelSelection, updateBotDefault: Boolean(updateBotDefault) });
  }
  const body = { modelSelection, ...(updateBotDefault ? { updateBotDefault: true } : {}), ...(resetApprovalToAsk ? { resetApprovalToAsk: true } : {}) };
  const result = await api(`/api/bots/${action.botId}/tasks/${threadId}`, { method: "PATCH", body: JSON.stringify(body) }) as { bot?: unknown } | null;
  return result?.bot;
}

/** The server refuses a model change while the conversation works: a turn began just before the switch landed. */
const refusedAsWorking = (error: unknown) =>
  (error as { status?: unknown } | null)?.status === 409 && /\b(?:working|running)\b/i.test(error instanceof Error ? error.message : "");

/** For the app shell, always mounted: once a stopped turn's chat has stayed idle, sets the new AI, and sends the same
 * message again when it still can. A refusal because a turn began just before keeps the switch for the next idle. */
export function useAiSwitchKeeper(input: { bots: readonly Bot[]; dispatch: (action: Action) => void }): void {
  const { bots, dispatch } = input;
  const waiting = useSyncExternalStore(subscribe, () => pending, () => pending);
  const latest = useRef({ bots, dispatch });
  latest.current = { bots, dispatch };
  const botOf = (entry: Pending) => latest.current.bots.find((candidate) => candidate.id === entry.intent.botId);
  // Only what decides the wait: each pick, its Stop's answer and its refusals, and whether its chat works.
  const ready = Array.from(waiting, ([key, entry]) => ({ key, entry, busy: threadBusy(bots.find((candidate) => candidate.id === entry.intent.botId), entry.intent.threadId) }))
    .filter(({ entry, busy }) => entry.stopped !== null && !busy);
  const signature = ready.map(({ key, entry }) => `${key}\t${entry.version}`).join("\n");
  // One wait per pick, kept across renders: a pick landing or a new one elsewhere never restarts another's wait.
  const timers = useRef(new Map<string, { version: number | undefined; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    const land = (key: string, entry: Pending) => {
      if (pending.get(key) !== entry) return;
      const bot = botOf(entry);
      if (threadBusy(bot, entry.intent.threadId)) return;
      const again = resendable(entry, bot);
      void saveSwitch(entry.action).then((saved) => {
        if (pending.get(key) !== entry) return;
        setPending(key, null);
        if (saved) latest.current.dispatch({ type: "botPatched", bot: saved as never });
        if (again?.text) latest.current.dispatch({ type: "editMessage", botId: entry.intent.botId, threadId: entry.intent.threadId, messageId: again.id, text: again.text });
      }, (error: unknown) => {
        if (pending.get(key) !== entry) return;
        if (refusedAsWorking(error) && entry.refused + 1 < MAX_REFUSALS) {
          setPending(key, { ...entry, refused: entry.refused + 1 });
          return;
        }
        setPending(key, null);
        latest.current.dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    };
    const keep = new Set<string>();
    for (const { key, entry } of ready) {
      keep.add(key);
      const held = timers.current.get(key);
      if (held?.version === entry.version) continue;
      if (held) clearTimeout(held.timer);
      timers.current.set(key, { version: entry.version, timer: setTimeout(() => { timers.current.delete(key); land(key, entry); }, AI_SWITCH_SETTLE_MS) });
    }
    for (const [key, held] of timers.current) {
      if (keep.has(key)) continue;
      clearTimeout(held.timer);
      timers.current.delete(key);
    }
    // `ready` is read through `signature`: a new bot object (another conversation streaming) must not restart a wait.
  }, [signature]);
  useEffect(() => () => {
    for (const held of timers.current.values()) clearTimeout(held.timer);
    timers.current.clear();
  }, []);
}
