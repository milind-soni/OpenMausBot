// A My Cloud bot opened in place: clicking its row in the one list shows its conversation here, in this window, with
// the sidebar and everything else as they were. This page still talks only to its own server: the bot is this page's
// as `cloud:<id>` (shared/place-ids.ts), and this computer's server forwards what is asked of it to My Cloud
// (server/places/place-proxy.ts) with the session main opened there for it (electron/place-chat-main.mjs).
//
// The bot is in the page's store only while it is the one open: it comes in when its row is chosen, and goes when
// another bot or page is chosen (PlaceChatKeeper). Its live turns come on a stream of their own, cut to that bot, and
// feed the store exactly as this page's own stream does.
//
// A My Cloud that can't do this (an app from before it, a sign-in that fails, a route it lacks) opens as before: main
// moves the window to My Cloud's own page at that bot. Nothing is half-shown.
import type { Dispatch } from "react";
import { isPlaceId, ownId, placeId } from "../../shared/place-ids";
import type { ServerFrame } from "../../shared/wire";
import { placeFrame } from "./live-events";
import { openOtherPlaceBot } from "./places-together";
import { api } from "@/state/api";
import type { Action, Bot } from "@/state/store";

export { isPlaceId };

/** How many of its newest messages the conversation opens with, as switching to one of this page's own conversations. */
const OPEN_MESSAGES = 80;
export const PLACE_EVENTS_PATH = "/api/places/cloud/events";
const RETRY_MS = [1_000, 2_000, 5_000, 15_000];
/** A stream that never opened after this many tries: the conversation can't be kept live here, so it opens there. */
const FIRST_TRIES = 3;

const bridge = () => (typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.placesTogether);

/** The bots a fresh read of this page's own server keeps: the one My Cloud bot open in place is not its server's to list. */
export function keptPlaceBots<T extends { id: string }>(bots: readonly T[]): T[] {
  return bots.filter((bot) => isPlaceId(bot.id));
}

/** My Cloud's bot as this page holds it. Never this page's Chief (there is one per place), and nothing of it notifies here. */
export function placeBot(bot: Bot): Bot {
  return { ...bot, chiefOfStaff: false, notifications: false, messages: bot.messages ?? [] } as Bot;
}

/** What the person last chose in this page (PlaceChatKeeper keeps it): a click that is overtaken by another choice lands nowhere. */
let chosen: string | null = null;
let clicks = 0;
let live: { key: string; stop: () => void } | null = null;

export function noteChosen(id: string | null): void {
  chosen = id;
}

/** Opens My Cloud's bot `id` (its id on My Cloud) here. `dispatch` is this page's store. Falls back to opening My Cloud's
 * page at it whenever it can't open here. */
export async function openPlaceBot(id: string, dispatch: Dispatch<Action>): Promise<"here" | "there" | "overtaken"> {
  const mine = ++clicks, before = chosen, key = placeId(id);
  const overtaken = () => mine !== clicks || chosen !== before;
  const there = () => { openOtherPlaceBot(id); return "there" as const; };
  const page = bridge();
  if (!page?.openInPlace) return there();
  let opened: { ok: boolean } | null = null;
  try { opened = await page.openInPlace(id); } catch { opened = null; }
  if (overtaken()) return "overtaken";
  if (!opened?.ok) return there();
  let bot: Bot | null = null;
  const read = async () => {
    const answer = await api<{ bot: Bot }>(`/api/bots/${encodeURIComponent(key)}?messages=${OPEN_MESSAGES}`);
    if (!answer?.bot || answer.bot.id !== key) throw new Error("not this bot");
    return answer.bot;
  };
  try { bot = await read(); } catch (error) {
    // The session was signed out at My Cloud, or this computer's server restarted without it: main opens a new one, once.
    const code = (error as { body?: { code?: unknown } }).body?.code;
    if (!overtaken() && (code === "place_signin" || code === "place_closed")) {
      try { if ((await page.openInPlace(id, true))?.ok && !overtaken()) bot = await read(); } catch { bot = null; }
    }
  }
  if (overtaken()) return "overtaken";
  if (!bot) return there();
  dispatch({ type: "botPatched", bot: placeBot(bot) });
  dispatch({ type: "select", id: key });
  chosen = key;
  keepLive(key, () => there());
  return "here";
}

