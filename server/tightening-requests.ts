// propose_tightening: a bot (or a Chief for a section peer) proposes an
// authority REDUCTION through a human-confirmed card. Same shape as
// profile-requests.ts: everything is re-validated at confirm time — a card
// can sit open for days, so the direction is checked against live state
// again and the revision (a hash of the touched authority surface) must
// still match. Escalation is inexpressible in the payload and rejected by
// the validator; restoring authority stays owner-only in Edit Profile.
import { createHash } from "node:crypto";
import { z } from "zod";

import { approvalModeFor } from "../shared/approval-mode.ts";
import {
  TIGHTENING_MODE_TARGETS,
  validateTightening,
  type TighteningIntents,
  type TighteningRequestCardData,
  type TighteningState,
} from "../shared/tightening-request.ts";
import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { OptionCardLike } from "./profile-requests.ts";
import type { BotRecord } from "./store.ts";

const MAX_REASON = 500;
const STALE = "This bot's authority changed after this card was prepared. Ask the bot to review it and propose again.";
const NO_SUCH_BOT = "That bot no longer exists";
const CHOOSE_ONE = "Choose at least one tightening intent: approvalMode, composio, browser, approvePeerComms, alwaysAllow, mcpServers, skills";

const INTENT_KEYS = [
  "approvalMode",
  "composio",
  "browser",
  "approvePeerComms",
  "alwaysAllow",
  "mcpServers",
  "skills",
] as const satisfies readonly (keyof TighteningIntents)[];

/** Direction is enforced by shape first: the payload cannot name "full" or
 * "custom" as a target, cannot ask to switch composio/browser back on, and
 * the list fields only carry removals. The state-relative remainder (an
 * upward move inside ask/edits/auto, a grant not currently held) is checked
 * by validateTightening against live state at propose and confirm. */
const intentsSchema = z.object({
  approvalMode: z.enum(TIGHTENING_MODE_TARGETS, {
    error: 'approvalMode may only be proposed as "ask", "edits", or "auto"; full and custom stay owner-only',
  }).optional(),
  composio: z.literal(false, { error: "composio may only be turned off" }).optional(),
  browser: z.literal(false, { error: "browser may only be turned off" }).optional(),
  approvePeerComms: z.literal(true, { error: "approvePeerComms may only be turned on" }).optional(),
  alwaysAllow: z.array(z.string().min(1).max(200)).max(200).optional(),
  mcpServers: z.array(z.string().min(1).max(200)).max(100).optional(),
  skills: z.array(z.string().min(1).max(100)).max(100).optional(),
});

export interface TighteningRequestStore {
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
  patchBot(
    id: string,
    patch: Partial<Pick<BotRecord,
      | "approvalMode"
      | "autoApprove"
      | "approvalGrant"
      | "alwaysAllow"
      | "mcpServers"
      | "approvePeerComms"
      | "composio"
      | "browser"
      | "lastTighteningRequestId">>,
  ): BotRecord | null;
}

export interface TighteningRequestServiceOptions {
  store: TighteningRequestStore;
  now?: () => number;
  /** Server-owned effective mode of the source conversation, never request input. */
  autoApply?: (botId: string, threadId: string) => boolean;
  canPersist?: (botId: string, threadId: string) => { ok: true } | { ok: false; status: number; error: string };
  /** Chief targeting another bot: returns a refusal sentence or null. Checked at propose AND confirm. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
  /** Effective mounted MCP server names (config-aware); default reads the bot record only. */
  mountedMcpServers?: (bot: BotRecord) => string[];
  /** Enabled skill names for a bot; default none. */
  enabledSkills?: (botId: string) => string[];
  /** Disable one enabled skill (wired to setSkillEnabled(botId, name, false)). */
  disableSkill?: (botId: string, name: string) => { ok: true } | { ok: false; error: string };
  /** True while the target is running a turn; approvalMode and mcpServers reductions wait for idle, like the owner's own routes. */
  targetBusy?: (botId: string) => boolean;
}

