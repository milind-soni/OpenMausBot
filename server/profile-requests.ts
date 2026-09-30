// propose_profile: a bot proposes changes to its own name, title, description,
// SOUL.md, working folder, or alert/voice toggles; confirmed cards and Full Access submissions share
// the same validated commit path. Same
// shape as routine-requests.ts, much smaller: the profile commits in one
// store call, and staleness is a hash of the five fields instead of a
// scheduler revision. Everything here is re-validated at confirm time —
// a card can sit open for days.
import { soulDiffLines } from "../shared/line-diff.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { PROFILE_REQUEST_FIELDS, type ProfileRequestCardData, type ProfileRequestChanges } from "../shared/profile-request.ts";
import type { TighteningRequestCardData } from "../shared/tightening-request.ts";
import { MAUS_COLORS, type MausColor } from "../shared/wire.ts";
import { parseBotProfilePatch, type BotProfilePatchInput } from "./bot-profile.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { newId } from "./contracts.ts";
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
  color: "Color",
  avatarUrl: "Avatar",
};
const PRIVATE_WORKSPACE = "its private workspace";
const CHOOSE_ONE = "Choose at least one of name, title, description, soul, cwd, notifications, speakReplies, color, or avatarUrl";
const toggleText = (value: boolean | undefined): string => (value ? "on" : "off");
/** The fields that change what a bot is told: every card field except the
 * working folder and the two toggles. */
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
  profileRequest?: ProfileRequestCardData;
  tighteningRequest?: TighteningRequestCardData;
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
  patchBotProfile(id: string, patch: Partial<Pick<BotRecord, "name" | "title" | "description" | "cwd" | "soul" | "notifications" | "speakReplies" | "color" | "avatarUrl" | "avatarCrop" | "lastProfileRequestId">>): BotRecord | null;
}

export interface ProfileRequestServiceOptions {
  store: ProfileRequestStore;
  now?: () => number;
  /** Server-owned effective mode of the source conversation, never request input. */
  autoApply?: (botId: string, threadId: string) => boolean;
  canPersist?: (botId: string, threadId: string) => { ok: true } | { ok: false; status: number; error: string };
  /** Chief targeting another bot: returns a refusal sentence or null. Checked at propose AND confirm. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
  /** Checks that a proposed avatar still references an image the app has
   * stored; checked at propose AND confirm, because a card can sit open for
   * days and stored images can be removed. */
  attachmentExists?: (avatarUrl: string) => boolean;
}

export class ProfileRequestError extends Error {
  readonly status: number;
  /** True when no retry of this card can ever succeed — the proposal went
   * stale (revision mismatch, target or folder gone) and the card must
   * settle as expired instead of staying actionable. */
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

/** `parseBotProfilePatch` would silently accept a key like `voice` —
 * valid for the broader bot patch, not for a profile request (a voice pick
 * needs the harness catalog rendered on the card). Reject keys
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
  const { cwd: rawCwd, color: rawColor, avatarUrl: rawAvatarUrl, ...profileInput } = input as Record<string, unknown>;
  let cwdChange: string | undefined;
  if (rawCwd !== undefined) {
    const checked = validateBotCwd(rawCwd);
    if (!checked.ok) throw new ProfileRequestError(checked.error, 400);
    cwdChange = checked.cwd ?? "";
  }
  let colorChange: MausColor | undefined;
  if (rawColor !== undefined) {
    const matched = typeof rawColor === "string" ? (MAUS_COLORS as readonly string[]).find((candidate) => candidate === rawColor) : undefined;
    if (!matched) {
      throw new ProfileRequestError(`color must be one of: ${MAUS_COLORS.join(", ")}`);
    }
    colorChange = matched as MausColor;
  }
  // The custom avatar travels by reference to an app-owned attachment — the
  // same stored image the settings panel's upload and generate paths produce
  // — so no image bytes ever move through a prompt. "" clears it.
  let avatarChange: string | undefined;
  if (rawAvatarUrl !== undefined) {
    if (rawAvatarUrl === null || rawAvatarUrl === "") {
      avatarChange = "";
    } else {
      const parsedUrl = botAvatarUrlSchema.safeParse(rawAvatarUrl);
      if (!parsedUrl.success) throw new ProfileRequestError("avatarUrl must be a stored PNG, JPEG, GIF, or WebP attachment");
      avatarChange = parsedUrl.data;
    }
  }
  const parsed = Object.keys(profileInput).length
    ? parseBotProfilePatch(profileInput as BotProfilePatchInput, true)
    : { ok: true as const, patch: {} as Partial<Record<string, unknown>> };
  if (!parsed.ok) throw new ProfileRequestError(parsed.error, 400);
  const changes: ProfileRequestChanges = {};
  if (cwdChange !== undefined) changes.cwd = cwdChange;
  if (colorChange !== undefined) changes.color = colorChange;
  if (avatarChange !== undefined) changes.avatarUrl = avatarChange;
  for (const field of PROFILE_REQUEST_FIELDS) {
    if (field === "cwd" || field === "color" || field === "avatarUrl") continue;
    const value = parsed.patch[field];
    if (field === "notifications" || field === "speakReplies") {
      if (value !== undefined) changes[field] = value as boolean;
      continue;
    }
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
    if (field === "notifications" || field === "speakReplies") {
      lines.push(`${LABELS[field]}: ${toggleText(before[field] as boolean | undefined)} → ${toggleText(changes[field] as boolean | undefined)}`);
      continue;
    }
    if (field === "color") {
      lines.push(`Color: ${before.color ?? ""} → ${changes.color}`);
      continue;
    }
    if (field === "avatarUrl") {
      lines.push(changes.avatarUrl
        ? before.avatarUrl
          ? "Avatar: replaced with the image shown on this card"
          : "Avatar: set to the image shown on this card"
        : "Avatar: removed (back to the mascot)");
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
  // The closing line says the consequence of exactly what is on the card:
  // a folder change moves where the bot's tools read and write; the text
  // fields change what it is told; a card of only toggles, only a folder,
  // or both carries no instruction change at all. Either way nothing runs
  // on confirm.
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
  private readonly attachmentExists?: ProfileRequestServiceOptions["attachmentExists"];
  /** Public: a caller's section membership can change between propose and
   * confirm, and tests flip this mid-scenario to model that. */
  validateTarget?: ProfileRequestServiceOptions["validateTarget"];

