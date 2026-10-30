// The one setup suggestion to add a helper-model key: on a desktop or free install with Gmail connected and no decision
// model, the proactive bot posts ONE short card in its chat ("Want me to sort your email for free?") with Add key, which
// opens Settings → Decision and extraction on the device, and Not now. Never on Cloud, where the keys come with the plan.
// Not now is kept and the card never comes back, until the person connects another inbox: then at most once more. A
// card left unanswered is never posted again. It is a suggestion, not an approval: nothing waits on it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";

export const SUGGESTION_FILE = "helper-suggestion.json";
/** The first card, and one more after Not now and a new inbox. */
export const MAX_OFFERS = 2;
export const HELPER_KEY_SUGGESTION_TEXT = "Want me to sort your email for free? Add a Cloudflare Workers AI key (free tier) or a Jev key.";

const at = z.number().finite().nonnegative();
const stateSchema = z.object({
  version: z.literal(1),
  offers: z.array(z.object({ at, threadId: z.string().max(512), messageId: z.string().max(512), inbox: z.string().max(320).optional() })).max(MAX_OFFERS),
  /** Not now: when, and the inboxes connected then. Only another inbox may bring the card back. */
  notNow: z.object({ at, inboxes: z.array(z.string().max(320)).max(20) }).optional(),
});
type SuggestionState = z.infer<typeof stateSchema>;

export interface HelperSuggestionDeps {
  store: Pick<Store, "appendMessage" | "patchMessage" | "messagesFor" | "patchTask">;
  dataDir: string;
  /** A Cloud home, a hosted team workspace or a Team Cloud: never suggested there. */
  cloud: boolean;
  /** A decision model is set up and on, or the person switched the helper models off: nothing to suggest. */
  settled(): boolean;
  owner(): BotRecord | null;
  mainThread(botId: string): string | undefined;
  threadBusy(botId: string, threadId: string): boolean;
  now?: () => number;
}

export function createHelperSuggestion(deps: HelperSuggestionDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, SUGGESTION_FILE);
  let state: SuggestionState = { version: 1, offers: [] };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
  } catch {
    // No file yet: never suggested.
  }
  const save = (): void => {
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`suggestion: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Whether the card may be posted now: the first time, or once more after Not now when another inbox is connected. */
  function due(inbox: string | undefined): boolean {
    if (!state.offers.length) return true;
    if (!state.notNow || state.offers.length >= MAX_OFFERS) return false;
    return inbox !== undefined && !state.notNow.inboxes.includes(inbox);
  }

  return {
    /** After a check of the proactive routine: Gmail is connected (as `inbox`, its address once read). Posts the card when due. */
    consider(input: { gmailConnected: boolean; inbox?: string }): { posted: string } | null {
      if (deps.cloud || !input.gmailConnected || deps.settled()) return null;
      const inbox = input.inbox?.trim().toLowerCase() || undefined;
      if (!due(inbox)) return null;
      const bot = deps.owner();
      const threadId = bot ? deps.mainThread(bot.id) : undefined;
      if (!bot || !threadId || deps.threadBusy(bot.id, threadId)) return null;
      const message = deps.store.appendMessage(threadId, { role: "bot", kind: "text", text: HELPER_KEY_SUGGESTION_TEXT, setupSuggestion: { kind: "helperKey" } });
      deps.store.patchTask(bot.id, threadId, { unread: true });
      state.offers = [...state.offers, { at: now(), threadId, messageId: message.id, ...(inbox ? { inbox } : {}) }].slice(-MAX_OFFERS);
      save();
      return { posted: message.id };
    },
    /** Not now on the card: only the owner or an admin, only on a card this suggested. Kept; the card says so. */
    notNow(threadId: string, messageId: string, auth: RequestAuth, inboxes: readonly string[]): "kept" | "refused" | "unknown" {
      const offer = state.offers.find((one) => one.threadId === threadId && one.messageId === messageId);
      const row = offer ? deps.store.messagesFor(threadId).find((one) => one.id === messageId) : undefined;
      if (!offer || !row?.setupSuggestion) return "unknown";
      if (!ownerOrAdmin(auth)) return "refused";
      const known = [...new Set([...inboxes, ...state.offers.flatMap((one) => (one.inbox ? [one.inbox] : []))].map((one) => one.toLowerCase()))].slice(0, 20);
      state.notNow = { at: now(), inboxes: known };
      save();
      deps.store.patchMessage(threadId, messageId, { setupSuggestion: { kind: "helperKey", answer: "notNow" } });
      return "kept";
    },
  };
}

export type HelperSuggestion = ReturnType<typeof createHelperSuggestion>;