export class TighteningRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TighteningRequestError";
    this.status = status;
  }
}

export type ResolveTighteningRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; targetBotId: string; fields: string[]; emergencyStop?: boolean };

interface TighteningCardCopy {
  title: string;
  summary: string;
  detail: string;
}

function reasonText(value: unknown): string {
  if (typeof value !== "string") throw new TighteningRequestError("reason is required");
  const trimmed = value.trim();
  if (!trimmed) throw new TighteningRequestError("reason is required");
  if (trimmed.length > MAX_REASON) {
    throw new TighteningRequestError(`reason must be ${MAX_REASON} characters or fewer`);
  }
  return redactSecretsInText(trimmed);
}

function parseIntents(input: unknown): TighteningIntents {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TighteningRequestError(CHOOSE_ONE);
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(INTENT_KEYS as readonly string[]).includes(key)) {
      throw new TighteningRequestError(`unsupported tightening field: ${key}`);
    }
  }
  const parsed = intentsSchema.safeParse(input);
  if (!parsed.success) {
    throw new TighteningRequestError(parsed.error.issues[0]?.message ?? CHOOSE_ONE);
  }
  const intents = parsed.data;
  // Copy through only the keys the caller sent, so "did this card touch
  // approvalMode" stays answerable from the payload alone.
  const present: TighteningIntents = {};
  if (record.approvalMode !== undefined) present.approvalMode = intents.approvalMode;
  if (record.composio !== undefined) present.composio = intents.composio;
  if (record.browser !== undefined) present.browser = intents.browser;
  if (record.approvePeerComms !== undefined) present.approvePeerComms = intents.approvePeerComms;
  if (record.alwaysAllow !== undefined) present.alwaysAllow = intents.alwaysAllow;
  if (record.mcpServers !== undefined) present.mcpServers = intents.mcpServers;
  if (record.skills !== undefined) present.skills = intents.skills;
  if (Object.keys(present).length === 0) throw new TighteningRequestError(CHOOSE_ONE);
  return present;
}

/** The card revision: a hash of exactly the authority surface a tightening
 * can touch, plus the private receipt (an older, interrupted card cannot
 * apply twice). Sorted lists so an unrelated reorder is not a false stale. */
export function tighteningRevision(state: TighteningState, lastTighteningRequestId = ""): string {
  return createHash("sha256")
    .update(JSON.stringify({
      approvalMode: state.approvalMode,
      composio: state.composio,
      browser: state.browser,
      approvePeerComms: state.approvePeerComms,
      alwaysAllow: [...state.alwaysAllow].sort(),
      mcpServers: [...state.mcpServers].sort(),
      skills: [...state.skills].sort(),
      lastTighteningRequestId,
    }), "utf8")
    .digest("hex");
}

export function tighteningSnapshot(
  bot: BotRecord,
  extras: { mcpServers?: string[]; skills?: string[] },
): TighteningState {
  return {
    approvalMode: approvalModeFor(bot),
    composio: bot.composio !== false,
    browser: bot.browser !== false,
    approvePeerComms: bot.approvePeerComms === true,
    alwaysAllow: bot.alwaysAllow ?? [],
    mcpServers: extras.mcpServers ?? [...(bot.mcpServers ?? [])],
    skills: extras.skills ?? [],
  };
}

/** Minimal card copy: the judged facts (field, before, after, names) plus
 * the standing rule that only the owner can grant authority back. */
