// Security invariants: only an "answer" may name an engine (a decline, or typed words matching no option, is "Not now"),
// so a bot's own shell with decline-only service trust can never switch the engine or resend the person's message.
// A request the job runtime still holds is never sent again: the runtime reruns its root itself.
import { approvalModeFor, modelSwitchNeedsAsk } from "../shared/approval-mode.ts";
import type { QuotaSwitchCardData } from "../shared/wire.ts";
import { recoveryCapabilityError } from "./automatic-recovery.ts";
import type { EngineAccess, ModelCatalog, ModelSelection, ProviderAdapter, ProviderSnapshot } from "./contracts.ts";
import type { Coordinator } from "./coordinator.ts";
import { readyToRun, selectDefaultModelSelection, type SelectableInstance } from "./default-model-selection.ts";
import { classifyError } from "./drivers/retry.ts";
import { PROBE_TIMEOUT_MS } from "./engine-install.ts";
import { spokenLineFields } from "./live-call-record.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { BotRecord, Message, Store, TaskRecord } from "./store.ts";
import type { TurnStops } from "./turn-outcome.ts";
import { signedOutStop, type LimitTakeover, type TakeoverScope } from "./host/limit-takeover.ts";

export interface QuotaSwitchEngine {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  enabled?: boolean;
  models: ModelCatalog;
  adapter: { capabilities: ProviderAdapter["capabilities"] };
  snapshot: () => Promise<ProviderSnapshot>;
}

export interface QuotaRequest {
  generations: ReadonlySet<string>;
  messageId?: string;
  turnId: string | null;
  stopped?: boolean;
  origin?: WorkOrigin;
}

export type SettledTurn = Parameters<TurnStops["failureCause"]>[0];

export interface QuotaSwitchDeps {
  store: Store;
  coordinator: Pick<Coordinator, "all" | "node">;
  registry: { instances(): QuotaSwitchEngine[] };
  turnStops: Pick<TurnStops, "failureCause"> & Partial<Pick<TurnStops, "read">>;
  /** Which AIs carry on while one is limited or signed out, and the one notice for each stretch of either. */
  takeover?: Pick<LimitTakeover, "backups" | "tell" | "moved">;
  /** A custom endpoint brings its own credential, so its sign-in state does not count. */
  access?: (instanceId: string) => EngineAccess | undefined;
  refusal?: (engine: QuotaSwitchEngine) => string | undefined;
  gate: (thread: BotRecord, selection: ModelSelection) => { ok: true; selection: ModelSelection } | { ok: false; error: string };
  reset?: (from: ModelSelection, to: ModelSelection) => Partial<TaskRecord> | undefined;
  busy: (botId: string, threadId: string) => boolean;
  request: (threadId: string) => QuotaRequest | undefined;
  /** A line spoken on a Live call is resent as spoken, so its words stay out of the log. */
  resend: (botId: string, threadId: string, message: Message, replyTo: Message | undefined, spoken: { via?: "call"; callId?: string }) => Promise<unknown>;
  enabled?: () => boolean;
  after?: (ms: number, run: () => void) => { cancel(): void };
}

export interface QuotaSwitch {
  /** Never rejects. */
  turnFailed(bot: BotRecord, event: SettledTurn, internal: boolean): Promise<Message | null>;
  /** Never throws. */
  turnSucceeded(bot: BotRecord, threadId: string): void;
  /** Null when `requestId` is not an open quota card of this thread. "unavailable": refused, and the offer stays open. Never rejects. */
  answer(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown): Promise<QuotaAnswer> | null;
}

export type QuotaAnswer = "answered" | "rejected" | "unavailable";

export const NOT_NOW = "Not now";

const ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** On unless OMB_QUOTA_SWITCH=0: a limited AI's work carries on with another AI by itself. Off, only the backups
 * Automatic recovery names take over, as before. */
export function quotaSwitchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_QUOTA_SWITCH?.trim() !== "0";
}

const nameOf = (engine: QuotaSwitchEngine): string => engine.displayName || engine.driverKind;

