// A bot asks the person to do one step where it works (request_sign_in): a site sign-in, or a handoff with the bot's own
// instruction. Either is a "signin" card in the conversation, which persists, notifies and resumes the bot like any card.
// A handoff waits a bounded time: past its expiresAt it ends on its own and the bot is told, also across a restart.
import {
  HANDOFF_EXPIRY_MS, HANDOFF_INSTRUCTION_MAX, handoffNeed, isPendingSignInRequest, normalizeSignInSite, signInWaits,
} from "../../shared/sign-in-request.ts";
import type { HandoffNeed } from "../../shared/sign-in-request.ts";
import type { ComputerHelpRef, SignInRequestCardData } from "../../shared/wire.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { Surface } from "../surface.ts";

export type HandoffTarget = "browser" | "computer";

export interface SignInAsk {
  site?: unknown;
  reason?: unknown;
  instruction?: unknown;
  kind?: unknown;
  target?: unknown;
}

export type SignInAsked =
  | { messageId: string; site: string; place: Surface; instruction?: string; expiresAt?: number }
  | { status: number; error: string };

export interface HandoffRequestDeps {
  store: Pick<Store, "appendMessage" | "activePath" | "patchMessage">;
  /** The conversation the asking bot may post in; null when it is not its own. */
  owner(botId: string, threadId: string): { group?: unknown } | null;
  /** Where the asking turn works now. */
  place(bot: BotRecord, threadId: string): Surface | null;
  /** The computer this conversation works on, when it has one besides the browser. */
  computer(bot: BotRecord, threadId: string): Surface | null;
  browserOn(bot: BotRecord): boolean;
  /** The page the bot's browser shows, for a handoff that names no site. */
  pageNow(bot: BotRecord, threadId: string): Promise<string | null>;
  cardText(botName: string, site: string, threadId: string): string;
  /** A newer card for the same site replaces this open one. */
  supersede(threadId: string, prior: Message, next: Message): void;
  requestHelp(bot: BotRecord, threadId: string, place: Surface, reason: string, ref: ComputerHelpRef): void;
  expire(botId: string, threadId: string, messageId: string): void;
  /** Conversations that may hold an open card asked since then. */
  threadsWithCards(since: number): readonly string[];
  /** The bot whose conversation this is. */
  botOf(threadId: string): string | null;
  now?: () => number;
  expiryMs?: number;
  setTimer?: (run: () => void, ms: number) => { cancel(): void };
}

/** The card is made without the page's address rather than wait on a slow browser. */
const PAGE_LOOK_MS = 3_000;
const pageWithin = (look: Promise<string | null>, ms: number): Promise<string | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([look.catch(() => null), new Promise<null>((done) => { timer = setTimeout(() => done(null), ms); })]).finally(() => clearTimeout(timer));
};

const oneLine = (raw: unknown, max: number): string => typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim().slice(0, max) : "";

const defaultTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, Math.min(ms, 2 ** 31 - 1));
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

/** The place a handoff names: the browser, or the computer the conversation works on. Without a target, where the turn
 * works now. */
export function handoffPlace(target: unknown, here: Surface | null, computer: Surface | null, browserOn: boolean): Surface | null {
  if (target === "browser") return browserOn ? "browser" : null;
  if (target === "computer") return here && here !== "browser" ? here : computer;
  return here;
}

export function createHandoffRequests(deps: HandoffRequestDeps) {
  const now = deps.now ?? Date.now;
  const expiryMs = deps.expiryMs ?? HANDOFF_EXPIRY_MS;
  const setTimer = deps.setTimer ?? defaultTimer;
  const timers = new Map<string, { cancel(): void }>();

  const arm = (botId: string, threadId: string, messageId: string, expiresAt: number): void => {
    timers.get(messageId)?.cancel();
    timers.set(messageId, setTimer(() => {
      timers.delete(messageId);
      deps.expire(botId, threadId, messageId);
    }, Math.max(0, expiresAt - now())));
  };

  /** Appends the new card first, so a failed append leaves the older one actionable. */
  async function request(from: BotRecord, threadId: string, ask: SignInAsk): Promise<SignInAsked> {
    const owner = deps.owner(from.id, threadId);
    if (!owner) return { status: 403, error: "source conversation does not belong to sender" };
    const instruction = oneLine(ask.instruction, HANDOFF_INSTRUCTION_MAX);
    if (ask.target !== undefined && ask.target !== "browser" && ask.target !== "computer") return { status: 400, error: "target must be browser or computer" };
    if (ask.kind !== undefined && !handoffNeed(ask.kind)) return { status: 400, error: "kind must be one of sign_in, captcha, payment, approval or other" };
    const place = instruction ? handoffPlace(ask.target, deps.place(from, threadId), deps.computer(from, threadId), deps.browserOn(from)) : deps.place(from, threadId);
    if (!place) {
      return { status: 409, error: ask.target === "browser" ? "the browser is off for this bot" : "this conversation has no browser or computer for the person to work on" };
    }
    const rawSite = ask.site ?? (instruction && place === "browser" ? await pageWithin(deps.pageNow(from, threadId), PAGE_LOOK_MS) : null);
    const target = rawSite === null || rawSite === undefined || rawSite === "" ? null : normalizeSignInSite(rawSite);
    if (!target && (!instruction || ask.site !== undefined)) return { status: 400, error: "site must be a web address or a domain, such as example.com" };
    const reason = oneLine(ask.reason, 240);
    const need: HandoffNeed | null = instruction ? handoffNeed(ask.kind) ?? (target ? "sign_in" : "other") : null;
    const expiresAt = instruction ? now() + expiryMs : undefined;
    const card: SignInRequestCardData = {
      url: target?.url ?? "", site: target?.site ?? "", place,
      ...(reason ? { reason } : {}),
      ...(instruction ? { instruction, need: need!, expiresAt } : {}),
    };
    const message = deps.store.appendMessage(threadId, {
      role: "bot",
      kind: "signin",
      text: instruction || deps.cardText(from.name, card.site, threadId),
      ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      signIn: card,
    });
    // A handoff stacks with the others; a site sign-in replaces the open one for its site.
    if (!instruction) {
      for (const prior of deps.store.activePath(threadId)) {
        if (prior.id !== message.id && prior.signIn && isPendingSignInRequest(prior, card.site, from.id, Boolean(owner.group))) deps.supersede(threadId, prior, message);
      }
    }
    deps.requestHelp(from, threadId, place, instruction || `sign in to ${card.site}`,
      { botId: from.id, threadId, messageId: message.id, site: card.site, place, ...(instruction ? { instruction } : {}) });
    if (expiresAt !== undefined) arm(from.id, threadId, message.id, expiresAt);
    return { messageId: message.id, site: card.site, place, ...(instruction ? { instruction, expiresAt } : {}) };
  }

  /** Open handoffs outlive a restart: each is timed again, and one already past its time ends now. */
  function boot(): void {
    for (const threadId of deps.threadsWithCards(now() - expiryMs - 60 * 60_000)) {
      for (const message of deps.store.activePath(threadId)) {
        const card = message.signIn;
        if (message.kind !== "signin" || !card?.instruction || card.expiresAt === undefined || card.stopped || !signInWaits(card)) continue;
        const botId = message.from?.botId ?? deps.botOf(threadId);
        if (botId) arm(botId, threadId, message.id, card.expiresAt);
      }
    }
  }

  return {
    request,
    boot,
    /** The card settled another way: its timer goes. */
    settled(messageId: string): void {
      timers.get(messageId)?.cancel();
      timers.delete(messageId);
    },
    pending: () => timers.size,
  };
}