export function tighteningCardCopy(
  target: { name: string; crossBot: boolean },
  before: TighteningState,
  intents: TighteningIntents,
  reason: string,
): TighteningCardCopy {
  const title = target.crossBot ? `Tighten @${target.name}'s permissions?` : `Tighten ${target.name}'s permissions?`;
  const lines: string[] = target.crossBot ? [`Whose permissions: @${target.name}`, `Why: ${reason}`] : [`Why: ${reason}`];
  if (intents.approvalMode !== undefined) lines.push(`Approvals: ${before.approvalMode} → ${intents.approvalMode}`);
  if (intents.composio !== undefined) lines.push("Connected apps: on → off");
  if (intents.browser !== undefined) lines.push("Browser: on → off");
  if (intents.approvePeerComms !== undefined) lines.push("Peer contact: no approval → ask first");
  if (intents.alwaysAllow?.length) lines.push(`Always-allow grants: remove ${intents.alwaysAllow.join(", ")}`);
  if (intents.mcpServers?.length) lines.push(`MCP servers: unmount ${intents.mcpServers.join(", ")}`);
  if (intents.skills?.length) lines.push(`Skills: disable ${intents.skills.join(", ")}`);
  lines.push(`This reduces ${target.name}'s authority. Only the owner can grant it back.`);
  const fields = INTENT_KEYS.filter((key) => intents[key] !== undefined);
  return { title, summary: `${title} · ${fields.join(", ")}`, detail: lines.join("\n") };
}

export class TighteningRequestService {
  private readonly store: TighteningRequestStore;
  private readonly now: () => number;
  private readonly canPersist?: TighteningRequestServiceOptions["canPersist"];
  private readonly autoApply?: TighteningRequestServiceOptions["autoApply"];
  private readonly mountedMcpServers?: TighteningRequestServiceOptions["mountedMcpServers"];
  private readonly enabledSkills?: TighteningRequestServiceOptions["enabledSkills"];
  private readonly disableSkill?: TighteningRequestServiceOptions["disableSkill"];
  private readonly targetBusy?: TighteningRequestServiceOptions["targetBusy"];
  /** Public: a caller's section membership can change between propose and
   * confirm, and tests flip this mid-scenario to model that. */
  validateTarget?: TighteningRequestServiceOptions["validateTarget"];

  constructor(options: TighteningRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.canPersist = options.canPersist;
    this.autoApply = options.autoApply;
    this.mountedMcpServers = options.mountedMcpServers;
    this.enabledSkills = options.enabledSkills;
    this.disableSkill = options.disableSkill;
    this.targetBusy = options.targetBusy;
    this.validateTarget = options.validateTarget;
  }

  private snapshotOf(bot: BotRecord): TighteningState {
    return tighteningSnapshot(bot, {
      mcpServers: this.mountedMcpServers?.(bot),
      skills: this.enabledSkills?.(bot.id) ?? [],
    });
  }

  /** Disable every named skill, or report the first failure together with
   * the names still outstanding. Shared by the fresh apply and the
   * receipt-backed retry so both leave the same trail. */
  private applySkillDisables(botId: string, names: string[]): { ok: true } | { ok: false; error: string; outstanding: string[] } {
    for (let index = 0; index < names.length; index += 1) {
      const disabled = this.disableSkill!(botId, names[index]!);
      if (!disabled.ok) return { ok: false, error: disabled.error, outstanding: names.slice(index) };
    }
    return { ok: true };
  }

  propose(args: {
    botId: string;
    threadId: string;
    targetBotId?: string;
    intents: unknown;
    reason: unknown;
    from?: { botId: string; name: string; color: string };
  }): { requestId: string; messageId: string; title: string; summary: string; detail: string } {
    return this.prepare(args);
  }

  submit(args: Parameters<TighteningRequestService["propose"]>[0]) {
    const proposal = this.prepare(args, true);
    return { ...proposal, state: proposal.result ? "applied" as const : "pending" as const };
  }

