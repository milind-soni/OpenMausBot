// propose_profile: a bot proposes changes to its own name, title, description,
// SOUL.md, or working folder; the change lands only when the user confirms the card. Same
// shape as routine-requests.ts, much smaller: the profile commits in one
// store call, and staleness is a hash of the five fields instead of a
// scheduler revision. Everything here is re-validated at confirm time —
// a card can sit open for days.
import { lineDiff } from "../shared/line-diff.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { PROFILE_REQUEST_FIELDS, type ProfileRequestCardData, type ProfileRequestChanges } from "../shared/profile-request.ts";
import { parseBotProfilePatch, type BotProfilePatchInput } from "./bot-profile.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { newId } from "./contracts.ts";
import { profileRevision, profileSnapshot } from "./profile-revision.ts";
import { recordProfileChange } from "./profile-versions.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord } from "./store.ts";

const MAX_REASON = 500;
const MAX_DIFF_LINES = 400;
const STALE = "This bot's profile changed after this card was prepared. Ask the bot to review it and propose again.";
const NO_SUCH_BOT = "That bot no longer exists";
const LABELS: Record<Exclude<(typeof PROFILE_REQUEST_FIELDS)[number], "soul" | "cwd">, string> = {
  name: "Name",
  title: "Title",
  description: "Description",
};
const PRIVATE_WORKSPACE = "its private workspace";
const CHOOSE_ONE = "Choose at least one of name, title, description, soul, cwd";

export interface OptionCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  profileRequest?: ProfileRequestCardData;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
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
  patchBotProfile(id: string, patch: Partial<Pick<BotRecord, "name" | "title" | "description" | "cwd" | "soul" | "lastProfileRequestId">>): BotRecord | null;
}

export interface ProfileRequestServiceOptions {
  store: ProfileRequestStore;
  now?: () => number;
  canPersist?: (botId: string, threadId: string) => { ok: true } | { ok: false; status: number; error: string };
  /** Chief targeting another bot: returns a refusal sentence or null. Checked at propose AND confirm. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
}

export class ProfileRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProfileRequestError";
    this.status = status;
  }
}

export type ResolveProfileRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; targetBotId: string; fields: string[]; settlementPending?: true; message?: string };

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

/** `parseBotProfilePatch` would silently accept a key like `notifications` —
 * valid for the broader bot patch, not for a profile request. Reject keys
 * outside the proposable fields ourselves first, for exact copy. */
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
  // The working folder is not a profile-patch field (PATCH /api/bots checks
  // it with validateBotCwd, not parseBotProfilePatch), so it is split off and
  // checked the same way that route does: absolute, exists, is a folder.
  // "" (or null) means the private workspace.
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
    // This payload is hidden under the card's visible fields, so the store's
    // shallow card redaction cannot reach it. Scrub before it is persisted.
    if (typeof value !== "string") continue;
    const redacted = redactSecretsInText(value);
    // A mask can be LONGER than the secret it replaces (e.g. an 8-char
    // value becomes "«redacted 8 chars»"), so a value that passed the raw
    // cap can come out the other side over it. Re-check with the exact
    // copy the parser itself would have used.
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
  // Whether this is a first-time setup is a property of the bot's WHOLE
  // profile, not of the fields this particular proposal happens to touch —
  // otherwise a name-only rename of an established bot reads as "Set up X?"
  // just because title/description/soul never appear in `before`.
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
    lines.push(`${LABELS[field]}: "${before[field] ?? ""}" → "${changes[field]}"`);
  }
  if (changes.cwd !== undefined) {
    lines.push(`Working folder: ${before.cwd || PRIVATE_WORKSPACE} → ${changes.cwd || PRIVATE_WORKSPACE}`);
  }
  if (changes.soul !== undefined) {
    const beforeSoul = before.soul ?? "";
    const afterSoul = changes.soul;
    const bytesBefore = Buffer.byteLength(beforeSoul, "utf8");
    const bytesAfter = Buffer.byteLength(afterSoul, "utf8");
    lines.push(`SOUL.md (${bytesBefore} → ${bytesAfter} bytes):`);
    const diff = lineDiff(beforeSoul, afterSoul);
    if (diff.length > MAX_DIFF_LINES) {
      // Truncating a diff can hide the very instructions being approved.
      // The full replacement is already byte-bounded by profile validation
      // and is readable in the same generic card on desktop and phones.
      lines.push("Large change — complete proposed instructions (replaces the current SOUL.md):");
      lines.push(afterSoul || "(empty)");
    } else {
      lines.push(...diff);
    }
  }
  // The closing line says the consequence of exactly what is on the card:
  // a folder change moves where the bot's tools read and write; the other
  // fields change what it is told. Either way nothing runs on confirm.
  const onlyFolder = Object.keys(changes).every((field) => field === "cwd");
  if (changes.cwd !== undefined) lines.push(`${target.name}'s tools will read and write files in that folder.`);
  lines.push(onlyFolder ? "Nothing runs." : `Changes what ${target.name} is told on every turn. Nothing runs.`);
  const detail = lines.join("\n");

  const fields = PROFILE_REQUEST_FIELDS.filter((field) => changes[field] !== undefined);
  const summary = `${title} · ${fields.join(", ")}`;
  return { title, summary, detail };
}

