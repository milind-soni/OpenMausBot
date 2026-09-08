// propose_playbook: a bot proposes adding, replacing, or removing one of its
// own playbooks — or one belonging to a section peer, when it is that
// section's Chief. The change lands only when the user confirms the card.
// Same shape as profile-requests.ts, which says the same of routine-requests:
// one durable card, everything re-validated at confirm time, because a card
// can sit open for days.
//
// Playbooks used to arrive only with a package import, which froze a bot's
// process guidance at install time while SOUL.md — always mounted, and the
// stronger instruction — stayed proposable. This closes that gap without
// widening what a proposal may contain: the limits below are the package
// schema's own, so a card can never produce a playbook an import could not.
import { lineDiff } from "../shared/line-diff.ts";
import {
  PLAYBOOK_KEY_PATTERN,
  PLAYBOOK_LIMITS,
  type PlaybookRequestCardData,
  type PlaybookRequestChange,
  type PlaybookRequestPlaybook,
} from "../shared/playbook-request.ts";
import { newId } from "./contracts.ts";
import { playbookRevision, playbookSnapshot } from "./playbook-revision.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord, InstalledPlaybook } from "./store.ts";

const MAX_REASON = 500;
const MAX_DIFF_LINES = 400;
const STALE = "This bot's playbooks changed after this card was prepared. Ask the bot to review them and propose again.";
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
  playbookRequest?: PlaybookRequestCardData;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
export interface PlaybookRequestStore {
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
  patchBotPlaybooks(
    id: string,
    patch: { playbooks: InstalledPlaybook[]; lastPlaybookRequestId: string },
  ): BotRecord | null;
}

export interface PlaybookRequestServiceOptions {
  store: PlaybookRequestStore;
  now?: () => number;
  canPersist?: (botId: string, threadId: string) => { ok: true } | { ok: false; status: number; error: string };
  /** Chief targeting another bot: returns a refusal sentence or null. Checked at propose AND confirm. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
}

export class PlaybookRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PlaybookRequestError";
    this.status = status;
  }
}

export type ResolvePlaybookRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; targetBotId: string; key: string; action: PlaybookRequestChange["action"]; settlementPending?: true; message?: string };

function reasonText(value: unknown): string {
  if (typeof value !== "string") throw new PlaybookRequestError("reason is required");
  const trimmed = value.trim();
  if (!trimmed) throw new PlaybookRequestError("reason is required");
  if (trimmed.length > MAX_REASON) {
    throw new PlaybookRequestError(`reason must be ${MAX_REASON} characters or fewer`);
  }
  return redactSecretsInText(trimmed);
}

function playbookKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PlaybookRequestError("key is required");
  const key = value.trim();
  if (key.length > PLAYBOOK_LIMITS.key) {
    throw new PlaybookRequestError(`key must be at most ${PLAYBOOK_LIMITS.key} characters`);
  }
  if (!PLAYBOOK_KEY_PATTERN.test(key)) {
    throw new PlaybookRequestError("key may only contain lowercase letters, numbers, - and _");
  }
  return key;
}

/** Every field is redacted before the length check, for the same reason
 * profile requests do it: a mask can be longer than the secret it replaces,
 * and this payload sits under the card where the store's shallow redaction
 * cannot reach it. */
function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string") throw new PlaybookRequestError(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new PlaybookRequestError(`${field} is required`);
  const redacted = redactSecretsInText(trimmed);
  if (redacted.length > limit) {
    throw new PlaybookRequestError(`${field} must be at most ${limit} characters`);
  }
  return redacted;
}

function parsePlaybook(input: unknown): PlaybookRequestPlaybook {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PlaybookRequestError("playbook must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (!Array.isArray(candidate.triggers) || candidate.triggers.length === 0) {
    throw new PlaybookRequestError("at least one trigger is required");
  }
  if (candidate.triggers.length > PLAYBOOK_LIMITS.triggers) {
    throw new PlaybookRequestError(`a playbook may have at most ${PLAYBOOK_LIMITS.triggers} triggers`);
  }
  return {
    key: playbookKey(candidate.key),
    name: text(candidate.name, "name", PLAYBOOK_LIMITS.name),
    summary: text(candidate.summary, "summary", PLAYBOOK_LIMITS.summary),
    triggers: candidate.triggers.map((trigger) => text(trigger, "trigger", PLAYBOOK_LIMITS.trigger)),
    instructions: text(candidate.instructions, "instructions", PLAYBOOK_LIMITS.instructions),
  };
}

