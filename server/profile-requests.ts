// propose_profile applies at once with an Undo. The owner's card (direct-apply.ts) is re-validated at confirm time, since it can sit open for days.
import { soulDiffLines } from "../shared/line-diff.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { PROFILE_REQUEST_FIELDS, type ProfileRequestCardData, type ProfileRequestChanges } from "../shared/profile-request.ts";
import { parseBotProfilePatch, type BotProfilePatchInput } from "./bot-profile.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { newId } from "./contracts.ts";
import { UNDO_STALE, type DirectApply, type DirectApplyCheck } from "./direct-apply.ts";
import { profileRevision, profileSnapshot } from "./profile-revision.ts";
import { recordProfileChange } from "./profile-versions.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord } from "./store.ts";

const MAX_REASON = 500;
const STALE = "This bot's profile changed after this card was prepared. Ask the bot to review it and propose again.";
const NO_SUCH_BOT = "That bot no longer exists";
const LABELS: Record<Exclude<(typeof PROFILE_REQUEST_FIELDS)[number], "soul" | "cwd">, string> = {
  name: "Name",
  title: "Title",
  description: "Description",
  notifications: "Notifications",
  speakReplies: "Speak replies",
};
const PRIVATE_WORKSPACE = "its private workspace";
const CHOOSE_ONE = "Choose at least one of name, title, description, soul, cwd, notifications, speakReplies";
const toggleText = (value: boolean | undefined): string => (value ? "on" : "off");
const TEXT_FIELDS = ["name", "title", "description", "soul"] as const;

export interface OptionCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  expired?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  autoApplied?: boolean;
  undone?: boolean;
  profileRequest?: ProfileRequestCardData;
}

export interface ProfileRequestStore {
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
  patchBotProfile(id: string, patch: Partial<Pick<BotRecord, "name" | "title" | "description" | "cwd" | "soul" | "notifications" | "speakReplies" | "lastProfileRequestId">>): BotRecord | null;
}

export interface ProfileRequestServiceOptions {
  store: ProfileRequestStore;
  now?: () => number;
  /** Server-owned, never request input. */
  autoApply?: DirectApplyCheck;
  canPersist?: (botId: string, threadId: string, opensCard: boolean) => { ok: true } | { ok: false; status: number; error: string };
  /** Chief targeting another bot: returns a refusal sentence or null. Checked at propose AND confirm. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
}

export class ProfileRequestError extends Error {
  readonly status: number;
  readonly terminal: boolean;

  constructor(message: string, status = 400, options?: { terminal?: boolean }) {
    super(message);
    this.name = "ProfileRequestError";
    this.status = status;
    this.terminal = options?.terminal === true;
  }
}

export type ResolveProfileRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; targetBotId: string; fields: string[]; settlementPending?: true; message?: string };

export type UndoProfileRequestResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true }
  | { claimed: true; state: "undone"; targetBotId: string };

interface ProfileCardCopy {
  title: string;
  summary: string;
  detail: string;
}

function reasonText(value: unknown): string {
  if (typeof value !== "string") throw new ProfileRequestError("reason is required");
  const trimmed = value.trim();
  if (!trimmed) throw new ProfileRequestError("reason is required");
  if (trimmed.length > MAX_REASON) {
    throw new ProfileRequestError(`reason must be ${MAX_REASON} characters or fewer`);
  }
  return redactSecretsInText(trimmed);
}

/** parseBotProfilePatch accepts keys (like `voice`) a profile request must not carry: reject them first. */
function parseChanges(input: unknown): ProfileRequestChanges {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProfileRequestError(CHOOSE_ONE);
  }
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!(PROFILE_REQUEST_FIELDS as readonly string[]).includes(key)) {
      throw new ProfileRequestError(`unsupported profile field: ${key}`);
    }
  }
  if (keys.length === 0) {
    throw new ProfileRequestError(CHOOSE_ONE);
  }
  const { cwd: rawCwd, ...profileInput } = input as Record<string, unknown>;
  let cwdChange: string | undefined;
  if (rawCwd !== undefined) {
    const checked = validateBotCwd(rawCwd);
    if (!checked.ok) throw new ProfileRequestError(checked.error, 400);
    cwdChange = checked.cwd ?? "";
  }
  const parsed = Object.keys(profileInput).length
    ? parseBotProfilePatch(profileInput as BotProfilePatchInput, true)
    : { ok: true as const, patch: {} as Partial<Record<string, unknown>> };
  if (!parsed.ok) throw new ProfileRequestError(parsed.error, 400);
  const changes: ProfileRequestChanges = {};
  if (cwdChange !== undefined) changes.cwd = cwdChange;
  for (const field of PROFILE_REQUEST_FIELDS) {
    if (field === "cwd") continue;
    const value = parsed.patch[field];
    if (field === "notifications" || field === "speakReplies") {
      if (value !== undefined) changes[field] = value as boolean;
      continue;
    }
    // Hidden under the card's visible fields, where the store's shallow card redaction cannot reach.
    if (typeof value !== "string") continue;
    const redacted = redactSecretsInText(value);
    // A redaction mask can be longer than the secret, so the cap is checked again after scrubbing.
    if (field === "soul") {
      if (Buffer.byteLength(redacted, "utf8") > BOT_PROFILE_LIMITS.soul) {
        throw new ProfileRequestError("standing instructions must be at most 24000 bytes");
      }
    } else {
      const limit = BOT_PROFILE_LIMITS[field];
      if (redacted.length > limit) {
        throw new ProfileRequestError(`${field} must be at most ${limit} characters`);
      }
    }
    changes[field] = redacted;
  }
  return changes;
}

