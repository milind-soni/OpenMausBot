// Quota-switch card: when a bot's provider quota runs out mid-conversation,
// offer to continue the same thread on another configured engine instead of
// leaving the person to notice, change the model by hand, and start the new
// engine cold.
//
// Follows the harness-native card pattern from peer-approval.ts: a card
// pushed straight into the bot's own thread, tracked by requestId in an
// in-memory pending map, and settled through the same respond-endpoint
// intercept peer comms uses — so nothing front-end has to learn a new card
// shape. This card carries no `tool`, so the client treats it like a
// question (src/lib/card-answer.ts): the option label the user pressed comes
// back verbatim as `message`, with `behavior: "answer"`. That is exactly
// what lets a card with more than an allow/deny answer carry an engine name.
// It DOES set `fixedOptions`, so OptionCard.tsx drops the free-text box that
// a tool-less card otherwise renders beside its buttons — the options here
// are a closed set of engine names, not an open question.
import { newId } from "./contracts.ts";
import type { EffortLevel, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { selectDefaultModelSelection } from "./default-model-selection.ts";
import { classifyError } from "./drivers/retry.ts";
import type { BotRecord, Message, Store } from "./store.ts";

/** What quota-switch needs from a provider instance — a narrow, structural
 * slice of ProviderInstance (mirrors default-model-selection.ts's own
 * SelectableInstance) so tests can hand it plain fakes instead of standing
 * up the real registry. */
export interface QuotaSwitchInstance {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  models: ModelCatalog;
  adapter: { capabilities: { effortLevels?: readonly EffortLevel[] } };
  snapshot: () => Promise<ProviderSnapshot>;
}

/** What quota-switch needs from the outside world. `dispatch` is the one
 * side effect server/index.ts owns that this module cannot: actually
 * launching a turn (server/index.ts's startTurn, with all its admission and
 * lifecycle bookkeeping). Everything else here is store reads/writes. */
export interface QuotaSwitchDeps {
  store: Store;
  /** Every engine currently configured for this workspace (registry.instances()). */
  instances: () => QuotaSwitchInstance[];
  /** Re-dispatch the turn that failed, on the bot's now-switched engine. */
  dispatch: (botId: string, threadId: string, text: string) => void;
}

const MAX_ALTERNATIVES = 3;
const NOT_NOW = "Not now";

interface PendingQuotaCard {
  threadId: string;
  messageId: string;
  botId: string;
  /** the options offered, in the order shown on the card — matched back
   * against the label the user pressed (the card carries no `tool`, so the
   * wire answer is the label text itself, never an instanceId). */
  alternatives: Array<{ instanceId: string; displayName: string }>;
  /** id of the user message whose turn hit quota, captured the moment the
   * card was raised — NOT re-derived at answer time. The composer stays
   * unblocked while this card is pending (fixedOptions only hides the
   * stray free-text box, it does not lock the thread), so a person can
   * type a new message before answering; re-scanning "the last user
   * message" at answer time would then resend the wrong one, or silently
   * skip an image-only original whose caption is empty. Undefined only
   * when the turn that failed had no user message to find (a bot's own
   * unattended/system-initiated turn). */
  userMessageId: string | undefined;
}

/** requestId → pending quota-switch offer. In memory only, like peer
 * comms — a restart cancels every in-flight offer along with everything
 * else a live turn was holding. */
const pendingQuotaCards = new Map<string, PendingQuotaCard>();
/** threadId → requestId, so at most one quota card is ever pending per
 * thread — a bot that keeps hitting quota must not stack offers. */
const pendingQuotaThreadIds = new Map<string, string>();

function displayNameOf(instance: QuotaSwitchInstance): string {
  return instance.displayName ?? instance.driverKind;
}

/** The same bar selectDefaultModelSelection's own "pick anything available"
 * fallback uses. Checking it here too — when the card is BUILT, not only
 * when it is answered — is what keeps an unconfigured or signed-out engine
 * off the card in the first place, instead of merely failing silently once
 * chosen. */
function isAvailable(snapshot: ProviderSnapshot): boolean {
  return snapshot.state === "available";
}

function postChip(store: Store, threadId: string, name: string, ok: boolean): void {
  store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name, ok } });
}

/** Raise a quota-switch card in `bot`'s thread, offering the other engines
 * this workspace has configured AND currently available, when
 * `errorMessage` classifies as a quota failure (server/drivers/retry.ts's
 * classifyError — the same terminal reason a driver's own retry policy
 * already recognizes as unretryable). `userMessageId` is the id of the user
 * message whose turn just failed — capture it from the runtime.error
 * event's own thread context (the active path's last user message) BEFORE
 * calling this, not later, since the composer stays open while the card is
 * pending. Returns the card message, or null when the error was not a
 * quota error, there are no available alternatives, or a card is already
 * pending on this thread — a caller never has to check any of that itself.
 *
 * Async because availability is checked per candidate (instance.snapshot())
 * before anything is offered — never at click time only. */