function parseChange(input: unknown): PlaybookRequestChange {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PlaybookRequestError("change must be upsert or remove");
  }
  const { action } = input as { action?: unknown };
  if (action === "upsert") {
    return { action, playbook: parsePlaybook((input as { playbook?: unknown }).playbook) };
  }
  if (action === "remove") {
    return { action, key: playbookKey((input as { key?: unknown }).key) };
  }
  throw new PlaybookRequestError("change must be upsert or remove");
}

const samePlaybook = (left: PlaybookRequestPlaybook, right: InstalledPlaybook): boolean =>
  left.name === right.name &&
  left.summary === right.summary &&
  left.instructions === right.instructions &&
  left.triggers.length === right.triggers.length &&
  left.triggers.every((trigger, index) => trigger === right.triggers[index]);

export function playbookCardCopy(
  target: { name: string; crossBot: boolean },
  change: PlaybookRequestChange,
  before: PlaybookRequestPlaybook | undefined,
  reason: string,
): { title: string; summary: string; detail: string } {
  const label = change.action === "upsert" ? change.playbook.name : before?.name ?? change.key;
  const verb = change.action === "remove" ? "Remove" : before ? "Update" : "Add";
  const title = `${verb} ${target.crossBot ? `@${target.name}` : target.name}'s “${label}” playbook?`;

  const lines: string[] = target.crossBot ? [`Whose playbook: @${target.name}`, `Why: ${reason}`] : [`Why: ${reason}`];
  if (change.action === "remove") {
    lines.push(`Removes the “${label}” playbook (${before?.instructions.length ?? 0} characters of guidance).`);
  } else {
    const playbook = change.playbook;
    lines.push(`Summary: ${playbook.summary}`);
    lines.push(`Triggers: ${playbook.triggers.join(", ")}`);
    lines.push(
      `Instructions (${before?.instructions.length ?? 0} → ${playbook.instructions.length} characters):`,
    );
    const diff = lineDiff(before?.instructions ?? "", playbook.instructions);
    if (diff.length > MAX_DIFF_LINES) {
      // Truncating a diff can hide the very instructions being approved. The
      // full text is already length-bounded by the package limits above.
      lines.push("Large change — complete proposed instructions (replaces the current playbook):");
      lines.push(playbook.instructions);
    } else {
      lines.push(...diff);
    }
  }
  // Playbooks are mounted only when one of their triggers matches the job, so
  // the consequence line says that rather than promising every turn.
  lines.push(
    change.action === "remove"
      ? `${target.name} will no longer be given this guidance. Nothing runs.`
      : `Changes what ${target.name} is told when a job matches one of those triggers. Nothing runs.`,
  );

  const detail = lines.join("\n");
  return { title, summary: `${title} · ${change.action}`, detail };
}

export class PlaybookRequestService {
  private readonly store: PlaybookRequestStore;
  private readonly now: () => number;
  private readonly canPersist?: PlaybookRequestServiceOptions["canPersist"];
  /** Public: a caller's section membership can change between propose and
   * confirm, and tests flip this mid-scenario to model that. */
  validateTarget?: PlaybookRequestServiceOptions["validateTarget"];

  constructor(options: PlaybookRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.canPersist = options.canPersist;
    this.validateTarget = options.validateTarget;
  }

  propose(args: {
    botId: string;
    threadId: string;
    targetBotId?: string;
    change: unknown;
    reason: unknown;
    from?: { botId: string; name: string; color: string };
  }): { requestId: string; messageId: string; title: string; summary: string; detail: string } {
    const reason = reasonText(args.reason);
    const change = parseChange(args.change);

    const targetBotId = args.targetBotId ?? args.botId;
    const target = this.store.bot(targetBotId);
    if (!target) throw new PlaybookRequestError(NO_SUCH_BOT, 404);
    const crossBot = targetBotId !== args.botId;
    if (crossBot && this.validateTarget) {
      const refusal = this.validateTarget(args.botId, targetBotId);
      if (refusal) throw new PlaybookRequestError(refusal, 403);
    }

    const existing = playbookSnapshot(target);
    const key = change.action === "upsert" ? change.playbook.key : change.key;
    const before = existing.find((playbook) => playbook.key === key);
    if (change.action === "remove" && !before) {
      throw new PlaybookRequestError(`${target.name} has no playbook with the key "${key}"`, 404);
    }
    if (change.action === "upsert") {
      if (before && samePlaybook(change.playbook, before)) {
        throw new PlaybookRequestError("Nothing would change");
      }
      if (!before && existing.length >= PLAYBOOK_LIMITS.perBot) {
        throw new PlaybookRequestError(`a bot may have at most ${PLAYBOOK_LIMITS.perBot} playbooks`);
      }
    }

    const requestId = newId();
    const targetName = redactSecretsInText(target.name);
    const payload: PlaybookRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      targetBotId,
      targetName,
      createdAt: this.now(),
      reason,
      change,
      ...(before ? { before: { ...before, triggers: [...before.triggers] } } : {}),
      expectedRevision: playbookRevision(target),
    };