export function profileCardCopy(
  target: { name: string; crossBot: boolean },
  fullProfile: { title: string; description: string; soul: string },
  before: ProfileRequestChanges,
  changes: ProfileRequestChanges,
  reason: string,
): ProfileCardCopy {
  const isSetup = !fullProfile.title && !fullProfile.description && !fullProfile.soul;
  const title = target.crossBot
    ? `Update @${target.name}'s profile?`
    : isSetup
      ? `Set up ${target.name}?`
      : `Update ${target.name}'s profile?`;

  const lines: string[] = target.crossBot ? [`Whose profile: @${target.name}`, `Why: ${reason}`] : [`Why: ${reason}`];
  for (const field of PROFILE_REQUEST_FIELDS) {
    if (field === "soul" || field === "cwd") continue;
    if (changes[field] === undefined) continue;
    if (field === "notifications" || field === "speakReplies") {
      lines.push(`${LABELS[field]}: ${toggleText(before[field] as boolean | undefined)} → ${toggleText(changes[field] as boolean | undefined)}`);
      continue;
    }
    lines.push(`${LABELS[field]}: "${before[field] ?? ""}" → "${changes[field]}"`);
  }
  if (changes.cwd !== undefined) {
    lines.push(`Working folder: ${before.cwd || PRIVATE_WORKSPACE} → ${changes.cwd || PRIVATE_WORKSPACE}`);
  }
  if (changes.soul !== undefined) {
    lines.push(...soulDiffLines(before.soul ?? "", changes.soul));
  }
  const changesText = TEXT_FIELDS.some((field) => changes[field] !== undefined);
  if (changes.cwd !== undefined) lines.push(`${target.name}'s tools will read and write files in that folder.`);
  lines.push(changesText ? `Changes what ${target.name} is told on every turn. Nothing runs.` : "Nothing runs.");
  const detail = lines.join("\n");

  const fields = PROFILE_REQUEST_FIELDS.filter((field) => changes[field] !== undefined);
  const summary = `${title} · ${fields.join(", ")}`;
  return { title, summary, detail };
}

export class ProfileRequestService {
  private readonly store: ProfileRequestStore;
  private readonly now: () => number;
  private readonly canPersist?: ProfileRequestServiceOptions["canPersist"];
  private readonly autoApply?: ProfileRequestServiceOptions["autoApply"];
  validateTarget?: ProfileRequestServiceOptions["validateTarget"];

  constructor(options: ProfileRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.canPersist = options.canPersist;
    this.autoApply = options.autoApply;
    this.validateTarget = options.validateTarget;
  }

  propose(args: {
    botId: string;
    threadId: string;
    targetBotId?: string;
    changes: unknown;
    reason: unknown;
    from?: { botId: string; name: string; color: string };
  }): { requestId: string; messageId: string; title: string; summary: string; detail: string } {
    return this.prepare(args);
  }

  submit(args: Parameters<ProfileRequestService["propose"]>[0]) {
    const proposal = this.prepare(args, true);
    return { ...proposal, state: proposal.result ? "applied" as const : "pending" as const };
  }