export class ProfileRequestService {
  private readonly store: ProfileRequestStore;
  private readonly now: () => number;
  private readonly canPersist?: ProfileRequestServiceOptions["canPersist"];
  /** Public: a caller's section membership can change between propose and
   * confirm, and tests flip this mid-scenario to model that. */
  validateTarget?: ProfileRequestServiceOptions["validateTarget"];

  constructor(options: ProfileRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.canPersist = options.canPersist;
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
    for (const field of PROFILE_REQUEST_FIELDS) {
      const value = changes[field];
      if (value === undefined) continue;
      if (value === snapshot[field]) continue;
      before[field] = redactSecretsInText(snapshot[field]);
      finalChanges[field] = value;
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
    const persistence = this.canPersist?.(args.botId, args.threadId);
    if (persistence && !persistence.ok) {
      throw new ProfileRequestError(persistence.error, persistence.status);
    }
    const messageInput: Parameters<ProfileRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: ["Confirm", "Cancel"],
        requestId,
        tool: "update_profile",
        profileRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const message = this.store.appendMessage(args.threadId, messageInput);
    return { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
  }

  /** Claims a profile card even after it was settled, so a duplicate click
   * never re-applies an already-applied change. */
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
      // The profile and receipt share one durable write. If saving the card
      // failed afterward, a retry only settles it; it never reapplies fields.
      if (target?.lastProfileRequestId === payload.requestId) {
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, profileRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new ProfileRequestError("This profile confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      if (!target) throw new ProfileRequestError(NO_SUCH_BOT, 404);
      const crossBot = payload.targetBotId !== payload.botId;
      if (crossBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.targetBotId);
        if (refusal) throw new ProfileRequestError(refusal, 404);
      }
      if (profileRevision(target) !== payload.expectedRevision) {
        throw new ProfileRequestError(STALE, 409);
      }

      const { cwd, ...rest } = payload.changes;
      const validated = Object.keys(rest).length ? parseChanges(rest) : {};
      const patch: Parameters<ProfileRequestStore["patchBotProfile"]>[1] = { ...validated, lastProfileRequestId: payload.requestId };
      if (cwd !== undefined) {
        // Re-checked at confirm: a card can sit open for days and the folder
        // may be gone by then. 409 like the stale case — the card is no longer
        // applicable as prepared.
        const checked = validateBotCwd(cwd || null);
        if (!checked.ok) throw new ProfileRequestError(checked.error, 409);
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
      const notice = "Profile saved. Confirm again to finish recording this decision; the changes will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, held: saved ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch { /* The durable profile receipt still permits a safe retry. */ }
      if (saved) return {
        claimed: true, state: "applied", targetBotId: payload.targetBotId,
        fields: PROFILE_REQUEST_FIELDS.filter((field) => payload.changes[field] !== undefined),
        settlementPending: true, message: notice,
      };
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
