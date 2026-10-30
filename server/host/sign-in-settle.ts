// How a sign-in card settles: Done or Cancel on the card, a saved login filling it, or the person's own line in the
// conversation, which answers every sign-in request still open there.
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
  parkedDirect(threadId: string): HandoffView | undefined;
  /** Ends the card's plea for help and returns the computers it held. */
  settleHelp(messageId: string): string[];
  handBackBrowser(bot: BotRecord, threadId: string): void;
  releaseComputer(key: string): void;
  computerKey(bot: BotRecord): string;
}

export type SignInSettled = { status: number; body: Record<string, unknown> };

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

  /** The person's own line answers every sign-in request still open in their conversation, as Done would, and ends the
   * work parked on those cards: the turn the line starts goes on with the conversation, so nothing resumes it twice. */
  const answerInChat = (botId: string, threadId: string): void => {
    const bot = store.bot(botId);
    if (!bot) return;
    const answered: string[] = [];
    for (const message of store.activePath(threadId)) {
      const card = message.signIn;
      if (message.kind !== "signin" || !card || card.stopped || !signInWaits(card)) continue;
      handPlaceBack(bot, threadId, message.id, card.place);
      store.patchMessage(threadId, message.id, { signIn: { ...card, answeredInChat: true, error: undefined } });
      answered.push(message.id);
    }
    const parked = deps.parkedDirect(threadId);
    const card = parked?.cards?.find((id) => answered.includes(id));
    if (!parked || !card || deps.resumableCards(threadId, parked.startedAt ?? parked.createdAt).some((open) => parked.cards!.includes(open.id))) return;
    deps.releaseCardNode(threadId, card, "The person answered in the chat");
  };

  return { settle, answerInChat };
}