export async function maybeRaiseQuotaCard(
  deps: QuotaSwitchDeps,
  bot: BotRecord,
  threadId: string,
  errorMessage: string,
  userMessageId: string | undefined,
): Promise<Message | null> {
  if (classifyError({ text: errorMessage }).reason !== "quota") return null;
  if (pendingQuotaThreadIds.has(threadId)) return null;
  const instances = deps.instances();
  const currentInstanceId = bot.modelSelection.instanceId;
  const candidates = instances.filter((instance) => instance.instanceId !== currentInstanceId);
  const availability = await Promise.all(
    candidates.map(async (instance) => {
      try {
        return await instance.snapshot();
      } catch {
        return { state: "unavailable" as const };
      }
    }),
  );
  const alternatives = candidates
    .filter((_, index) => isAvailable(availability[index]!))
    .slice(0, MAX_ALTERNATIVES)
    .map((instance) => ({ instanceId: instance.instanceId, displayName: displayNameOf(instance) }));
  if (alternatives.length === 0) return null;
  // Another quota card could have been raised on this thread while the
  // snapshots above were in flight — re-check right before writing.
  if (pendingQuotaThreadIds.has(threadId)) return null;
  const current = instances.find((instance) => instance.instanceId === currentInstanceId);
  const currentName = current ? displayNameOf(current) : "This engine";
  const requestId = newId();
  const card = deps.store.appendMessage(threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `${currentName} is out of quota`,
      subtitle: "Continue this conversation on another engine?",
      options: [...alternatives.map((alt) => alt.displayName), NOT_NOW],
      requestId,
      fixedOptions: true,
    },
  });
  pendingQuotaCards.set(requestId, { threadId, messageId: card.id, botId: bot.id, alternatives, userMessageId });
  pendingQuotaThreadIds.set(threadId, requestId);
  return card;
}

/** Mark the card answered so the UI stops treating it as pending — the same
 * hand-back peer-approval's settleCard does. `answered` stays the generic
 * "answer" verdict and `answeredText` carries the actual words, matching how
 * every other question-shaped card (no `tool`) remembers its reply — see
 * server/index.ts's answerRequest, which does the same for provider asks. */
function settleQuotaCard(store: Store, pending: PendingQuotaCard, chosenText: string): void {
  const existing = store.messagesFor(pending.threadId).find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: "answer", answeredText: chosenText },
  });
}

/** Pick a valid model for `instance`, reusing the exact same logic new bots
 * get their default model from (server/default-model-selection.ts) instead
 * of inventing a second "what's a safe model for this engine" rule. Handing
 * it only this one instance means it either returns that instance with its
 * default model, or — if the instance is no longer available — the empty
 * selection selectDefaultModelSelection uses to say "nothing to offer".
 * This is the SECOND availability check (the first is at card-build time,
 * above): state can change in the time the card sat open, so this stays as
 * the last line of defence — its failure is made visible by the caller,
 * never silent. */
async function pickSelection(instance: QuotaSwitchInstance): Promise<ModelSelection> {
  const snapshot = await instance.snapshot();
  return selectDefaultModelSelection([
    {
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      snapshot,
      models: instance.models,
      capabilities: { effortLevels: instance.adapter.capabilities.effortLevels },
    },
  ]);
}

/** Switch the bot onto `chosen` and re-dispatch the turn that failed. Runs
 * after the card is already settled, so a slow snapshot() never leaves the
 * card looking pending. Every early return posts a chip explaining what
 * happened instead — nothing here fails silently. */
async function switchAndRedispatch(
  deps: QuotaSwitchDeps,
  pending: PendingQuotaCard,
  chosen: { instanceId: string; displayName: string },
): Promise<void> {
  const instance = deps.instances().find((candidate) => candidate.instanceId === chosen.instanceId);
  if (!instance) {
    postChip(deps.store, pending.threadId, `${chosen.displayName} is no longer configured — nothing switched.`, false);
    return;
  }
  const selection = await pickSelection(instance);
  if (!selection.instanceId) {
    postChip(deps.store, pending.threadId, `${chosen.displayName} is no longer available — nothing switched.`, false);
    return;
  }
  const patchedBot = deps.store.patchBot(pending.botId, { modelSelection: selection });
  if (!patchedBot) return; // the bot was deleted meanwhile — no thread left to chip into
  deps.store.patchTask(pending.botId, pending.threadId, { modelSelection: selection });

  // Re-dispatch EXACTLY the message that failed — captured by id when the
  // card was raised, not re-derived now. Its text carries the original
  // attachment tags verbatim (server/turn-images.ts reads them back out of
  // the text itself), so resending it resends any attachments too.
  const original = pending.userMessageId
    ? deps.store.messagesFor(pending.threadId).find((m) => m.id === pending.userMessageId)
    : undefined;
  if (!original?.text) {
    postChip(
      deps.store,
      pending.threadId,
      `switched to ${chosen.displayName}, but the message that hit quota could not be found to resend — send it again.`,
      false,
    );
    return;
  }
  postChip(deps.store, pending.threadId, `continuing on ${chosen.displayName} after hitting quota`, true);
  deps.dispatch(pending.botId, pending.threadId, original.text);
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter, exactly where resolvePeerComms is (server/index.ts). Returns
 * true if the requestId belonged to a pending quota offer (and resolves
 * it); false if it was someone else's card and the endpoint should keep
 * looking. An answer that names none of the offered engines (including a
 * free-text reply reaching this endpoint directly, bypassing the client's
 * own fixedOptions gate) is treated exactly like "Not now": the card
 * settles and nothing switches. The switch + re-dispatch happen after
 * returning — this stays synchronous so it slots into the same
 * `if (... && resolveX(...))` chain resolvePeerComms already sits in. */
export function resolveQuotaSwitch(deps: QuotaSwitchDeps, requestId: string, message: string | undefined): boolean {
  const pending = pendingQuotaCards.get(requestId);
  if (!pending) return false;
  pendingQuotaCards.delete(requestId);
  if (pendingQuotaThreadIds.get(pending.threadId) === requestId) pendingQuotaThreadIds.delete(pending.threadId);
  const chosen = pending.alternatives.find((alt) => alt.displayName === message);
  settleQuotaCard(deps.store, pending, chosen ? chosen.displayName : NOT_NOW);
  if (chosen) void switchAndRedispatch(deps, pending, chosen);
  return true;
}
