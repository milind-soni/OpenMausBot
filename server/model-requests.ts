// propose_model: a bot (or a Chief, for a section peer) proposes changing
// one bot's default engine/model. Mirrors profile-requests.ts — same card
// shape, same propose/confirm split, same fail-closed confirm — but the
// change commits through Store.applyModelDefault, which stamps tasks
// exactly like applyTeamSetup: saved per-thread selections are never
// rewritten. Staleness is a snapshot of the one field being changed, not
// the team-setup plan's whole-state revision hash.
import type { ModelRequestCardData } from "../shared/model-request.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { harnessCapabilityLines, type DriverCapabilities } from "./harness-capabilities.ts";
import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord } from "./store.ts";

const MAX_REASON = 500;
const STALE = "This bot's default model changed after this card was prepared. Ask the bot to review it and propose again.";
const NO_SUCH_BOT = "That bot no longer exists";

export interface OptionCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  modelRequest?: ModelRequestCardData;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
export interface ModelRequestStore {
  bot(id: string): BotRecord | undefined | null;
  messagesFor(threadId: string): Array<{ id: string; card?: OptionCardLike }>;
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options";
      card: OptionCardLike;
      from?: { botId: string; name: string; color: string };
    },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): { id: string } | null;
  /** The reviewed commit path: replaces the default and stamps tasks the
   * same way applyTeamSetup does, so per-thread selections survive. */
  applyModelDefault(id: string, selection: ModelSelection): BotRecord | null;
}

export interface ModelRequestServiceOptions {
  store: ModelRequestStore;
  now?: () => number;
  /** Server-owned effective mode of the source conversation, never request input. */
  autoApply?: (botId: string, threadId: string) => boolean;
  canPersist?: (botId: string, threadId: string) => { ok: true } | { ok: false; status: number; error: string };
  /** Chief targeting another bot: returns a refusal sentence or null. Checked at propose AND confirm. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
  /** Full model validation (structure, catalog, approval compatibility): a refusal sentence or null. Re-run at confirm. */
  validateModel?: (selection: ModelSelection, current: BotRecord) => string | null;
  /** Per-driver capability resolver backing the card's engine-switch warnings. */
  driverCapabilities?: (instanceId: string) => DriverCapabilities | undefined;
}

export class ModelRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

export type ResolveModelRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; targetBotId: string; settlementPending?: true; message?: string };

const sameSelection = (a: ModelSelection, b: ModelSelection) =>
  a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;

function reasonText(value: unknown): string {
  if (typeof value !== "string") throw new ModelRequestError("reason is required");
  const trimmed = value.trim();
  if (!trimmed) throw new ModelRequestError("reason is required");
  if (trimmed.length > MAX_REASON) throw new ModelRequestError("reason must be 500 characters or fewer");
  return redactSecretsInText(trimmed);
}

/** Structural check only — the injected validateModel hook owns catalog and
 * approval-compatibility checks with the live registry, at propose and again
 * at confirm. */
function parseSelection(input: unknown): ModelSelection {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRequestError("model_selection must be an object with instanceId and model");
  }
  const value = input as { instanceId?: unknown; model?: unknown; effort?: unknown; variant?: unknown };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
    throw new ModelRequestError("model_selection.instanceId is required");
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new ModelRequestError("model_selection.model is required");
  }
  const selection: ModelSelection = { instanceId: value.instanceId.trim(), model: value.model.trim() };
  if (value.effort !== undefined) {
    if (typeof value.effort !== "string" || !value.effort.trim()) throw new ModelRequestError("model_selection.effort must be a level name");
    selection.effort = value.effort as ModelSelection["effort"];
  }
  if (value.variant !== undefined) {
    if (typeof value.variant !== "string" || !value.variant.trim()) throw new ModelRequestError("model_selection.variant must be a variant id");
    selection.variant = value.variant;
  }
  return selection;
}

export function modelCardCopy(args: {
  targetName: string;
  crossBot: boolean;
  before: ModelSelection;
  selection: ModelSelection;
  reason: string;
  capabilityLines: string[];
}): { title: string; summary: string; detail: string } {
  const title = args.crossBot
    ? "Change @" + args.targetName + "'s default engine/model?"
    : "Change " + args.targetName + "'s default engine/model?";
  const lines: string[] = args.crossBot
    ? ["Whose default model: @" + args.targetName, "Why: " + args.reason]
    : ["Why: " + args.reason];
  lines.push("Default engine/model: " + JSON.stringify(args.before) + " → " + JSON.stringify(args.selection));
  lines.push(...args.capabilityLines);
  // The same consent line the team-setup card shows for a model change:
  // the default moves, saved thread selections do not.
  lines.push("Default models apply to groups and new threads. Every existing thread keeps its current model and permissions.");
  lines.push("Nothing runs.");
  return { title, summary: title + " · default engine/model", detail: lines.join("\n") };
}

export class ModelRequestService {
  private readonly store: ModelRequestStore;
  private readonly now: () => number;
  private readonly canPersist?: ModelRequestServiceOptions["canPersist"];
  private readonly autoApply?: ModelRequestServiceOptions["autoApply"];
  private readonly validateTarget?: ModelRequestServiceOptions["validateTarget"];
  private readonly validateModel?: ModelRequestServiceOptions["validateModel"];
  private readonly driverCapabilities?: ModelRequestServiceOptions["driverCapabilities"];

  constructor(options: ModelRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.canPersist = options.canPersist;
    this.autoApply = options.autoApply;
    this.validateTarget = options.validateTarget;
    this.validateModel = options.validateModel;
    this.driverCapabilities = options.driverCapabilities;
  }