  private prepare(args: Parameters<ProfileRequestService["propose"]>[0], submitted = false): {
    requestId: string; messageId: string; title: string; summary: string; detail: string;
    result?: Extract<ResolveProfileRequestResult, { state: "applied" }>;
    appliedBy?: DirectApply;
  } {
    const reason = reasonText(args.reason);
    const changes = parseChanges(args.changes);

    const targetBotId = args.targetBotId ?? args.botId;
    const target = this.store.bot(targetBotId);
    if (!target) throw new ProfileRequestError(NO_SUCH_BOT, 404);
    const crossBot = targetBotId !== args.botId;
    if (crossBot && this.validateTarget) {
      const refusal = this.validateTarget(args.botId, targetBotId);
      if (refusal) throw new ProfileRequestError(refusal, 403);
    }

    const snapshot = profileSnapshot(target);
    const before: ProfileRequestChanges = {};
    const finalChanges: ProfileRequestChanges = {};
    let exactBefore = true;
    for (const field of PROFILE_REQUEST_FIELDS) {
      if (field === "notifications" || field === "speakReplies") {
        const value = changes[field];
        if (value === undefined || value === snapshot[field]) continue;
        before[field] = snapshot[field];
        finalChanges[field] = value;
      } else {
        const value = changes[field];
        if (value === undefined || value === snapshot[field]) continue;
        before[field] = redactSecretsInText(snapshot[field]);
        if (before[field] !== snapshot[field]) exactBefore = false;
        finalChanges[field] = value;
      }
    }
    if (Object.keys(finalChanges).length === 0) {
      throw new ProfileRequestError("Nothing would change");
    }

    const requestId = newId();
    const targetName = redactSecretsInText(target.name);
    const payload: ProfileRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      targetBotId,
      targetName,
      createdAt: this.now(),
      reason,
      changes: finalChanges,
      before,
      expectedRevision: profileRevision(target),
    };

    const copy = profileCardCopy({ name: targetName, crossBot }, snapshot, before, finalChanges, reason);
    const grant = submitted ? this.autoApply?.(args.botId, args.threadId, targetBotId) ?? null : null;
    const automatic = grant !== null;
    const persistence = this.canPersist?.(args.botId, args.threadId, !automatic);
    if (persistence && !persistence.ok) {
      throw new ProfileRequestError(persistence.error, persistence.status);
    }
    const messageInput: Parameters<ProfileRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: automatic ? [] : ["Confirm", "Cancel"],
        ...(automatic ? { dismissed: true } : {}),
        requestId,
        tool: "update_profile",
        profileRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const message = this.store.appendMessage(args.threadId, messageInput);
    const proposal = { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
    if (!automatic) return proposal;
    // The hidden receipt is persisted before the profile changes.
    const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
    if (result.state === "applied") {
      if (!result.settlementPending) this.recordAutoApplied(args.threadId, message.id, targetBotId, exactBefore);
      return { ...proposal, result, appliedBy: grant! };
    }
    throw new ProfileRequestError(result.state === "invalid" ? result.error : "The profile change could not be applied", result.state === "invalid" ? result.status : 409);
  }

  private recordAutoApplied(threadId: string, messageId: string, targetBotId: string, exactBefore: boolean): void {
    try {
      const card = this.store.messagesFor(threadId).find((candidate) => candidate.id === messageId)?.card;
      const target = this.store.bot(targetBotId);
      if (!card?.profileRequest || !target) return;
      this.store.patchMessage(threadId, messageId, {
        card: {
          ...card,
          autoApplied: true,
          profileRequest: { ...card.profileRequest, ...(exactBefore ? { undo: { appliedRevision: profileRevision(target) } } : {}) },
        },
      });
    } catch {
    }
  }

