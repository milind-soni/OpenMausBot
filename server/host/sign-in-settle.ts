// How a sign-in card settles: Done or Cancel on the card, a saved login filling it, the person's own line in the
// conversation, which answers every sign-in request still open there, an answer passed on by another bot, or the bot
// carrying on with the site after asking, which shows the sign-in went through. Work handed on that waited on the card
// carries on with the person's line; a person's own conversation goes on with the turn their line starts.
import { savedLoginResumePrompt } from "../../shared/logins.ts";
import { signInOutcome, signInResumePrompt, signInWaits } from "../../shared/sign-in-request.ts";
import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { Surface } from "../surface.ts";

export interface SignInSettleDeps {
  store: Pick<Store, "activePath" | "bot" | "patchMessage">;
  signInMessage(botId: string, threadId: string, messageId: string): Message | null;
  answerCardNode(threadId: string, messageId: string, text: string): boolean;
  releaseCardNode(threadId: string, messageId: string, reason: string): void;
  resumableCards(threadId: string, since: number): Array<{ id: string }>;
  /** The work parked on the person in this conversation: its own, or work handed on to it. */
  parkedDirect(threadId: string): HandoffView | undefined;
  /** Ends the card's plea for help and returns the computers it held. */
  settleHelp(messageId: string): string[];
  handBackBrowser(bot: BotRecord, threadId: string): void;
  releaseComputer(key: string): void;
  computerKey(bot: BotRecord): string;
}

export type SignInSettled = { status: number; body: Record<string, unknown> };

/** The line that resumes work handed on when the person answered its sign-in in the chat instead of pressing Done. */
export function signInChatPrompt(site: string, line: string): string {
  return `OpenMausBot sign-in update: instead of pressing Done on the sign-in to ${site}, the person wrote in the chat: ${JSON.stringify(line.slice(0, 400))}. Check you are signed in, then continue the task that paused for it. Never ask them for a password or a one-time code in chat.`;
}

export function createSignInSettle(deps: SignInSettleDeps) {
  const { store } = deps;

  /** The person is through with the place the card lent them: its plea goes, and the browser or computer goes back to the bot. */
  const handPlaceBack = (bot: BotRecord, threadId: string, messageId: string, place: Surface): void => {
    const pleaded = deps.settleHelp(messageId);
    if (place === "browser") deps.handBackBrowser(bot, threadId);
    else for (const key of pleaded.length ? pleaded : [deps.computerKey(bot)]) deps.releaseComputer(key);
  };

  const settle = (botId: string, threadId: string, messageId: string, outcome: "done" | "cancelled", saved?: { site: string }): SignInSettled => {
    const bot = store.bot(botId);
    const message = deps.signInMessage(botId, threadId, messageId);
    if (!bot || !message?.signIn) return { status: 404, body: { error: "no such sign-in request" } };
    const card = message.signIn;
    if (card.superseded) return { status: 409, body: { error: "this sign-in request was superseded by a newer one" } };
    if (card.answeredInChat) return { status: 409, body: { error: "this sign-in request was already answered in the chat" } };
    const settled = signInOutcome(card);
    if (settled && settled !== outcome) {
      return { status: 409, body: { error: `this sign-in request was already ${settled === "done" ? "marked done" : "cancelled"}` } };
    }
    if (settled && card.resumed) return { status: 200, body: { [outcome]: true, resumed: true } };
    if (!settled) handPlaceBack(bot, threadId, message.id, card.place);
    const savedLogin = saved?.site ?? card.savedLogin;
    const resumed = deps.answerCardNode(threadId, message.id, savedLogin ? savedLoginResumePrompt(savedLogin) : signInResumePrompt(card.site, outcome));
    store.patchMessage(threadId, message.id, {
      signIn: { ...card, ...(outcome === "done" ? { done: true } : { cancelled: true }), ...(savedLogin ? { savedLogin } : {}), ...(resumed ? { resumed: true, error: undefined } : {}) },
    });
    return { status: 200, body: { [outcome]: true, resumed, ...(savedLogin ? { saved: true, site: savedLogin } : {}) } };
  };

  /** Settles these sign-in cards as answered in the chat, and returns the ids it settled. */
  const answered = (bot: BotRecord, threadId: string, only?: readonly string[]): Array<{ id: string; site: string }> => {
    const settled: Array<{ id: string; site: string }> = [];
    for (const message of store.activePath(threadId)) {
      const card = message.signIn;
      if (message.kind !== "signin" || !card || card.stopped || !signInWaits(card) || (only && !only.includes(message.id))) continue;
      handPlaceBack(bot, threadId, message.id, card.place);
      store.patchMessage(threadId, message.id, { signIn: { ...card, answeredInChat: true, error: undefined } });
      settled.push({ id: message.id, site: card.site });
    }
    return settled;
  };

  /** The person's own line answers every sign-in request still open in their conversation, as Done would. Work handed on
   * that waited on those cards carries the line on (true: no new turn starts for it); a person's own conversation goes on
   * with the turn the line starts, so the work parked there ends and nothing resumes it twice. */
  const answerInChat = (botId: string, threadId: string, line?: string): boolean => {
    const bot = store.bot(botId);
    if (!bot) return false;
    const settled = answered(bot, threadId);
    const parked = deps.parkedDirect(threadId);
    const card = settled.find((one) => parked?.cards?.includes(one.id));
    if (!parked || !card || deps.resumableCards(threadId, parked.startedAt ?? parked.createdAt).some((open) => parked.cards!.includes(open.id))) return false;
    if (parked.parentId && line !== undefined) return deps.answerCardNode(threadId, card.id, signInChatPrompt(card.site, line));
    deps.releaseCardNode(threadId, card.id, "The person answered in the chat");
    return false;
  };

  /** Another bot passed an answer on to the work parked on these cards: they no longer wait on the person. */
  const answeredElsewhere = (node: HandoffView): void => {
    const bot = store.bot(node.botId);
    if (bot) answered(bot, node.threadId, node.cards ?? []);
  };

  /** The bot asked for a sign-in, then went on with that site in the same turn: the sign-in went through. */
  const verified = (botId: string, threadId: string, since: number): void => {
    const bot = store.bot(botId);
    if (!bot) return;
    const path = store.activePath(threadId);
    path.forEach((message, index) => {
      const card = message.signIn;
      if (message.kind !== "signin" || !card || message.at < since || card.stopped || !signInWaits(card)) return;
      const site = card.site.toLowerCase();
      const used = path.slice(index + 1).some((row) => row.kind === "activity" && row.tool?.ok === true && (row.tool.input ?? "").toLowerCase().includes(site));
      if (!used) return;
      handPlaceBack(bot, threadId, message.id, card.place);
      store.patchMessage(threadId, message.id, { signIn: { ...card, done: true, resumed: true, error: undefined } });
    });
  };

  return { settle, answerInChat, answeredElsewhere, verified };
}