/** The person left the bot open in place: its stream ends, and it leaves the store. */
export function closePlaceBot(key: string): void {
  if (live?.key === key) { live.stop(); live = null; }
  placeFrame({ kind: "bot.deleted", botId: key });
}

/** Reads the bot again (the stream started over, or resumed from too far back). */
async function reread(key: string): Promise<void> {
  try {
    const { bot } = await api<{ bot: Bot }>(`/api/bots/${encodeURIComponent(key)}?messages=${OPEN_MESSAGES}`);
    if (bot?.id === key && live?.key === key) placeFrame({ kind: "bot", bot: placeBot(bot) } as unknown as ServerFrame);
  } catch {
    // The stream's own retry reads again.
  }
}

interface Platform {
  createEventSource(url: string): { onopen: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string; lastEventId?: string }) => void) | null; close(): void };
  visible(): boolean;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

const browser = (): Platform => ({
  createEventSource: (url) => {
    const native = new EventSource(url);
    const source: ReturnType<Platform["createEventSource"]> = { onopen: null, onerror: null, onmessage: null, close: () => native.close() };
    native.onopen = () => source.onopen?.();
    native.onerror = () => source.onerror?.();
    native.onmessage = (event) => source.onmessage?.(event);
    return source;
  },
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  target: typeof window === "undefined" ? undefined : window,
});

/** The bot's live stream while it is open here and the page is in sight. My Cloud going to sleep closes it quietly; the
 * person's next click, key or return to the window opens it again, which wakes My Cloud as any use of it does. */
export function keepLive(key: string, cannot: () => void, platform: Platform = browser()): () => void {
  live?.stop();
  let source: ReturnType<Platform["createEventSource"]> | null = null, since: string | null = null, tries = 0, opened = false, stopped = false, asleep = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const close = () => { if (source) { source.onopen = source.onerror = source.onmessage = null; source.close(); source = null; } };
  const connect = () => {
    if (stopped || source || asleep || !platform.visible()) return;
    const url = `${PLACE_EVENTS_PATH}?bot=${encodeURIComponent(key)}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const current = platform.createEventSource(url);
    source = current;
    current.onopen = () => { opened = true; tries = 0; };
    current.onerror = () => {
      if (source !== current) return;
      close();
      tries += 1;
      if (!opened && tries >= FIRST_TRIES) { stop(); cannot(); return; }
      // This computer's server may have restarted since, without the session: main tells it again.
      if (opened) void bridge()?.openInPlace?.(ownId(key)).catch(() => {});
      timer = setTimeout(() => { timer = null; connect(); }, RETRY_MS[Math.min(tries - 1, RETRY_MS.length - 1)]);
    };
    current.onmessage = (event) => {
      if (source !== current) return;
      if (event.lastEventId) since = event.lastEventId;
      let frame: { kind?: unknown; resumed?: unknown; state?: unknown };
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.kind === "ping") return;
      if (frame.kind === "hello") { if (frame.resumed !== true) void reread(key); return; }
      if (frame.kind === "power") {
        if (frame.state === "sleeping") { asleep = true; close(); }
        return;
      }
      placeFrame(frame as ServerFrame);
    };
  };
  const wake = () => {
    if (!platform.visible()) { close(); return; }
    if (asleep) { asleep = false; connect(); } else if (!source && timer === null) connect();
  };
  const events = ["pointerdown", "keydown", "focus", "visibilitychange"] as const;
  for (const name of events) platform.target?.addEventListener(name, wake, { capture: true });
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    close();
    for (const name of events) platform.target?.removeEventListener(name, wake, { capture: true });
  };
  live = { key, stop };
  connect();
  return stop;
}

/** The open bot's own id on My Cloud, for "Open on My Cloud's page". */
export const placeOwnId = (key: string): string => ownId(key);

export function resetPlaceChatForTest(): void {
  live?.stop();
  live = null;
  chosen = null;
  clicks = 0;
}