  private prepare(args: Parameters<TighteningRequestService["propose"]>[0], submitted = false): {
    requestId: string; messageId: string; title: string; summary: string; detail: string;
    result?: Extract<ResolveTighteningRequestResult, { state: "applied" }>;
  } {
    const reason = reasonText(args.reason);
    const intents = parseIntents(args.intents);

    const targetBotId = args.targetBotId ?? args.botId;
    const target = this.store.bot(targetBotId);
    if (!target) throw new TighteningRequestError(NO_SUCH_BOT, 404);
    const crossBot = targetBotId !== args.botId;
    if (crossBot && this.validateTarget) {
      const refusal = this.validateTarget(args.botId, targetBotId);
      if (refusal) throw new TighteningRequestError(refusal, 403);
    }

    const before = this.snapshotOf(target);
    const checked = validateTightening(before, intents);
    if (!checked.ok) throw new TighteningRequestError(checked.error, 400);

    const requestId = newId();
    const targetName = redactSecretsInText(target.name);
    const payload: TighteningRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      targetBotId,
      targetName,
      createdAt: this.now(),
      reason,
      intents,
      before,
      expectedRevision: tighteningRevision(before, target.lastTighteningRequestId),
    };

    const copy = tighteningCardCopy({ name: targetName, crossBot }, before, intents, reason);
    const persistence = this.canPersist?.(args.botId, args.threadId);
    if (persistence && !persistence.ok) {
      throw new TighteningRequestError(persistence.error, persistence.status);
    }
    const automatic = submitted && this.autoApply?.(args.botId, args.threadId) === true;
    const messageInput: Parameters<TighteningRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: automatic ? [] : ["Confirm", "Cancel"],
        ...(automatic ? { dismissed: true } : {}),
        requestId,
        tool: "tighten_permissions",
        tighteningRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const message = this.store.appendMessage(args.threadId, messageInput);
    const proposal = { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
    if (!automatic) return proposal;
    // The hidden receipt is persisted before the authority changes. The same
    // validation and durable commit marker serve both automatic and human decisions.
    const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
    if (result.state === "applied") return { ...proposal, result };
    throw new TighteningRequestError(result.state === "invalid" ? result.error : "The tightening could not be applied", result.state === "invalid" ? result.status : 409);
  }

