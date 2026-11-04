// A bot on the person's own Cloud that needs their computer when it isn't available asks once, with a card that has a
// one-tap Turn on. The app on that computer, while open, says what it can't lend and why (`present`), hears
// each ask, and does what Turn on asks for there; the first answer, on the card or in that app, wins. Once the computer
// lends what was needed the bot carries on: its waiting call returns, or its request continues by itself. Asks live in
// memory, and a card a previous run left open is closed at startup.
import { z } from "zod";

import { newId } from "./contracts.ts";
import { deviceWord, LENT_PLATFORMS, type LentComputer, type LentPlatform } from "./lent-computers.ts";
import { optionCardsForTools } from "./message-db.ts";
import { buildNotification, type Notification } from "./notify.ts";
import type { BotRecord, Store } from "./store.ts";
import type { CardAnswerer } from "../shared/wire.ts";
import {
  ASK_FOR_COMPUTER_TOOL, cleanAskWhy, COMPUTER_ASK_TOOL, computerAskHeadline, computerAskReasonLine, computerAskText, needsTheApp, turnsOnFromHere,
  type ComputerAskCard, type ComputerAskReason, type ComputerAskState, type ComputerDevice, type ComputerNeed,
} from "../shared/computer-ask.ts";

/** Why apps and screen aren't lent, as the app on that computer reads it. */
export const SCREEN_REASONS = ["starting", "permissions", "blocked", "off", "not-running", "unsupported"] as const;
export type ScreenReason = (typeof SCREEN_REASONS)[number];

/** What the app on a computer says about it each time it asks for news. */
export interface DesktopState {
  name: string;
  platform: LentPlatform | null;
  paused: boolean;
  screen: { ready: boolean; reason: ScreenReason | null };
  terminal: boolean;
}

/** That app's answer to an ask: the person tapped Turn on or Not now in it, or it tried and couldn't (`reason`: why now). */
export interface DesktopAnswer { id: string; outcome: "turning-on" | "declined" | "failed"; reason?: ScreenReason | "paused" | "terminal-off" }

/** POST /api/shared-computers/asks: the app's state, the last `version` it heard, and its answers since. */
export const desktopPresence = z.object({
  name: z.string().min(1).max(120),
  platform: z.enum(LENT_PLATFORMS).nullable(),
  paused: z.boolean(),
  screen: z.object({ ready: z.boolean(), reason: z.enum(SCREEN_REASONS).nullable() }).strict(),
  terminal: z.boolean(),
  heard: z.number().int().min(-1),
  answers: z.array(z.object({
    id: z.string().min(1).max(100),
    outcome: z.enum(["turning-on", "declined", "failed"]),
    reason: z.enum([...SCREEN_REASONS, "paused", "terminal-off"]).optional(),
  }).strict()).max(20),
}).strict();

/** What that app hears: each open ask, and how many times Turn on was tapped on the card, so it acts once per tap. */
export interface DesktopAsk { id: string; need: ComputerNeed; reason: ComputerAskReason; bot: string; why?: string; state: ComputerAskState; turnOn: number }

/** A computer lending to this Cloud now. */
export interface OnlineComputer { id: string; name: string; platform?: LentPlatform; computer: boolean; terminal: boolean }

/** Who answered on the card or in the app: kept on the card, so the conversation stays the owner's own. */
export type Answerer = CardAnswerer;

