import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { OptionCardData, WireMessage } from "../shared/wire.ts";
import { formatQuestionAnswers } from "../shared/ask-question.ts";
import { channelQuestions, formatChannelApproval, formatChannelQuestion, parseChannelQuestionReply } from "../shared/channel-replies.ts";
import { formatChannelText } from "../shared/channel-text.ts";
import { writeFileAtomic } from "./atomic.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { classifyContinuable } from "./turn-continuation.ts";

export interface ChannelSnapshot {
  messageId: string; activeLeafId: string | null; activeTurnId: string | null; executionId: string | null;
  phase: string; messages: WireMessage[];
}
export interface ChannelAnswerTarget {
  threadId: string; sendId: string; requestId: string; cardMessageId: string; cardFingerprint: string;
  messageId: string; activeLeafId: string | null; activeTurnId: string | null; executionId: string | null;
}
interface Options {
  file: string; binding: string; stateUnavailable?: boolean;
  createAskTask(): string | null;
  send(threadId: string, sendId: string, text: string, target: { expectedActiveLeafId: string | null }): Promise<unknown>;
  snapshot(threadId: string, sendId: string): ChannelSnapshot;
  respond(target: ChannelAnswerTarget, behavior: "allow" | "deny" | "answer", message?: string): Promise<{ sendId?: string }>;
  notify?(id: string, text: string, channel: "imessage" | "text", isCurrent: () => boolean): Promise<void>;
  closed?: () => boolean; now?: () => number; sleep?: () => Promise<void>;
}
const id = z.string().min(1).max(300);
const activeSchema = z.object({ threadId: id, sendId: id });
const pendingSchema = activeSchema.extend({
  requestId: id, cardMessageId: id, cardFingerprint: z.string().regex(/^[a-f0-9]{64}$/), messageId: id,
  activeLeafId: id.nullable(), activeTurnId: id.nullable(), executionId: id.nullable(),
  code: z.string().regex(/^[A-F0-9]{8}$/), kind: z.enum(["question", "approval"]), expiresAt: z.number().finite(), presentedAt: z.number().finite().optional(),
  index: z.number().int().min(0).max(5), answers: z.array(z.array(z.string().max(2000)).max(12)).max(6), applying: z.boolean(),
});
const stateSchema = z.object({ version: z.literal(1), binding: z.string().min(1).max(1000), active: activeSchema.optional(), pending: pendingSchema.optional(),
  approvalMode: z.enum(["ask", "auto"]).optional(), approvalControlAt: z.number().finite().optional(),
  completedSendId: id.optional(),
  queued: z.array(z.string().min(1).max(32000)).max(5).optional(),
  watching: z.boolean().optional(), channel: z.enum(["imessage", "text"]).optional(), replyLimit: z.number().int().min(500).max(18995).optional(),
  lastEvent: z.object({ id, digest: z.string(), reply: z.string().max(19000) }).optional(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Pending = z.infer<typeof pendingSchema>;
/** Validate before migration as well as before observing any saved request. */
export function parseChannelConversationState(input: unknown): State {
  const state = stateSchema.parse(input);
  if (state.pending && (!state.active || state.pending.threadId !== state.active.threadId || state.pending.sendId !== state.active.sendId)) throw new Error("Invalid saved channel request");
  return state;
}
const unavailable = "The saved messaging state is unavailable. Open Mausbot to check this connection; no new work was started.";
const changed = "That question or approval changed or was already answered. Send STATUS for the current task, or NEW followed by a new request.";
const working = "The bot is still working on this task. I’ll send the result here when it’s ready.";
const queued = "Your followup is saved. I’ll continue with it in this conversation after the current work finishes.";
const queueFull = "The saved followup queue is full. Wait for the saved messages to finish before sending another.";
const tooLong = "This request is too long to show completely in one message. Review the full request in Mausbot.";
const review = "This request needs its full review screen or an account connection in Mausbot. Ordinary questions and tool approvals can be answered here.";
export function channelCardFingerprint(card: OptionCardData): string { return createHash("sha256").update(JSON.stringify(card)).digest("hex"); }

/** Transport-neutral owner conversation. The caller must authenticate the
 * sender and deduplicate inbound deliveries before invoking handle. No reply
 * text is itself authority: the host rechecks the exact pending request. */
export class ChannelConversation {
  private readonly options: Options;
  private state: State;
  private failed = false;
  private automaticRevoked = false;
  private revocationGeneration = 0;
  private watchGeneration = 0;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  constructor(options: Options) {
    this.options = options;
    this.state = { version: 1, binding: options.binding };
    if (options.stateUnavailable) { this.failed = true; return; }
    try {
      if (existsSync(options.file)) {
        if (statSync(options.file).size > 256 * 1024) throw new Error();
        const state = parseChannelConversationState(JSON.parse(readFileSync(options.file, "utf8")));
        if (state.binding !== options.binding) throw new Error();
        this.state = state;
      }
    } catch { this.failed = true; }
  }
  get approvalMode(): "ask" | "auto" { return this.failed || this.automaticRevoked ? "ask" : this.state.approvalMode ?? "ask"; }
  get activeThreadId(): string | null { return this.failed ? null : this.state.active?.threadId ?? null; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private save() {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.options.file, JSON.stringify(this.state), { mode: 0o600 });
    } catch { this.failed = true; throw new Error(unavailable); }
  }
  /** Called only after the transport is ready. Restore observation, never a decision. */
  resume() { if (this.state.watching && !this.failed) this.scheduleWatch(); }
  private scheduleWatch() {
    if (!this.options.notify || this.options.closed?.() || this.failed) return;
    clearTimeout(this.watchTimer);
    const generation = this.watchGeneration;
    this.watchTimer = setTimeout(() => { void this.observe(generation); }, 250);
    this.watchTimer.unref();
  }
  private async observe(generation: number) {
    // Serialize state changes with owner replies, but release that queue before
    // notify: the transport may be waiting on an owner callback in this queue.
    const observation = this.queue.then(async () => {
      if (generation !== this.watchGeneration || this.options.closed?.() || this.failed) return;
      const reply = await this.waitForResult(generation);
      if (generation !== this.watchGeneration || this.options.closed?.() || !reply) return;
      if (reply === working) { this.scheduleWatch(); return; }
      this.state.watching = this.state.completedSendId === this.state.active?.sendId && Boolean(this.state.queued?.length); this.save();
      const noticeId = `notice_${createHash("sha256").update(JSON.stringify([this.state.active, this.state.pending?.code, reply])).digest("hex")}`;
      return { noticeId, reply, channel: this.state.channel ?? "imessage" as const };
    });
    this.queue = observation.then(() => {}, () => {});
    try {
      const notice = await observation;
      if (!notice) return;
      await this.options.notify!(notice.noticeId, notice.reply, notice.channel,
        () => generation === this.watchGeneration && !this.options.closed?.() && !this.failed);
      if (generation === this.watchGeneration && this.state.watching) this.scheduleWatch();
    } catch {
      // Unknown delivery is not retried. Durable completedSendId lets an
      // explicit STATUS or restart inspect/continue queued work without
      // replaying the earlier host send or its uncertain notice.
    }
  }
  /** Called only for an authenticated owner delivery. Persist
   * revocation immediately, before the transport's serialized reply dispatch. */
  revokeAutomaticForOwnerMessage(text: string, timing?: { receivedAt: number; eventTimestamp?: number }) {
    if (!/^(?:ask me first|NEW\s+[\s\S]+)$/i.test(text.trim())) return;
    if (this.failed) throw new Error(unavailable);
    if (this.options.closed?.()) throw new Error("The message connection is paused.");
    this.automaticRevoked = true; ++this.revocationGeneration;
    this.state.approvalMode = "ask";
    this.state.approvalControlAt = Math.max(this.state.approvalControlAt ?? 0, timing?.eventTimestamp ?? timing?.receivedAt ?? this.now());
    this.save();
  }
  handle(eventId: string, text: string, context?: { channel: "imessage" | "text"; maxReplyCharacters: number; receivedAt?: number; eventTimestamp?: number }): Promise<string> {
    // Bind an incoming verdict before joining the dispatch queue: two YES
    // messages arriving together can never select successive requests.
    const arrivedPending = this.state.pending?.code;
    try {
      if (typeof text === "string") this.revokeAutomaticForOwnerMessage(text, context?.receivedAt === undefined ? undefined : { receivedAt: context.receivedAt, eventTimestamp: context.eventTimestamp });
    } catch { return Promise.resolve(this.failed ? unavailable : "The message connection is paused."); }
    const revocationGeneration = this.revocationGeneration;
    const result = this.queue.then(async () => {
      if (this.failed) return unavailable;
      if (this.options.closed?.()) return "The message connection is paused. Reconnect in Mausbot.";
      if (!id.safeParse(eventId).success || typeof text !== "string" || !text.trim() || text.length > 32000) return "Send a non-empty message of at most 32,000 characters.";
      const digest = createHash("sha256").update(text).digest("hex");
      if (this.state.lastEvent?.id === eventId) return this.state.lastEvent.digest === digest ? this.state.lastEvent.reply : "This message ID was already used. Send a new message.";
      ++this.watchGeneration; clearTimeout(this.watchTimer);
      this.state.watching = false;
      if (context) {
        this.state.channel = context.channel;
        this.state.replyLimit = Math.max(500, Math.min(18995, Math.floor(context.maxReplyCharacters)));
      }
      try {
        const reply = await this.receive(text.trim(), arrivedPending, context, revocationGeneration);
        this.state.watching = (/^(?:approve for me|ask me first)$/i.test(text.trim()) && Boolean(this.state.active)) || reply === working || reply === queued || (reply === queueFull && Boolean(this.state.queued?.length)) || (this.state.completedSendId === this.state.active?.sendId && Boolean(this.state.queued?.length));
        this.state.lastEvent = { id: eventId, digest, reply }; this.save();
        if (this.state.watching) this.scheduleWatch();
        return reply;
      } catch { return this.failed ? unavailable : "The reply could not be confirmed. Send STATUS before trying again; it will not be applied automatically."; }
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private snapshot() {
    const active = this.state.active;
    if (!active) throw new Error();
    const snapshot = this.options.snapshot(active.threadId, active.sendId);
    const source = snapshot.messages.find(m => m.id === snapshot.messageId);
    if (!source || source.sendId !== active.sendId || source.requestCancelled) throw new Error();
    return snapshot;
  }
  private async receive(text: string, arrivedPending?: string, timing?: { receivedAt?: number; eventTimestamp?: number }, revocationGeneration = this.revocationGeneration): Promise<string> {
    if (/^approve for me$/i.test(text)) {
      const controlAt = timing?.eventTimestamp ?? timing?.receivedAt ?? this.now();
      if (this.state.approvalControlAt !== undefined && controlAt <= this.state.approvalControlAt) return `That preference message is not newer than your last change. Messaging approvals: ${this.approvalMode === "auto" ? "Automatic" : "Ask first"}.`;
      this.state.approvalControlAt = controlAt;
    }
    if (/^approve for me$/i.test(text)) {
      if (revocationGeneration !== this.revocationGeneration) return "Messaging approvals: Ask first. A newer message revoked automatic approvals.";
      this.automaticRevoked = false; this.state.approvalMode = "auto"; this.save();
      return 'Messaging approvals: Automatic. I’ll approve ordinary actions in this conversation and send a short notice. Questions and review screens still need you. Reply "ask me first" to switch back. NEW resets to Ask first.';
    }
    if (/^ask me first$/i.test(text)) {
      this.state.approvalMode = "ask"; this.save();
      return 'Messaging approvals: Ask first. I’ll wait for "yes" or "approve" before each action. Reply "no" or "deny" to reject it. Send STATUS to see any pending request.';
    }
    if (/^STATUS$/i.test(text)) {
      if (!this.state.active) return "There is no messaging task yet. Send what you would like the bot to do.";
      // Explicit status is a read, never a retry of an uncertain decision.
      if (this.state.pending?.applying) return "The previous reply has an unknown result. Check the task in Mausbot; it will not be applied again automatically.";
      return this.waitForResult();
    }
    const fresh = /^NEW\s+([\s\S]+)$/i.exec(text);
    if (fresh) { this.state.approvalMode = "ask"; this.state.approvalControlAt = Math.max(this.state.approvalControlAt ?? 0, timing?.eventTimestamp ?? timing?.receivedAt ?? this.now()); delete this.state.pending; delete this.state.active; delete this.state.queued; delete this.state.completedSendId; this.save(); return this.start(fresh[1]!); }
    const pending = this.state.pending;
    if (pending) {
      if (pending.kind === "approval" && /^(?:yes|approve|no|deny)$/i.test(text) &&
        (arrivedPending !== pending.code || pending.presentedAt === undefined ||
         (timing?.receivedAt !== undefined && timing.receivedAt <= pending.presentedAt) ||
         (timing?.eventTimestamp !== undefined && timing.eventTimestamp < pending.presentedAt))) return "That reply may refer to an earlier approval. Send STATUS, then reply yes or no to the current request.";
      return this.reply(pending, text);
    }
    if (/^(?:YES|NO|APPROVE|DENY|ANSWER)(?:\s|$)/i.test(text)) return "There is no matching pending request. Send STATUS to check the task.";
    if (this.state.active) {
      try {
        const snapshot = this.snapshot();
        if (snapshot.phase === "untracked") return changed;
        if (snapshot.phase !== "settled" || this.state.queued?.length || snapshot.messages.some(message =>
          message.requestMessageId === snapshot.messageId && message.card?.requestId && !message.card.answered && !message.card.dismissed && !message.card.expired)) {
          if ((this.state.queued?.length ?? 0) >= 5 || (this.state.queued ?? []).reduce((size, item) => size + item.length, text.length) > 32000) return queueFull;
          (this.state.queued ??= []).push(text); this.save();
          return queued;
        }
        return this.start(text, snapshot.activeLeafId);
      }
      catch { return changed; }
    }
    return this.start(text);
  }
  private async start(text: string, expectedActiveLeafId: string | null = null): Promise<string> {
    if (this.options.closed?.()) return "The message connection is paused.";
    // Check state can be stored before creating or sending host work.
    this.save();
    const threadId = this.state.active?.threadId ?? this.options.createAskTask();
    if (!threadId) return "The configured messaging bot is unavailable. Choose a bot in iMessage settings.";
    this.state.active = { threadId, sendId: randomUUID() }; delete this.state.pending; this.save();
    await this.options.send(threadId, this.state.active.sendId, text, { expectedActiveLeafId });
    return this.waitForResult();
  }
  private prompt(pending: Pending, card: OptionCardData): string {
    if (pending.kind === "approval") {
      const text = formatChannelApproval(card, pending.code);
      return text && text.length <= (this.state.replyLimit ?? 18000) ? text : tooLong;
    }
    const questions = channelQuestions(card);
    if (!questions || !questions[pending.index]) return changed;
    const text = formatChannelQuestion(questions[pending.index]!, pending.code, pending.index, questions.length);
    return text.length <= (this.state.replyLimit ?? 18000) ? text : tooLong;
  }
  private async reply(pending: Pending, text: string): Promise<string> {
    if (pending.applying) return "The previous reply was interrupted and its result is unknown. Send STATUS; that reply will not be applied again automatically.";
    if (pending.expiresAt <= this.now()) { delete this.state.pending; this.save(); return pending.kind === "question" ? "That question expired. Send STATUS to see the current question." : "That approval expired. Send STATUS to see the current approval."; }
    let snapshot: ChannelSnapshot;
    try { snapshot = this.snapshot(); } catch { delete this.state.pending; this.save(); return changed; }
    const card = snapshot.messages.find(m => m.id === pending.cardMessageId && m.card?.requestId === pending.requestId)?.card;
    if (snapshot.messages.filter(m => m.card?.requestId && !m.card.answered && !m.card.dismissed && !m.card.expired && m.requestMessageId === snapshot.messageId).length !== 1 ||
      (pending.kind === "approval" && (snapshot.phase !== "waiting" || snapshot.activeTurnId !== pending.activeTurnId || snapshot.executionId !== pending.executionId)) ||
      !card || card.answered || card.dismissed || card.expired || channelCardFingerprint(card) !== pending.cardFingerprint) { delete this.state.pending; this.save(); return changed; }
    let behavior: "allow" | "deny" | "answer";
    let answer: string | undefined;
    if (pending.kind === "approval") {
      const choice = /^(APPROVE|DENY)\s+([A-F0-9]{8})$/i.exec(text);
      const plain = /^(yes|approve|no|deny)$/i.exec(text);
      if (!plain && (!choice || choice[2]!.toUpperCase() !== pending.code)) return 'Reply "yes" or "approve" for this request, or "no" or "deny". Send STATUS if the request has changed.';
      behavior = /^(yes|approve)$/i.test(plain?.[1] ?? choice![1]!) ? "allow" : "deny";
    } else {
      if (/^(?:APPROVE|DENY)(?:\s|$)/i.test(text)) return "This is a question, not an action approval. Reply with an option number or your own answer.";
      const questions = channelQuestions(card);
      if (!questions || !questions[pending.index]) return changed;
      const parsed = parseChannelQuestionReply(questions[pending.index]!, text, pending.code);
      if ("error" in parsed) {
        const feedback = `${parsed.error}\n\n${this.prompt(pending, card)}`;
        return feedback.length <= (this.state.replyLimit ?? 18000) ? feedback : parsed.error;
      }
      pending.answers[pending.index] = parsed.answers;
      if (pending.index + 1 < questions.length) {
        pending.index++; pending.code = randomBytes(4).toString("hex").toUpperCase(); this.save();
        const prompt = this.prompt(pending, card);
        if (prompt === tooLong) { delete this.state.pending; this.save(); }
        return prompt;
      }
      behavior = "answer";
      answer = formatQuestionAnswers(questions, pending.answers);
    }
    return this.apply(pending, behavior, answer);
  }
  private async apply(pending: Pending, behavior: "allow" | "deny" | "answer", answer?: string, automatic = false): Promise<string> {
    if (this.options.closed?.() || (automatic && this.approvalMode !== "auto")) return "The message connection is paused; the reply was not applied.";
    // Write intent before the host can act. A crash never automatically replays it.
    pending.applying = true; this.save();
    const result = await this.options.respond(pending, behavior, answer);
    if (result.sendId && this.state.active) this.state.active.sendId = result.sendId;
    delete this.state.pending; this.save();
    return automatic ? working : this.waitForResult();
  }
  private async waitForResult(watchGeneration?: number): Promise<string> {
    const deadline = this.now() + 1500;
    while (!this.options.closed?.() && this.now() < deadline) {
      if (watchGeneration !== undefined && watchGeneration !== this.watchGeneration) return "";
      let snapshot: ChannelSnapshot;
      try { snapshot = this.snapshot(); } catch { return changed; }
      if (this.state.pending?.applying) return "The previous reply has an unknown result. Check the task in Mausbot; it will not be applied again automatically.";
      const pendingMessages = snapshot.messages.filter(m => m.card?.requestId && !m.card.answered && !m.card.dismissed && !m.card.expired && m.requestMessageId === snapshot.messageId);
      if (pendingMessages.length > 1) { delete this.state.pending; this.save(); return "There are multiple pending requests. Review them in Mausbot before replying here."; }
      const pendingMessage = pendingMessages[0];
      if (pendingMessage?.card) {
        const card = pendingMessage.card;
        const questions = channelQuestions(card);
        const kind = questions ? "question" : formatChannelApproval(card, "00000000") ? "approval" : null;
        if (!kind) return review;
        if (kind === "approval" && (snapshot.phase !== "waiting" || !snapshot.activeTurnId || !snapshot.executionId || pendingMessage.turnId !== snapshot.activeTurnId)) return "That approval is no longer live. Open the task in Mausbot or send NEW followed by a new request.";
        const fingerprint = channelCardFingerprint(card);
        let pending = this.state.pending;
        if (pending?.applying && pending.requestId === card.requestId) return "The previous reply has an unknown result. Check the task in Mausbot; it will not be applied again automatically.";
        if (!pending || pending.cardMessageId !== pendingMessage.id || pending.cardFingerprint !== fingerprint || pending.expiresAt <= this.now()) {
          pending = { ...this.state.active!, messageId: snapshot.messageId, activeLeafId: snapshot.activeLeafId, activeTurnId: snapshot.activeTurnId, executionId: snapshot.executionId,
            cardMessageId: pendingMessage.id, requestId: card.requestId!, cardFingerprint: fingerprint, kind,
            code: randomBytes(4).toString("hex").toUpperCase(), presentedAt: this.now(), expiresAt: this.now() + (kind === "approval" ? 15 * 60_000 : 24 * 60 * 60_000), index: 0, answers: [], applying: false };
          this.state.pending = pending; this.save();
        }
        if (pending.applying) return "The previous reply has an unknown result. Check the task in Mausbot; it will not be applied again automatically.";
        const prompt = this.prompt(pending, card);
        if (pending.presentedAt === undefined) { pending.presentedAt = this.now(); this.save(); }
        if (pending.kind === "approval" && this.approvalMode === "auto" && prompt !== tooLong && prompt !== review) {
          const result = await this.apply(pending, "allow", undefined, true);
          // Do not await transport while holding the owner dispatch queue.
          // The durable applying fence above makes this notice non-replayable.
          if (result === working && this.options.notify) {
            const notice = `Automatically approved: ${formatChannelText(card.title).slice(0, 180)}${card.tool ? ` (${card.tool.slice(0, 80)})` : ""}.`;
            void this.options.notify(`approval_${pending.code}`, notice, this.state.channel ?? "imessage", () => !this.options.closed?.() && !this.failed).catch(() => {});
          }
          return result;
        }
        if (prompt === tooLong || prompt === review) { delete this.state.pending; this.save(); }
        return prompt;
      }
      if (snapshot.phase === "settled") {
        delete this.state.pending; this.save();
        const terminal = snapshot.messages.findLast(m => m.role === "bot" && m.kind === "text" && m.turnTerminal && m.turnSucceeded && m.requestMessageId === snapshot.messageId && m.text);
        const followup = this.state.completedSendId === this.state.active?.sendId ? this.state.queued?.shift() : undefined;
        if (followup) {
          // Remove and persist before dispatch. A crash may leave uncertainty,
          // but it must never automatically repeat an accepted host send.
          this.save();
          return this.start(followup, snapshot.activeLeafId);
        }
        this.state.completedSendId = this.state.active!.sendId; this.save();
        return terminal?.text ? formatChannelText(terminal.text).slice(0, this.state.replyLimit ?? 18000) : "The task has finished. Its result is available in Mausbot.";
      }
      if (snapshot.phase === "waiting") return review;
      if (snapshot.phase === "untracked") {
        const failure = snapshot.messages.findLast(message => message.kind === "activity" && message.tool?.terminal && message.tool.ok === false);
        const lastTurn = snapshot.messages.findLast(message => message.turnId)?.turnId;
        if (!snapshot.activeTurnId && failure?.requestMessageId === snapshot.messageId && failure.turnId && failure.turnId === lastTurn &&
          classifyContinuable(null, failedTurnCause(failure.tool!.name) ?? undefined) === "cap") {
          return "The bot stopped at its turn budget before finishing. Open this task in Mausbot to review the work, or send NEW followed by what remains to start another task here.";
        }
        return changed;
      }
      await (this.options.sleep?.() ?? new Promise(resolve => setTimeout(resolve, 100)));
    }
    return working;
  }
}