  /** Claims a tightening card even after it was settled, so a duplicate
   * click never re-applies an already-applied reduction. */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveTighteningRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.tighteningRequest);
    const card = message?.card;
    const payload = card?.tighteningRequest;
    if (!message || !card || !payload) return { claimed: false, state: "not_found" };
    if (payload.requestId !== card.requestId) {
      return { claimed: true, state: "invalid", error: "This tightening request does not match its card", status: 409 };
    }

    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return { claimed: true, state: "invalid", error: "Tightening confirmations must be confirmed or cancelled", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return { claimed: true, state: "invalid", error: "This tightening request belongs to another conversation", status: 403 };
    }
    if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };

    let emergency = false;
    let outstandingSkills: string[] = [];
    try {
      const target = this.store.bot(payload.targetBotId);
      // The authority change and receipt share one durable write. If saving
      // the card failed afterward, a retry only settles it; it never
      // reapplies authority — but it does finish any skills a failed
      // attempt left enabled, so a partial disable can never strand the card.
      if (target?.lastTighteningRequestId === payload.requestId) {
        const enabled = new Set(this.enabledSkills?.(payload.targetBotId) ?? []);
        const remaining = (payload.intents.skills ?? []).filter((name) => enabled.has(name));
        if (remaining.length && !this.disableSkill) {
          throw new TighteningRequestError("Skill changes are not available in this workspace", 400);
        }
        const finished = this.applySkillDisables(payload.targetBotId, remaining);
        if (!finished.ok) {
          outstandingSkills = finished.outstanding;
          throw new TighteningRequestError(finished.error, 409);
        }
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, tighteningRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new TighteningRequestError("This tightening confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      if (!target) throw new TighteningRequestError(NO_SUCH_BOT, 404);
      const crossBot = payload.targetBotId !== payload.botId;
      if (crossBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.targetBotId);
        if (refusal) throw new TighteningRequestError(refusal, 404);
      }
      const current = this.snapshotOf(target);
      if (tighteningRevision(current, target.lastTighteningRequestId) !== payload.expectedRevision) {
        throw new TighteningRequestError(STALE, 409);
      }
      // Direction is re-validated against live state, not trusted from the
      // card: a card that sat open can only ever apply a reduction.
      const checked = validateTightening(current, payload.intents);
      if (!checked.ok) throw new TighteningRequestError(checked.error, 409);
      emergency = payload.intents.approvalMode !== undefined &&
        (current.approvalMode === "full" || current.approvalMode === "custom") &&
        payload.intents.approvalMode === "ask";
      if (this.targetBusy?.(target.id) && !emergency) {
        if (payload.intents.approvalMode !== undefined) {
          throw new TighteningRequestError("Stop this bot's turn before changing its approval level", 409);
        }
        if (payload.intents.mcpServers !== undefined) {
          throw new TighteningRequestError("Stop this bot's turns before changing its MCP servers", 409);
        }
      }

      // The capability check runs before any mutation: a workspace that
      // cannot touch skills must not half-apply the card.
      if (payload.intents.skills?.length && !this.disableSkill) {
        throw new TighteningRequestError("Skill changes are not available in this workspace", 400);
      }

      const patch: Parameters<TighteningRequestStore["patchBot"]>[1] = { lastTighteningRequestId: payload.requestId };
      if (payload.intents.approvalMode !== undefined) {
        patch.approvalMode = payload.intents.approvalMode;
        patch.autoApprove = payload.intents.approvalMode === "auto";
        patch.approvalGrant = undefined;
      }
      if (payload.intents.composio !== undefined) patch.composio = false;
      if (payload.intents.browser !== undefined) patch.browser = false;
      if (payload.intents.approvePeerComms !== undefined) patch.approvePeerComms = true;
      if (payload.intents.alwaysAllow !== undefined) patch.alwaysAllow = [...checked.after.alwaysAllow];
      if (payload.intents.mcpServers !== undefined) patch.mcpServers = [...checked.after.mcpServers];
      if (!this.store.patchBot(target.id, patch)) throw new TighteningRequestError(NO_SUCH_BOT, 404);

      // Skills disable AFTER the receipt write. Each disable persists on
      // its own, so a failure midway can leave part of the list done — but
      // the receipt is already durable, which turns every retry into the
      // branch above: finish the remainder, never reapply authority, and
      // never leave the card permanently stale.
      const skills = this.applySkillDisables(target.id, payload.intents.skills ?? []);
      if (!skills.ok) {
        outstandingSkills = skills.outstanding;
        throw new TighteningRequestError(skills.error, 409);
      }

      const appliedAt = this.now();
      const settled = this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined, tighteningRequest: { ...payload, appliedAt } },
      });
      if (!settled) throw new TighteningRequestError("This tightening confirmation card is no longer available", 409);
      const fields = INTENT_KEYS.filter((key) => payload.intents[key] !== undefined);
      return { claimed: true, state: "applied", targetBotId: target.id, fields, ...(emergency ? { emergencyStop: true } : {}) };
    } catch (error) {
      const status = error instanceof TighteningRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const saved = this.store.bot(payload.targetBotId)?.lastTighteningRequestId === payload.requestId;
      const notice = outstandingSkills.length
        ? `Permissions tightened. Confirm again to finish disabling: ${redactSecretsInText(outstandingSkills.join(", "))}`
        : card.dismissed && card.options.length === 0
          ? "Permissions tightened. Recording the operation receipt could not finish; the changes will not be applied again."
          : "Permissions tightened. Confirm again to finish recording this decision; the changes will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, held: saved ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch { /* The durable receipt still permits a safe retry. */ }
      if (saved) return {
        claimed: true, state: "applied", targetBotId: payload.targetBotId,
        fields: INTENT_KEYS.filter((key) => payload.intents[key] !== undefined),
        ...(emergency ? { emergencyStop: true } : {}),
      };
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