export interface ComputerAsksDeps {
  store: Pick<Store, "appendMessage" | "patchMessage" | "messagesFor" | "projectBotForTask" | "setTaskActivity" | "groupByThread">;
  notify?: (notification: Notification | null) => void;
  online(): OnlineComputer[];
  /** Computers lent before, newest first. */
  known(): Array<Pick<LentComputer, "platform">>;
  /** The request goes on in its conversation now that the computer lends what it needed; false when it can't yet (the
   * conversation is busy, or someone wrote since). */
  carryOn(ask: { botId: string; threadId: string; requestMessageId: string }, text: string): boolean;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Each long poll of the app on a computer, and each wait of a bot's call. */
export const PRESENT_WAIT_MS = 20_000;
export const ASK_WAIT_MS = 40_000;
/** The app on a computer polls at least this often while it is open. */
export const PRESENT_FRESH_MS = 45_000;
/** A sleeping Cloud's computer takes this long to come back after the Cloud wakes: an ask waits for it first. */
export const RECONNECT_GRACE_MS = 20_000;
/** Turn on was tapped: the computer has this long to lend what is needed. */
export const TURN_ON_MS = 90_000;
/** After Not now, the same bot asking for the same thing in the same conversation is told so, not asked again. */
export const NOT_NOW_MS = 10 * 60_000;
/** A request goes on by itself once its conversation is free, for this long. */
export const CARRY_ON_MS = 15 * 60_000;
const CARRY_ON_EVERY_MS = 5_000;
const REFRESH_MS = 15_000;
const OPEN_LIMIT = 50;

type Outcome = "ready" | "declined" | "failed" | "ended";

interface Ask {
  id: string; threadId: string; botId: string; botName: string; messageId: string; requestMessageId?: string;
  need: ComputerNeed; why?: string; reason: ComputerAskReason; device: ComputerDevice; state: ComputerAskState;
  turnOn: number; createdAt: number; settledAt?: number; deadline?: ReturnType<typeof setTimeout>;
  waiters: Set<(outcome: Outcome) => void>;
}

export type AskReply =
  | { state: "ready"; computerId: string; device: ComputerDevice }
  | { state: "waiting" | "declined" | "failed" | "unavailable"; device: ComputerDevice; reason: ComputerAskReason };

const OPEN: ReadonlySet<ComputerAskState> = new Set(["asking", "turning-on", "failed"]);

export class ComputerAsks {
  private asks = new Map<string, Ask>();
  private desktops = new Map<string, { state: DesktopState; seen: number }>();
  private version = 0;
  private listeners = new Set<() => void>();
  /** While any ask is open its reason is read again this often: an app that quits stops polling without a word. */
  private ticking: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: ComputerAsksDeps;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(deps: ComputerAsksDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  /** The app on a computer: how it is, its answers, then (after at most `waitMs`) the asks it hasn't heard yet. */
  async present(state: DesktopState, answers: DesktopAnswer[], answerer: Answerer, heard: number, signal?: AbortSignal, waitMs = PRESENT_WAIT_MS): Promise<{ version: number; asks: DesktopAsk[] }> {
    const before = this.desktops.get(state.name);
    this.desktops.set(state.name, { state, seen: this.now() });
    for (const answer of answers) this.desktopAnswer(answer, answerer);
    if (!before || JSON.stringify(before.state) !== JSON.stringify(state)) this.refresh();
    if (heard === this.version && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => { this.clearTimer(timer); this.listeners.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timer = this.setTimer(done, waitMs);
        this.listeners.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    const entry = this.desktops.get(state.name);
    if (entry) entry.seen = this.now();
    return { version: this.version, asks: [...this.asks.values()].filter((ask) => OPEN.has(ask.state)).map((ask) => ({
      id: ask.id, need: ask.need, reason: ask.reason, bot: ask.botName, ...(ask.why ? { why: ask.why } : {}), state: ask.state, turnOn: ask.turnOn,
    })) };
  }

  /** A bot's call: ready at once when the computer lends what's needed; otherwise one card, then a wait of at most `waitMs`. */
  async ask(input: { threadId: string; bot: Pick<BotRecord, "id" | "name" | "color" | "avatarUrl" | "notifications">; need: ComputerNeed; why?: unknown; requestMessageId?: string },
    waitMs = ASK_WAIT_MS): Promise<AskReply> {
    const started = this.now();
    let met = this.met(input.need);
    if (met) return { state: "ready", computerId: met.id, device: this.device() };
    const open = [...this.asks.values()].find((ask) => ask.threadId === input.threadId && ask.need === input.need && OPEN.has(ask.state));
    if (open?.state === "failed") return { state: "failed", device: open.device, reason: open.reason };
    if (open) return this.waitFor(open, waitMs);
    const refused = [...this.asks.values()].find((ask) => ask.threadId === input.threadId && ask.need === input.need && ask.botId === input.bot.id &&
      ask.state === "declined" && this.now() - (ask.settledAt ?? 0) < NOT_NOW_MS);
    if (refused) return { state: "declined", device: refused.device, reason: refused.reason };
    // A computer that was online a moment ago, or whose app is open, comes back by itself after the Cloud wakes.
    let reason = this.reasonFor(input.need);
    while ((reason === "closed" || reason === "starting") && this.now() - started < Math.min(RECONNECT_GRACE_MS, waitMs)) {
      await this.changeOrTimeout(1_000);
      met = this.met(input.need);
      if (met) return { state: "ready", computerId: met.id, device: this.device() };
      reason = this.reasonFor(input.need);
    }
    if (!turnsOnFromHere(reason) && !needsTheApp(reason)) return { state: reason === "starting" ? "waiting" : "unavailable", device: this.device(), reason };
    if ([...this.asks.values()].filter((ask) => OPEN.has(ask.state)).length >= OPEN_LIMIT) return { state: "unavailable", device: this.device(), reason };
    const ask = this.raise(input, reason);
    return this.waitFor(ask, Math.max(1_000, waitMs - (this.now() - started)));
  }

  /** A tap on the card. True when it was one of these. */
  answer(requestId: string, behavior: string | undefined): boolean {
    const ask = this.asks.get(requestId);
    if (!ask) return false;
    if (!OPEN.has(ask.state)) return true;
    if (behavior !== "allow") { this.settle(ask, "declined"); return true; }
    if (!turnsOnFromHere(ask.reason)) return true;
    this.turnOn(ask);
    return true;
  }

  /** A computer connected, changed what it lends, or left. */
  lendingChanged(): void { this.refresh(); }

  /** The conversation was stopped or deleted: nothing it asked for is needed any more. */
  cancel(threadId: string): void {
    for (const ask of this.asks.values()) if (ask.threadId === threadId && OPEN.has(ask.state)) this.settle(ask, "ended");
  }

  /** A card a previous run left open can never be answered: closed at startup. */
  dismissStale(): number {
    let dismissed = 0;
    for (const { threadId, messageId } of optionCardsForTools([COMPUTER_ASK_TOOL])) {
      const card = this.deps.store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
      if (!card?.computerAsk || this.asks.has(card.requestId ?? "") || !OPEN.has(card.computerAsk.state)) continue;
      if (this.deps.store.patchMessage(threadId, messageId, { card: { ...card, answered: card.answered ?? "deny", dismissed: true, computerAsk: { ...card.computerAsk, state: "ended" } } })) dismissed += 1;
    }
    return dismissed;
  }

  /** Why the computer can't give `need` now, read fresh. */
  reasonFor(need: ComputerNeed): ComputerAskReason {
    const desktop = this.freshDesktop();
    if (desktop?.paused) return "paused";
    if (desktop) {
      if (need === "screen") return desktop.screen.ready ? "starting" : desktop.screen.reason ?? "starting";
      if (need === "terminal") return desktop.terminal ? "starting" : "terminal-off";
      return "starting";
    }
    if (this.deps.online().length) return "update";
    return this.deps.known().length ? "closed" : "never";
  }

  /** Words for the bot, from a reply. */
  static say(reply: AskReply, name: string): string {
    if (reply.state === "ready") {
      return `Their ${reply.device} lends what you need now: computer_id ${reply.computerId}. Go on with shared_computer; verify the result before saying it's done.`;
    }
    const line = computerAskReasonLine({ reason: reply.reason, device: reply.device }, name);
    const why = computerAskText(line.key, line.params);
    const stay = `Don't switch to your own cloud computer or browser instead unless they ask you to.`;
    if (reply.state === "waiting" && reply.reason === "starting") return `${why} Call ${ASK_FOR_COMPUTER_TOOL} again in a moment. ${stay}`;
    if (reply.state === "waiting") return `A card in this chat asks them to turn it on (${why}) and they haven't yet, so nothing was done on their ${reply.device}. Don't ask again or explain the fix in chat: the card says it. End your turn now: once it's on, you carry on here by yourself. ${stay}`;
    if (reply.state === "declined") return `They chose Not now. Don't use their ${reply.device} for this: say in one sentence what you couldn't do, and that you can once they turn it on. ${stay}`;
    if (reply.state === "failed") return `It didn't turn on: ${why} The card lets them try again. Say so in one sentence. ${stay}`;
    return `${why} Nothing here can turn it on: say so in one sentence. ${stay}`;
  }

  private raise(input: { threadId: string; bot: Pick<BotRecord, "id" | "name" | "color" | "avatarUrl" | "notifications">; need: ComputerNeed; why?: unknown; requestMessageId?: string }, reason: ComputerAskReason): Ask {
    const { store } = this.deps;
    const device = this.device();
    const why = cleanAskWhy(input.why);
    const room = store.groupByThread(input.threadId);
    const id = newId();
    const view: ComputerAskCard = { need: input.need, reason, device, state: "asking", ...(why ? { why } : {}) };
    const message = store.appendMessage(input.threadId, {
      role: "bot",
      kind: "options",
      ...(room ? { from: { botId: input.bot.id, name: input.bot.name, color: input.bot.color } } : {}),
      card: { ...cardWords(view, input.bot.name), requestId: id, requestType: "permission", tool: COMPUTER_ASK_TOOL, computerAsk: view },
    });
    const ask: Ask = {
      id, threadId: input.threadId, botId: input.bot.id, botName: input.bot.name, messageId: message.id,
      ...(input.requestMessageId && !room ? { requestMessageId: input.requestMessageId } : {}),
      need: input.need, ...(why ? { why } : {}), reason, device, state: "asking", turnOn: 0, createdAt: this.now(), waiters: new Set(),
    };
    this.asks.set(id, ask);
    this.tick();
    const task = store.projectBotForTask(input.bot.id, input.threadId);
    if (task?.busy) store.setTaskActivity(input.bot.id, input.threadId, "waiting-on-you");
    this.deps.notify?.(buildNotification("approval", input.bot, input.threadId, cardWords(view, input.bot.name).title, {
      avatarUrl: input.bot.avatarUrl, ...(room && !room.dm ? { group: { id: room.id, name: room.name } } : {}),
    }));
    this.bump();
    return ask;
  }

  private waitFor(ask: Ask, waitMs: number): Promise<AskReply> {
    const reply = (outcome: Outcome | "waiting"): AskReply => {
      if (outcome === "ready") {
        const met = this.met(ask.need);
        if (met) return { state: "ready", computerId: met.id, device: ask.device };
      }
      if (outcome === "declined" || outcome === "ended") return { state: "declined", device: ask.device, reason: ask.reason };
      if (outcome === "failed") return { state: "failed", device: ask.device, reason: ask.reason };
      return { state: "waiting", device: ask.device, reason: ask.reason };
    };
    if (ask.state === "on") return Promise.resolve(reply("ready"));
    return new Promise((resolve) => {
      const done = (outcome: Outcome | "waiting") => { this.clearTimer(timer); ask.waiters.delete(done); resolve(reply(outcome)); };
      const timer = this.setTimer(() => done("waiting"), waitMs);
      ask.waiters.add(done);
    });
  }

  private turnOn(ask: Ask): void {
    ask.turnOn += 1;
    ask.state = "turning-on";
    if (ask.deadline) this.clearTimer(ask.deadline);
    ask.deadline = this.setTimer(() => {
      ask.deadline = undefined;
      if (ask.state !== "turning-on") return;
      ask.reason = this.reasonFor(ask.need);
      this.fail(ask);
    }, TURN_ON_MS);
    this.patch(ask, { answered: "allow" });
    this.bump();
  }

  private desktopAnswer(answer: DesktopAnswer, answerer: Answerer): void {
    const ask = this.asks.get(answer.id);
    if (!ask || !OPEN.has(ask.state)) return;
    if (answer.outcome === "declined") { this.settle(ask, "declined", answerer); return; }
    if (answer.outcome === "turning-on") {
      if (ask.state === "turning-on") return;
      this.turnOn(ask);
      this.patch(ask, { answered: "allow", answeredBy: answerer });
      return;
    }
    if (answer.reason) ask.reason = answer.reason;
    this.fail(ask);
  }

  private fail(ask: Ask): void {
    if (ask.deadline) { this.clearTimer(ask.deadline); ask.deadline = undefined; }
    ask.state = "failed";
    this.patch(ask, { answered: undefined, answeredBy: undefined });
    for (const waiter of ask.waiters) waiter("failed");
    this.bump();
  }

  /** Every open ask whose need the computer meets now is on; the others take the reason as it is now. */
  private refresh(): void {
    let changed = false;
    for (const ask of this.asks.values()) {
      if (!OPEN.has(ask.state)) continue;
      const met = this.met(ask.need);
      if (met) { this.on(ask); changed = true; continue; }
      if (ask.state !== "asking") continue;
      const reason = this.reasonFor(ask.need);
      if (reason === ask.reason || reason === "starting") continue;
      ask.reason = reason;
      ask.device = this.device();
      this.patch(ask, {});
      changed = true;
    }
    if (changed) this.bump();
  }

  private on(ask: Ask): void {
    if (ask.deadline) { this.clearTimer(ask.deadline); ask.deadline = undefined; }
    const tapped = ask.state === "turning-on";
    ask.state = "on";
    ask.settledAt = this.now();
    // Nobody tapped when the app there came back by itself: the harness settled it, in nobody's words.
    this.patch(ask, tapped ? { answered: "allow" } : { answered: "allow", dismissed: true });
    this.idle(ask);
    const waiting = [...ask.waiters];
    for (const waiter of waiting) waiter("ready");
    if (!waiting.length && ask.requestMessageId) this.carryOn(ask, this.now());
  }

  private carryOn(ask: Ask, since: number): void {
    const requestMessageId = ask.requestMessageId;
    if (!requestMessageId) return;
    const text = `[Their ${ask.device} lends what you asked for now.] Carry on with their request where you left off: list_shared_computers gives its computer_id for shared_computer. Verify the result before saying it's done.`;
    if (this.deps.carryOn({ botId: ask.botId, threadId: ask.threadId, requestMessageId }, text)) return;
    if (this.now() - since >= CARRY_ON_MS) return;
    const timer = this.setTimer(() => this.carryOn(ask, since), CARRY_ON_EVERY_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  private settle(ask: Ask, state: "declined" | "ended", answerer?: Answerer): void {
    if (ask.deadline) { this.clearTimer(ask.deadline); ask.deadline = undefined; }
    ask.state = state;
    ask.settledAt = this.now();
    this.patch(ask, state === "ended" ? { answered: "deny", dismissed: true } : { answered: "deny", ...(answerer ? { answeredBy: answerer } : {}) });
    this.idle(ask);
    for (const waiter of ask.waiters) waiter(state);
    this.bump();
  }

  private idle(ask: Ask): void {
    const task = this.deps.store.projectBotForTask(ask.botId, ask.threadId);
    if (task?.activity === "waiting-on-you") this.deps.store.setTaskActivity(task.id, ask.threadId, "working");
  }

  private patch(ask: Ask, fields: { answered?: string; answeredBy?: Answerer; dismissed?: boolean }): void {
    const { store } = this.deps;
    const card = store.messagesFor(ask.threadId).find((message) => message.id === ask.messageId)?.card;
    if (!card) return;
    const view: ComputerAskCard = { need: ask.need, reason: ask.reason, device: ask.device, state: ask.state, ...(ask.why ? { why: ask.why } : {}) };
    const next = { ...card, ...cardWords(view, ask.botName), computerAsk: view, ...fields };
    for (const key of ["answered", "answeredBy"] as const) if (Object.hasOwn(fields, key) && fields[key] === undefined) delete next[key];
    store.patchMessage(ask.threadId, ask.messageId, { card: next });
  }

  private met(need: ComputerNeed): OnlineComputer | null {
    return this.deps.online().find((computer) => {
      if (need === "terminal") return computer.terminal;
      if (need === "folders") return true;
      const desktop = this.desktops.get(computer.name);
      return computer.computer && (!desktop || this.now() - desktop.seen >= PRESENT_FRESH_MS || desktop.state.screen.ready);
    }) ?? null;
  }

  private freshDesktop(): DesktopState | null {
    let newest: { state: DesktopState; seen: number } | null = null;
    for (const entry of this.desktops.values()) if (this.now() - entry.seen < PRESENT_FRESH_MS && (!newest || entry.seen > newest.seen)) newest = entry;
    return newest?.state ?? null;
  }

  private device(): ComputerDevice {
    return deviceWord(this.freshDesktop()?.platform ?? this.deps.online()[0]?.platform ?? this.deps.known()[0]?.platform ?? null);
  }

  private tick(): void {
    if (this.ticking) return;
    this.ticking = this.setTimer(() => {
      this.ticking = null;
      this.refresh();
      if ([...this.asks.values()].some((ask) => OPEN.has(ask.state))) this.tick();
    }, REFRESH_MS);
    (this.ticking as { unref?: () => void }).unref?.();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private changeOrTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.clearTimer(timer); this.listeners.delete(done); resolve(); };
      const timer = this.setTimer(done, ms);
      this.listeners.add(done);
    });
  }
}

/** The card's English, for clients that read only its title, subtitle and options. */
function cardWords(view: ComputerAskCard, name: string): { title: string; subtitle: string; options: string[] } {
  const headline = computerAskHeadline(view);
  const reason = computerAskReasonLine(view, name);
  const title = computerAskText(headline.key, { ...headline.params, name });
  const subtitle = [view.why, computerAskText(reason.key, reason.params)].filter(Boolean).join("\n");
  const options = turnsOnFromHere(view.reason)
    ? [computerAskText(view.state === "failed" ? "computerAsk.action.tryAgain" : "computerAsk.action.turnOn", {}), computerAskText("computerAsk.action.notNow", {})]
    : [computerAskText("computerAsk.action.notNow", {})];
  return { title, subtitle, options };
}