  propose(args: {
    botId: string;
    threadId: string;
    targetBotId?: string;
    selection: unknown;
    reason: unknown;
    from?: { botId: string; name: string; color: string };
  }): { requestId: string; messageId: string; title: string; summary: string; detail: string } {
    return this.prepare(args);
  }

  submit(args: Parameters<ModelRequestService["propose"]>[0]) {
    const proposal = this.prepare(args, true);
    return { ...proposal, state: proposal.result ? "applied" as const : "pending" as const };
  }

  private prepare(args: Parameters<ModelRequestService["propose"]>[0], submitted = false): {
    requestId: string; messageId: string; title: string; summary: string; detail: string;
    result?: Extract<ResolveModelRequestResult, { state: "applied" }>;
  } {
    const reason = reasonText(args.reason);
    const selection = parseSelection(args.selection);

    const targetBotId = args.targetBotId?.trim() || args.botId;
    const target = this.store.bot(targetBotId);
    if (!target) throw new ModelRequestError(NO_SUCH_BOT, 404);
    const crossBot = targetBotId !== args.botId;
    if (crossBot && this.validateTarget) {
      const refusal = this.validateTarget(args.botId, targetBotId);
      if (refusal) throw new ModelRequestError(refusal, 403);
    }
    if (sameSelection(selection, target.modelSelection)) throw new ModelRequestError("Nothing would change");
    if (this.validateModel) {
      const refusal = this.validateModel(selection, target);
      if (refusal) throw new ModelRequestError(refusal, 400);
    }

    const requestId = newId();
    const targetName = redactSecretsInText(target.name);
    const before = structuredClone(target.modelSelection);
    const capabilityLines = this.driverCapabilities
      ? harnessCapabilityLines(this.driverCapabilities(before.instanceId), this.driverCapabilities(selection.instanceId))
      : [];
    const payload: ModelRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      targetBotId,
      targetName,
      createdAt: this.now(),
      reason,
      selection,
      before,
    };
    const copy = modelCardCopy({ targetName, crossBot, before, selection, reason, capabilityLines });
    const persistence = this.canPersist?.(args.botId, args.threadId);
    if (persistence && !persistence.ok) throw new ModelRequestError(persistence.error, persistence.status);
    const automatic = submitted && this.autoApply?.(args.botId, args.threadId) === true;
    const messageInput: Parameters<ModelRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: automatic ? [] : ["Confirm", "Cancel"],
        ...(automatic ? { dismissed: true } : {}),
        requestId,
        tool: "update_model",
        modelRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const message = this.store.appendMessage(args.threadId, messageInput);
    const proposal = { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
    if (!automatic) return proposal;
    const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
    if (result.state === "applied") return { ...proposal, result };
    throw new ModelRequestError(result.state === "invalid" ? result.error : "The model change could not be applied", result.state === "invalid" ? result.status : 409);
  }

  /** Claims a model card even after it was settled, so a duplicate click
   * never re-applies an already-applied change. */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveModelRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.modelRequest);
    const card = message?.card;
    const payload = card?.modelRequest;
    if (!message || !card || !payload) return { claimed: false, state: "not_found" };
    if (payload.requestId !== card.requestId) {
      return { claimed: true, state: "invalid", error: "This model request does not match its card", status: 409 };
    }
    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return { claimed: true, state: "invalid", error: "Model confirmations must be confirmed or cancelled", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return { claimed: true, state: "invalid", error: "This model request belongs to another conversation", status: 403 };
    }
    if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };
    // Cross-bot cards re-check authority on every allow, before any settle
    // path can run: a proposer who lost Chief rights must not confirm, even
    // when the requested selection is already live. Card level, not inside
    // the try, so the crash-recovery catch cannot recast a refusal as an
    // applied change.
    if (args.behavior === "allow" && payload.targetBotId !== payload.botId && this.validateTarget) {
      const refusal = this.validateTarget(payload.botId, payload.targetBotId);
      if (refusal) return { claimed: true, state: "invalid", error: refusal, status: 404 };
    }

    try {
      const target = this.store.bot(payload.targetBotId);
      if (!target) throw new ModelRequestError(NO_SUCH_BOT, 404);
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      // Idempotent close: if the exact requested selection is already the
      // default (a crash after apply, or the same change arriving twice),
      // settle the card without mutating anything again.
      if (sameSelection(payload.selection, target.modelSelection)) {
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, modelRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new ModelRequestError("This model confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      if (!sameSelection(payload.before, target.modelSelection)) {
        throw new ModelRequestError(STALE, 409);
      }
      if (this.validateModel) {
        const refusal = this.validateModel(payload.selection, target);
        if (refusal) throw new ModelRequestError(refusal, 409);
      }
      if (!this.store.applyModelDefault(target.id, payload.selection)) throw new ModelRequestError(NO_SUCH_BOT, 404);

      const appliedAt = this.now();
      const settled = this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined, modelRequest: { ...payload, appliedAt } },
      });
      if (!settled) throw new ModelRequestError("This model confirmation card is no longer available", 409);
      return { claimed: true, state: "applied", targetBotId: target.id };
    } catch (error) {
      const status = error instanceof ModelRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const applied = sameSelection(payload.selection, this.store.bot(payload.targetBotId)?.modelSelection ?? payload.before);
      const notice = card.dismissed && card.options.length === 0
        ? "Default model saved. Recording the operation receipt could not finish; the change will not be applied again."
        : "Default model saved. Confirm again to finish recording this decision; the change will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, held: applied ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch { /* The idempotent close above still permits a safe retry. */ }
      if (applied) return {
        claimed: true, state: "applied", targetBotId: payload.targetBotId,
        settlementPending: true, message: notice,
      };
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