    const copy = playbookCardCopy({ name: targetName, crossBot }, change, before, reason);
    const persistence = this.canPersist?.(args.botId, args.threadId);
    if (persistence && !persistence.ok) {
      throw new PlaybookRequestError(persistence.error, persistence.status);
    }
    const messageInput: Parameters<PlaybookRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: ["Confirm", "Cancel"],
        requestId,
        tool: "update_playbook",
        playbookRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const message = this.store.appendMessage(args.threadId, messageInput);
    return { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
  }

  /** Claims a playbook card even after it was settled, so a duplicate click
   * never re-applies an already-applied change. */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolvePlaybookRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.playbookRequest);
    const card = message?.card;
    const payload = card?.playbookRequest;
    if (!message || !card || !payload) return { claimed: false, state: "not_found" };
    if (payload.requestId !== card.requestId) {
      return { claimed: true, state: "invalid", error: "This playbook request does not match its card", status: 409 };
    }
    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return { claimed: true, state: "invalid", error: "Playbook confirmations must be confirmed or cancelled", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return { claimed: true, state: "invalid", error: "This playbook request belongs to another conversation", status: 403 };
    }
    if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };

    const key = payload.change.action === "upsert" ? payload.change.playbook.key : payload.change.key;
    try {
      const target = this.store.bot(payload.targetBotId);
      // The playbooks and the receipt share one durable write. If saving the
      // card failed afterward, a retry only settles it; it never reapplies.
      if (target?.lastPlaybookRequestId === payload.requestId) {
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, playbookRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new PlaybookRequestError("This playbook confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      if (!target) throw new PlaybookRequestError(NO_SUCH_BOT, 404);
      const crossBot = payload.targetBotId !== payload.botId;
      if (crossBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.targetBotId);
        if (refusal) throw new PlaybookRequestError(refusal, 404);
      }
      if (playbookRevision(target) !== payload.expectedRevision) {
        throw new PlaybookRequestError(STALE, 409);
      }

      // Re-parsed at confirm rather than trusted from the card, the same way
      // a profile card re-validates its fields before applying them.
      const change = parseChange(payload.change);
      const current = playbookSnapshot(target);
      let playbooks: InstalledPlaybook[];
      if (change.action === "remove") {
        playbooks = current.filter((playbook) => playbook.key !== change.key);
        if (playbooks.length === current.length) {
          throw new PlaybookRequestError(`${target.name} has no playbook with the key "${change.key}"`, 409);
        }
      } else {
        // Provenance is set here, not taken from the payload: whatever the
        // card carried, an approved proposal is bot-authored by definition.
        const next: InstalledPlaybook = { ...change.playbook, source: "bot" };
        const index = current.findIndex((playbook) => playbook.key === next.key);
        if (index === -1 && current.length >= PLAYBOOK_LIMITS.perBot) {
          throw new PlaybookRequestError(`a bot may have at most ${PLAYBOOK_LIMITS.perBot} playbooks`, 409);
        }
        playbooks = index === -1
          ? [...current, next]
          : current.map((playbook, at) => (at === index ? next : playbook));
      }

      if (!this.store.patchBotPlaybooks(target.id, { playbooks, lastPlaybookRequestId: payload.requestId })) {
        throw new PlaybookRequestError(NO_SUCH_BOT, 404);
      }

      const appliedAt = this.now();
      const settled = this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined, playbookRequest: { ...payload, appliedAt } },
      });
      if (!settled) throw new PlaybookRequestError("This playbook confirmation card is no longer available", 409);
      return { claimed: true, state: "applied", targetBotId: target.id, key, action: change.action };
    } catch (error) {
      const status = error instanceof PlaybookRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const saved = this.store.bot(payload.targetBotId)?.lastPlaybookRequestId === payload.requestId;
      const notice = "Playbook saved. Confirm again to finish recording this decision; the change will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, held: saved ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch { /* The durable playbook receipt still permits a safe retry. */ }
      if (saved) {
        return {
          claimed: true, state: "applied", targetBotId: payload.targetBotId, key,
          action: payload.change.action, settlementPending: true, message: notice,
        };
      }
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