  constructor(options: ProfileRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.canPersist = options.canPersist;
    this.autoApply = options.autoApply;
    this.attachmentExists = options.attachmentExists;
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
  } {
    const reason = reasonText(args.reason);
    const changes = parseChanges(args.changes);
    if (changes.avatarUrl && this.attachmentExists && !this.attachmentExists(changes.avatarUrl)) {
      throw new ProfileRequestError("avatarUrl must reference an existing stored image", 400);
    }

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
      if (field === "notifications" || field === "speakReplies") {
        const value = changes[field];
        if (value === undefined || value === snapshot[field]) continue;
        before[field] = snapshot[field];
        finalChanges[field] = value;
        continue;
      }
      if (field === "color") {
        // Neither the color nor the avatar is secret-bearing, so neither is
        // redacted: a palette name and an app-owned attachment reference.
        const value = changes.color;
        if (value === undefined || value === snapshot.color) continue;
        before.color = snapshot.color;
        finalChanges.color = value;
      } else if (field === "avatarUrl") {
        const value = changes.avatarUrl;
        if (value === undefined || value === snapshot.avatarUrl) continue;
        before.avatarUrl = snapshot.avatarUrl;
        finalChanges.avatarUrl = value;
      } else {
        const value = changes[field];
        if (value === undefined || value === snapshot[field]) continue;
        before[field] = redactSecretsInText(snapshot[field]);
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
    const persistence = this.canPersist?.(args.botId, args.threadId);
    if (persistence && !persistence.ok) {
      throw new ProfileRequestError(persistence.error, persistence.status);
    }
    const automatic = submitted && this.autoApply?.(args.botId, args.threadId) === true;
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
    // The hidden receipt is persisted before the profile changes. The same
    // validation and durable commit marker serve both automatic and human decisions.
    const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
    if (result.state === "applied") return { ...proposal, result };
    throw new ProfileRequestError(result.state === "invalid" ? result.error : "The profile change could not be applied", result.state === "invalid" ? result.status : 409);
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
      // An expired card is settled terminal state, not a decision waiting on
      // a slower click: the proposal it carried can never be confirmed as
      // prepared, even when the condition that expired it reverses (the
      // revision matches again, the folder comes back). The committed
      // receipt above still recovers a write that already happened; nothing
      // past this point can.
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
        // Re-checked at confirm: a card can sit open for days and the folder
        // may be gone by then. 409 like the stale case — the card is no longer
        // applicable as prepared.
        const checked = validateBotCwd(cwd || null);
        if (!checked.ok) throw new ProfileRequestError(checked.error, 409, { terminal: true });
        patch.cwd = checked.cwd ?? undefined;
      }
      if (payload.changes.avatarUrl) {
        // Re-checked at confirm too: the stored image can be gone by the
        // time the card is answered, and a proposal that can no longer show
        // its own picture must not apply.
        if (this.attachmentExists && !this.attachmentExists(payload.changes.avatarUrl)) {
          throw new ProfileRequestError("The proposed avatar image is no longer stored. Ask for a fresh proposal.", 409, { terminal: true });
        }
        patch.avatarUrl = payload.changes.avatarUrl;
        // The panel's upload picks a real crop for a mascot bot; mirror it
        // so the confirmed avatar actually shows instead of staying hidden
        // behind the mascot.
        patch.avatarCrop = target.avatarCrop && target.avatarCrop !== "mascot" ? target.avatarCrop : "circle";
      } else if (payload.changes.avatarUrl === "") {
        patch.avatarUrl = undefined;
        patch.avatarCrop = "mascot";
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
      // A terminal failure (stale revision, target gone) can never be
      // confirmed as prepared: settle the card as expired with its options
      // removed so it stops looking actionable, and say so in one line.
      const expired = !saved && error instanceof ProfileRequestError && error.terminal;
      const notice = card.dismissed && card.options.length === 0
        ? "Profile saved. Recording the operation receipt could not finish; the changes will not be applied again."
        : "Profile saved. Confirm again to finish recording this decision; the changes will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, ...(expired ? { expired: true, options: [] } : {}), held: saved ? notice : redactSecretsInText(detail).slice(0, 500) },
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