/** A line a bot delivered (peerAsk) is never resent in the person's name. */
function resendable(store: Store, threadId: string, messageId: string | undefined): Message | undefined {
  if (!messageId) return undefined;
  const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
  return message?.role === "user" && message.kind === "text" && message.text && !message.peerAsk ? message : undefined;
}

export function createQuotaSwitch(deps: QuotaSwitchDeps): QuotaSwitch {
  const { store, coordinator } = deps;
  const enabled = deps.enabled ?? (() => quotaSwitchEnabled());
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  /** Until one of their turns completes: when a limit reopens is the provider's to say. */
  const limited = new Set<string>();
  /** A turn that works while engines are probed makes the offer stale before it exists. */
  const building = new Set<{ threadId: string; stale: boolean }>();
  /** A second press while the engine is read is the same answer, never another. */
  const answering = new Map<string, Promise<QuotaAnswer>>();

  const notice = (threadId: string, text: string, ok: boolean, setup = false): void => {
    // `notice:` makes it a status row every client shows, never a folded tool step; `setup`: signing in fixes it.
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${text}`, ok, ...(setup ? { setup: true } : {}) } });
  };

  const openCard = (threadId: string): Message | undefined => store.messagesFor(threadId)
    .find((message) => message.card?.quotaSwitch && !message.card.answered && !message.card.dismissed);

  /** Null on a probe timeout: a hung CLI must hold neither a card nor the request that answers one. */
  const described = async (engine: QuotaSwitchEngine): Promise<SelectableInstance | null> => {
    const snapshot = await new Promise<ProviderSnapshot | null>((resolve) => {
      const wait = after(PROBE_TIMEOUT_MS, () => resolve(null));
      // Wrapped so a probe that throws synchronously rejects.
      new Promise<ProviderSnapshot>((read) => read(engine.snapshot())).catch((): ProviderSnapshot => ({ state: "unavailable" }))
        .then((read) => { wait.cancel(); resolve(read); });
    });
    if (!snapshot) return null;
    const access = deps.access?.(engine.instanceId);
    return {
      instanceId: engine.instanceId, driverKind: engine.driverKind, snapshot, models: engine.models, enabled: engine.enabled !== false,
      capabilities: { effortLevels: engine.adapter.capabilities.effortLevels, modelVariants: engine.adapter.capabilities.modelVariants === true },
      ...(access ? { access } : {}),
    };
  };

  /** One rule for the card and for the answer. */
  const takeover = async (engine: QuotaSwitchEngine, bot: BotRecord, current: QuotaSwitchEngine | undefined): Promise<ModelSelection | "timed-out" | null> => {
    // No current engine: no backup check can be made, so none passes.
    if (!current || limited.has(engine.instanceId)) return null;
    if (recoveryCapabilityError(
      { driverKind: current.driverKind, capabilities: current.adapter.capabilities },
      { driverKind: engine.driverKind, capabilities: engine.adapter.capabilities },
    )) return null;
    if (modelSwitchNeedsAsk(approvalModeFor(bot), current.driverKind, engine.driverKind)) return null;
    const context = { refusal: () => deps.refusal?.(engine) };
    const instance = await described(engine);
    if (!instance) return "timed-out";
    if (!readyToRun(instance, context)) return null;
    const selection = selectDefaultModelSelection([instance], undefined, context);
    return selection.instanceId && selection.model ? selection : null;
  };

  /** The newest root: a backup engine's retry or a change of computer begins another root for the same request. */
  const rootOf = (threadId: string, request: QuotaRequest): string | undefined => coordinator.all()
    .filter((node) => !node.parentId && node.threadId === threadId && request.generations.has(node.id))
    .sort((a, b) => a.createdAt - b.createdAt).at(-1)?.id;

  /** Moves the thread to `selection` and sends the person's message that hit the limit (or met a signed-out AI) again
   * there; false when that AI cannot take it now. No await from the readiness check to the resend: the gate, the switch
   * and the resend see one state. */
  const continueOn = async (botId: string, threadId: string, selection: ModelSelection, request: QuotaRequest, build: { stale: boolean }, resetsAt?: number,
    scope: TakeoverScope = "engine"): Promise<boolean> => {
    const engines = deps.registry.instances();
    const engine = engines.find((candidate) => candidate.instanceId === selection.instanceId);
    const before = store.projectBotForTask(botId, threadId);
    const current = before && engines.find((candidate) => candidate.instanceId === before.modelSelection.instanceId);
    if (!engine || !before || !current) return false;
    const ready = engine.instanceId === current.instanceId ? selection : await takeover(engine, before, current);
    const bot = store.projectBotForTask(botId, threadId);
    if (!ready || ready === "timed-out" || !bot || build.stale || !store.taskByThread(botId, threadId)) return false;
    const checked = deps.gate(bot, selection);
    if (!checked.ok) return false;
    try {
      store.switchTaskModel(botId, threadId, checked.selection, false, false, deps.reset?.(bot.modelSelection, checked.selection));
    } catch {
      return false;
    }
    deps.takeover?.moved(botId, threadId, before.modelSelection, checked.selection, resetsAt, scope);
    const name = engine.instanceId === current.instanceId ? `${nameOf(engine)} ${checked.selection.model}` : nameOf(engine);
    const why = scope === "signed-out" ? `while ${nameOf(current)} is signed out` : "after hitting the usage limit";
    const held = heldBy(botId, threadId, rootOf(threadId, request));
    const original = held ? undefined : resendable(store, threadId, request.messageId);
    if (held === "card") notice(threadId, `switched to ${name}. Your request waits on a card above and continues on ${name} once you act on it.`, true);
    else if (held === "runtime") notice(threadId, `switched to ${name}. Your request is still under way here and continues on ${name}.`, true);
    else if (held === "busy") notice(threadId, `switched to ${name}. This conversation is working, so your message was not sent again.`, true);
    else if (held === "question") {
      notice(threadId, `switched to ${name}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again. Answer it, then send your message again.`, false);
    } else if (!original) {
      notice(threadId, `switched to ${name}, but your message could not be found to send again. Send it again.`, false);
    } else {
      notice(threadId, `continuing on ${name} ${why}`, true);
      try {
        await deps.resend(botId, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined, spokenLineFields(original.via, original.callId));
      } catch (error) {
        if (store.taskByThread(botId, threadId)) notice(threadId, `could not continue on ${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
      }
    }
    return true;
  };

  /** A turn its AI's usage limit refused, or that met its AI signed out: the person's own message carries on with the
   * first AI that can take it, the person hears once for this stretch what carries on meanwhile (a sign-out also in this
   * conversation, where signing in fixes it), and the AI's later turns go there too until the limit resets or it is
   * signed in again (the turn start's own check). */
  const turnFailed = async (bot: BotRecord, event: SettledTurn, internal: boolean): Promise<Message | null> => {
    const { threadId } = event;
    try {
      // Read before any await: the record is this turn's only now.
      const request = deps.request(threadId);
      const flags = deps.turnStops.read?.(threadId, event.turnId)?.flags;
      const cause = deps.turnStops.failureCause(event);
      // A tool call's failure names the tool, never the engine's own limit, whatever its words.
      const scope: TakeoverScope | undefined = signedOutStop(event.stopReason, cause) ? "signed-out"
        : flags?.limit ?? (event.stopReason !== "tool_error" && classifyError({ text: cause ?? "" }).reason === "quota" ? "engine" : undefined);
      if (!scope) return null;
      const thread = store.projectBotForTask(bot.id, threadId) ?? bot;
      const from = thread.modelSelection;
      if (scope === "engine") limited.add(from.instanceId);
      // OMB_QUOTA_SWITCH=0: nothing carries on by itself; the person still hears once that the bot waits.
      const backups = enabled() ? deps.takeover?.backups(bot.id, from, scope, approvalModeFor(thread)) ?? [] : [];
      const resetsAt = scope === "signed-out" ? undefined : flags?.limitResetsAt;
      // A sign-out is told once, first and without a backup's name: what the person must do is sign in again.
      const told = scope === "signed-out" ? deps.takeover?.tell(thread, from, { scope }) : undefined;
      if (told) notice(threadId, told, true, true);
      const tell = (backup?: ModelSelection) => {
        if (scope !== "signed-out") deps.takeover?.tell(thread, from, { ...(resetsAt ? { resetsAt } : {}), scope, ...(backup ? { backup } : {}) });
      };
      // Only the person's own request: never a routine's, a webhook's, a relayed or a guest's.
      const own = !internal && request && !request.stopped && request.origin?.kind === "user"
        && (!request.turnId || !event.turnId || request.turnId === event.turnId);
      const relayed = request?.messageId && store.messagesFor(threadId).find((message) => message.id === request.messageId)?.peerAsk;
      if (!own || !request || relayed || !enabled() || openCard(threadId)) {
        tell(backups[0]);
        return null;
      }
      const build = { threadId, stale: false };
      building.add(build);
      try {
        for (const selection of backups) {
          if (await continueOn(bot.id, threadId, selection, request, build, resetsAt, scope)) {
            tell(selection);
            return null;
          }
        }
      } finally {
        building.delete(build);
      }
      tell();
      return null;
    } catch (error) {
      console.warn(`quota switch: could not continue ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const turnSucceeded = (bot: BotRecord, threadId: string): void => {
    limited.delete(bot.modelSelection.instanceId);
    for (const build of building) if (build.threadId === threadId) build.stale = true;
    try {
      const open = openCard(threadId);
      if (open?.card) store.patchMessage(threadId, open.id, { card: { ...open.card, answered: "unavailable", dismissed: true } });
    } catch (error) {
      console.warn(`quota switch: stale card left open in ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** "question": a teammate's waiting question would take the resend as its answer. "busy": a thread already on the
   * chosen engine never meets the switch gate, and its running turn may be the same message typed again. */
  const heldBy = (botId: string, threadId: string, rootId: string | undefined): "card" | "runtime" | "busy" | "question" | null => {
    const root = rootId ? coordinator.node(rootId) : undefined;
    if (root && !ENDED.has(root.status)) return root.cards?.length ? "card" : "runtime";
    if (deps.busy(botId, threadId)) return "busy";
    const asked = coordinator.all().some((node) => node.parentId !== undefined && node.threadId === threadId
      && node.status === "waiting" && node.question !== undefined && !node.cards?.length);
    return asked ? "question" : null;
  };

  /** True once the thread runs on the engine; only then is the offer spent. */
  const decide = async (botId: string, threadId: string, cardId: string, chosen: QuotaSwitchCardData["engines"][number]): Promise<boolean> => {
    const offer = () => {
      const card = store.messagesFor(threadId).find((message) => message.id === cardId)?.card;
      return card?.quotaSwitch && !card.answered && !card.dismissed ? card : undefined;
    };
    /** Rewrites the card even when unchanged: a client folds it on press and must show it open again. */
    const refuse = (why: string, left: (card: NonNullable<Message["card"]>) => Partial<NonNullable<Message["card"]>> = () => ({})): false => {
      const card = offer();
      if (!card) return false;
      notice(threadId, why, false);
      store.patchMessage(threadId, cardId, { card: { ...card, ...left(card) } });
      return false;
    };
    const closed = () => ({ answered: "unavailable", dismissed: true });
    if (!enabled()) return refuse("continuing with another AI is switched off — nothing switched.", closed);
    const engines = deps.registry.instances();
    const engine = engines.find((candidate) => candidate.instanceId === chosen.instanceId);
    if (!engine) {
      const rest = (offer()?.quotaSwitch!.engines ?? []).filter((other) => other.instanceId !== chosen.instanceId);
      if (!rest.length) return refuse(`${chosen.name} is no longer configured, and the card offered no other AI — nothing switched.`, closed);
      return refuse(`${chosen.name} is no longer configured — nothing switched.`,
        (card) => ({ options: [...rest.map((other) => other.name), NOT_NOW], quotaSwitch: { ...card.quotaSwitch!, engines: rest } }));
    }
    const before = store.projectBotForTask(botId, threadId);
    if (!before) return false;
    const current = engines.find((candidate) => candidate.instanceId === before.modelSelection.instanceId);
    if (!current) return refuse("this conversation's own AI is no longer configured here, so no other AI can be checked against it — nothing switched. Choose a model for this conversation instead.", closed);
    const selection = await takeover(engine, before, current);
    // No await from here to the resend: the gate, the switch and the resend must see one state.
    const card = offer();
    const bot = store.projectBotForTask(botId, threadId);
    if (!card || !bot) return false;
    if (selection === "timed-out") return refuse(`${chosen.name} did not answer in time — nothing switched. Try again in a moment.`);
    if (!selection) return refuse(`${chosen.name} is no longer available — nothing switched.`);
    const already = bot.modelSelection.instanceId === selection.instanceId;
    if (!already) {
      const checked = deps.gate(bot, selection);
      if (!checked.ok) return refuse(`could not switch to ${chosen.name} — ${checked.error}`);
      try {
        store.switchTaskModel(botId, threadId, checked.selection, false, false, deps.reset?.(bot.modelSelection, checked.selection));
      } catch {
        return refuse(`could not switch to ${chosen.name} — the model switch could not be saved.`);
      }
    }
    store.patchMessage(threadId, cardId, { card: { ...card, answered: "answer", answeredText: chosen.name } });
    const now = `${already ? "already on" : "switched to"} ${chosen.name}`;
    const held = heldBy(botId, threadId, card.quotaSwitch!.rootId);
    const original = held ? undefined : resendable(store, threadId, card.quotaSwitch!.messageId);
    if (held === "card") notice(threadId, `${now}. Your request waits on a card above and continues on ${chosen.name} once you act on it.`, true);
    else if (held === "runtime") notice(threadId, `${now}. Your request is still under way here and continues on ${chosen.name}.`, true);
    else if (held === "busy") notice(threadId, `${now}. This conversation is working, so your message was not sent again.`, true);
    else if (held === "question") {
      notice(threadId, `${now}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again — answer it, then send your message again.`, false);
    } else if (!original) {
      notice(threadId, `${now}, but the message that hit quota could not be found to resend — send it again.`, false);
    } else {
      notice(threadId, `continuing on ${chosen.name} after hitting quota`, true);
      try {
        await deps.resend(botId, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined, spokenLineFields(original.via, original.callId));
      } catch (error) {
        if (store.taskByThread(botId, threadId)) {
          notice(threadId, `could not continue on ${chosen.name} — ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
        }
      }
    }
    return true;
  };

  const answer: QuotaSwitch["answer"] = (threadId, requestId, behavior, message) => {
    const cardMessage = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
    const card = cardMessage?.card;
    const offer = card?.quotaSwitch;
    if (!cardMessage || !card || !offer || card.answered || card.dismissed) return null;
    const index = behavior === "answer" && typeof message === "string" ? card.options.indexOf(message) : -1;
    const chosen = index >= 0 ? offer.engines[index] : undefined;
    const bot = store.botByThread(threadId);
    if (!chosen || !bot) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...card, answered: "answer", answeredText: NOT_NOW } });
      return Promise.resolve(behavior === "answer" ? "answered" : "rejected");
    }
    let deciding = answering.get(requestId);
    if (!deciding) {
      deciding = decide(bot.id, threadId, cardMessage.id, chosen)
        .then((switched): QuotaAnswer => switched ? "answered" : "unavailable", (error): QuotaAnswer => {
          console.warn(`quota switch: answer for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
          return "unavailable";
        })
        .finally(() => answering.delete(requestId));
      answering.set(requestId, deciding);
    }
    return deciding;
  };

  return { turnFailed, turnSucceeded, answer };
}