  undo(args: { botId: string; threadId: string; requestId: string }): UndoProfileRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.profileRequest);
    const card = message?.card;
    const payload = card?.profileRequest;
    if (!message || !card || !payload) return { claimed: false };
    if (card.undone) return { claimed: true, state: "already_undone" };
    const cannot = (error: string, status = 409): UndoProfileRequestResult => ({ claimed: true, state: "invalid", error, status });
    if (!card.autoApplied || card.answered !== "allow") return cannot("Only a change that applied on its own can be undone here.");
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return cannot("This profile change belongs to another conversation", 403);
    }
    if (!payload.undo) return cannot("This change can't be undone here.");
    const target = this.store.bot(payload.targetBotId);
    if (!target || profileRevision(target) !== payload.undo.appliedRevision) {
      return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    }
    const { cwd, ...rest } = payload.before;
    const patch: Parameters<ProfileRequestStore["patchBotProfile"]>[1] = {};
    for (const field of PROFILE_REQUEST_FIELDS) {
      if (field === "cwd" || payload.changes[field] === undefined) continue;
      (patch as Record<string, unknown>)[field] = rest[field];
    }
    if (payload.changes.cwd !== undefined) {
      const checked = validateBotCwd(cwd || null);
      if (!checked.ok) return cannot(checked.error);
      patch.cwd = checked.cwd ?? undefined;
    }
    if (!this.store.patchBotProfile(target.id, patch)) return cannot(NO_SUCH_BOT, 404);
    recordProfileChange(target.id, "user", `undo:${message.id}`, payload.changes, payload.before);
    this.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
    return { claimed: true, state: "undone", targetBotId: target.id };
  }

  /** Claims a card even after it settled, so a duplicate click never re-applies a change. */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveProfileRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.profileRequest);
    const card = message?.card;
    const payload = card?.profileRequest;
    if (!message || !card || !payload) return { claimed: false, state: "not_found" };
    if (payload.requestId !== card.requestId) {
      return { claimed: true, state: "invalid", error: "This profile request does not match its card", status: 409 };
    }

    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return { claimed: true, state: "invalid", error: "Profile confirmations must be confirmed or cancelled", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return { claimed: true, state: "invalid", error: "This profile request belongs to another conversation", status: 403 };
    }
    if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };

    try {
      const target = this.store.bot(payload.targetBotId);
      // Profile and receipt share one write: a retry after a failed card save only settles it.
      if (target?.lastProfileRequestId === payload.requestId) {
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, profileRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new ProfileRequestError("This profile confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      if (card.expired) {
        return { claimed: true, state: "invalid", error: "This profile request expired before it was confirmed. Ask for a fresh proposal.", status: 409 };
      }
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      if (!target) throw new ProfileRequestError(NO_SUCH_BOT, 404, { terminal: true });
      const crossBot = payload.targetBotId !== payload.botId;
      if (crossBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.targetBotId);
        if (refusal) throw new ProfileRequestError(refusal, 404, { terminal: true });
      }
      if (profileRevision(target) !== payload.expectedRevision) {
        throw new ProfileRequestError(STALE, 409, { terminal: true });
      }

      const { cwd, ...rest } = payload.changes;
      const validated = Object.keys(rest).length ? parseChanges(rest) : {};
      const patch: Parameters<ProfileRequestStore["patchBotProfile"]>[1] = { ...validated, lastProfileRequestId: payload.requestId };
      if (cwd !== undefined) {
        const checked = validateBotCwd(cwd || null);
        if (!checked.ok) throw new ProfileRequestError(checked.error, 409, { terminal: true });
        patch.cwd = checked.cwd ?? undefined;
      }
      if (!this.store.patchBotProfile(target.id, patch)) throw new ProfileRequestError(NO_SUCH_BOT, 404);
      recordProfileChange(target.id, "bot", `card:${message.id}`, payload.before, payload.changes);

      const appliedAt = this.now();
      const settled = this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined, profileRequest: { ...payload, appliedAt } },
      });
      if (!settled) throw new ProfileRequestError("This profile confirmation card is no longer available", 409);
      const fields = PROFILE_REQUEST_FIELDS.filter((field) => payload.changes[field] !== undefined);
      return { claimed: true, state: "applied", targetBotId: target.id, fields };
    } catch (error) {
      const status = error instanceof ProfileRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const saved = this.store.bot(payload.targetBotId)?.lastProfileRequestId === payload.requestId;
      const expired = !saved && error instanceof ProfileRequestError && error.terminal;
      const notice = card.dismissed && card.options.length === 0
        ? "Profile saved. Recording the operation receipt could not finish; the changes will not be applied again."
        : "Profile saved. Confirm again to finish recording this decision; the changes will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, ...(expired ? { expired: true, options: [] } : {}), held: saved ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch {}
      if (saved) return {
        claimed: true, state: "applied", targetBotId: payload.targetBotId,
        fields: PROFILE_REQUEST_FIELDS.filter((field) => payload.changes[field] !== undefined),
        settlementPending: true, message: notice,
      };
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
