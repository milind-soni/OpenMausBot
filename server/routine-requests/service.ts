// Routine request service — proposes confirmation cards, revalidates them
// at resolve time, and applies changes with exact-once receipt semantics.

import { normalizeCronSchedule } from "../../shared/routine-schedule.ts";
import { newId } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { schemaIssue } from "../schema.ts";
import {
  nextOccurrence,
  type Routine,
  type RoutineManager,
  type RoutineRequestCommit,
} from "../routines.ts";
import type {
  RoutineRequestCardData,
  RoutineRequestOperation,
} from "../../shared/routine-request.ts";
import {
  routineProposalSchema,
  routineRequestCardDataSchema,
  storedScheduleSchema,
} from "./schemas.ts";
import {
  type ProposeRoutineRequestArgs,
  type ResolveRoutineRequestResult,
  type RoutineProposalResult,
  type RoutineRequestOptionCard,
  type RoutineRequestServiceOptions,
  type RoutineRequestStore,
  RoutineRequestError,
} from "./types.ts";
import {
  asSchedule,
  effectiveDefinition,
  effectiveSchedule,
  noFutureResumeMessage,
  normalizedOperation,
  ownedRoutine,
  text,
} from "./normalize.ts";
import {
  ROUTINE_REQUEST_FINGERPRINT_VERSION,
  cardCopy,
  inputFromDefinition,
  routineRequestFingerprint,
  updateFromChanges,
} from "./copy.ts";

function verifyManageSnapshot(
  operation: Exclude<RoutineRequestOperation, { action: "create" }>,
  manager: RoutineManager,
  botId: string,
): Routine {
  const current = ownedRoutine(manager, operation.routineId, botId);
  if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
  if (current.updatedAt !== operation.expectedUpdatedAt) {
    throw new RoutineRequestError(
      "That routine changed after this confirmation card was prepared. Ask the bot to review it and propose the action again.",
      409,
    );
  }
  return current;
}

function requestCommit(payload: RoutineRequestCardData, messageId: string): RoutineRequestCommit {
  return {
    requestId: payload.requestId,
    messageId,
    botId: payload.botId,
    threadId: payload.threadId,
    action: payload.operation.action,
    fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
    fingerprint: routineRequestFingerprint(payload, messageId),
  };
}

function revalidateOperation(operation: RoutineRequestOperation, manager: RoutineManager, botId: string, now: number): void {
  const current = operation.action === "create"
    ? null
    : verifyManageSnapshot(operation, manager, botId);
  const schedule = operation.action === "create"
    ? operation.routine.schedule
    : operation.action === "update"
      ? operation.changes.schedule
      : undefined;
  if (schedule?.type === "cron") {
    try {
      normalizeCronSchedule(schedule, now);
    } catch (error) {
      throw new RoutineRequestError(error instanceof Error ? error.message : "Invalid cron schedule", 409);
    }
  }
  if (schedule?.type === "once" && schedule.at <= now) {
    throw new RoutineRequestError("That one-time schedule is now in the past. Ask the bot to propose a new time.", 409);
  }
  if (schedule?.type === "interval") {
    const base = operation.action === "create"
      ? operation.routine.schedule
      : current
        ? effectiveSchedule(
            current.schedule.type === "interval"
              ? {
                  ...current.schedule,
                  ...(current.schedule.weekdays ? { weekdays: [...current.schedule.weekdays] } : {}),
                  ...(current.schedule.window ? { window: { ...current.schedule.window } } : {}),
                }
              : current.schedule.type === "daily"
                ? { ...current.schedule, weekdays: [...current.schedule.weekdays] }
                : { ...current.schedule },
            schedule,
          )
        : null;
    const concrete = base ? asSchedule(base, now) : null;
    if (concrete) {
      const valid = storedScheduleSchema.safeParse(concrete);
      if (!valid.success) {
        throw new RoutineRequestError(schemaIssue(valid.error, "Invalid interval schedule"));
      }
    }
    if (concrete && nextOccurrence(concrete, now) === null) {
      throw new RoutineRequestError(
        "That interval no longer has a future run. Choose a later end time or remove the end restriction.",
        409,
      );
    }
  }
  if (operation.action === "resume") {
    if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
    if (nextOccurrence(current.schedule, now) === null) {
      throw new RoutineRequestError(noFutureResumeMessage(current.schedule), 409);
    }
  }
}

export class RoutineRequestService {
  private readonly store: RoutineRequestStore;
  private readonly routines: RoutineManager;
  private readonly now: () => number;
  private readonly timeZone: () => string;
  private readonly cloudReady?: () => Promise<{ ready: boolean; reason?: string }>;
  private readonly canPersist?: RoutineRequestServiceOptions["canPersist"];
  private readonly validateTarget?: RoutineRequestServiceOptions["validateTarget"];
  private readonly autoApply?: RoutineRequestServiceOptions["autoApply"];

  constructor(options: RoutineRequestServiceOptions) {
    this.store = options.store;
    this.routines = options.routines;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.cloudReady = options.cloudReady;
    this.canPersist = options.canPersist;
    this.validateTarget = options.validateTarget;
    this.autoApply = options.autoApply;
  }

  async propose(args: ProposeRoutineRequestArgs): Promise<RoutineProposalResult> {
    return this.prepare(args);
  }

  async submit(args: ProposeRoutineRequestArgs) {
    const proposal = await this.prepare(args, true);
    return { ...proposal, state: proposal.result ? "applied" as const : "pending" as const };
  }

  private async prepare(args: ProposeRoutineRequestArgs, submitted = false): Promise<RoutineProposalResult & {
    result?: Extract<ResolveRoutineRequestResult, { state: "applied" }>;
  }> {
    const botId = text(args.botId, "botId", 128);
    const threadId = text(args.threadId, "threadId", 128);
    const at = this.now();
    const parsedProposal = routineProposalSchema.safeParse(args.proposal);
    if (!parsedProposal.success) {
      throw new RoutineRequestError(schemaIssue(parsedProposal.error, "Invalid routine proposal"));
    }
    const operation = normalizedOperation(this.routines, botId, parsedProposal.data, at);
    if (operation.action === "create" && operation.forBot && this.validateTarget) {
      const refusal = this.validateTarget(botId, operation.forBot);
      if (refusal) throw new RoutineRequestError(refusal, 403);
    }
    await this.requireCloudReadiness(operation);
    // The readiness probe is asynchronous. Another request can edit or
    // delete the routine while it is in flight, so re-check the captured
    // revision before rendering and persisting the confirmation snapshot.
    const cardAt = this.now();
    revalidateOperation(operation, this.routines, botId, cardAt);
    const requestId = newId();
    const payload: RoutineRequestCardData = {
      version: 1,
      requestId,
      botId,
      threadId,
      createdAt: cardAt,
      operation,
    };
    const definition = effectiveDefinition(operation, this.routines);
    const timeZone = definition?.schedule.type === "cron" ? definition.schedule.timeZone : this.timeZone();
    const copy = cardCopy(operation, this.routines, timeZone, cardAt);
    const messageInput: Parameters<RoutineRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: ["Confirm", "Cancel"],
        requestId,
        tool: copy.tool,
        routineRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    // This check and append are deliberately adjacent and synchronous. JS
    // cannot interleave another completed proposal between the capacity /
    // ownership decision and the durable transcript write.
    const persistence = this.canPersist?.(botId, threadId);
    if (persistence && !persistence.ok) {
      throw new RoutineRequestError(persistence.error, persistence.status);
    }
    if (args.canCommit && !args.canCommit()) {
      throw new RoutineRequestError("The requesting turn ended before this proposal could be saved", 401);
    }
    // Resolve the current source-thread grant after the asynchronous probe.
    const automatic = submitted && this.autoApply?.(botId, threadId) === true;
    if (automatic) {
      messageInput.card.options = [];
      messageInput.card.dismissed = true;
    }
    const message = this.store.appendMessage(threadId, messageInput);
    const proposal = {
      requestId,
      messageId: message.id,
      title: copy.title,
      summary: copy.summary,
      detail: copy.detail,
      nextRunAt: copy.nextRunAt,
      timeZone,
    };
    if (!automatic) return proposal;
    // Persist a hidden receipt first, then use the existing validated,
    // idempotent commit path without exposing a pending confirmation.
    let result: ResolveRoutineRequestResult;
    try {
      result = this.resolve({ botId, threadId, requestId, behavior: "allow" });
    } catch (error) {
      result = { claimed: true, state: "invalid", error: error instanceof Error ? error.message : String(error), status: error instanceof RoutineRequestError ? error.status : 400 };
    }
    if (result.state === "applied") return { ...proposal, result };
    // The scheduler commit can succeed even if settling its transcript
    // fails. Report that exact result; a retry only finishes the receipt.
    const receipt = this.routines.routineRequestReceipt(requestId);
    if (receipt && receipt.botId === botId && receipt.threadId === threadId && receipt.messageId === message.id &&
      receipt.fingerprintVersion === ROUTINE_REQUEST_FINGERPRINT_VERSION && receipt.fingerprint === routineRequestFingerprint(payload, message.id)) {
      return { ...proposal, result: {
        claimed: true, state: "applied", action: receipt.action, resultId: receipt.resultId,
        settlementPending: true, message: "Routine change applied. Recording the operation receipt could not finish; the change will not be applied again.",
      } };
    }
    throw new RoutineRequestError(result.state === "invalid" ? result.error : "The routine change could not be applied", result.state === "invalid" ? result.status : 409);
  }

  private async requireCloudReadiness(operation: RoutineRequestOperation): Promise<void> {
    if (!this.cloudReady || operation.action === "pause" || operation.action === "delete") return;
    const definition = effectiveDefinition(operation, this.routines);
    if (definition?.runOn !== "cloud") return;
    let readiness: { ready: boolean; reason?: string };
    try {
      readiness = await this.cloudReady();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoutineRequestError(`Could not verify cloud readiness: ${detail}`, 503);
    }
    if (readiness.ready) return;
    throw new RoutineRequestError(
      readiness.reason?.trim() || "Cloud execution is not configured yet. Set up a cloud computer first.",
      409,
    );
  }

  /**
   * Claims a routine card even after it was settled. That distinction is
   * important: duplicate clicks must never fall through to a provider that
   * did not create the request id.
   */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveRoutineRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.routineRequest);
    const card = message?.card;
    const rawPayload = card?.routineRequest;
    if (!message || !card || !rawPayload) return { claimed: false, state: "not_found" };
    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return {
        claimed: true,
        state: "invalid",
        error: "Routine confirmations must be confirmed or cancelled",
        status: 400,
      };
    }
    const parsedPayload = routineRequestCardDataSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };
      const recovered = this.settleCommittedReceipt(args, message.id, card);
      if (recovered) return recovered;
      // Cancelling is always safe and must remain possible even if an older
      // persisted payload no longer passes today's schema. Otherwise that
      // durable card would own the composer forever with no escape hatch.
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      const detail = schemaIssue(parsedPayload.error, "This routine request is invalid");
      this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, held: redactSecretsInText(detail).slice(0, 500) },
      });
      return { claimed: true, state: "invalid", error: detail, status: 400 };
    }
    const payload: RoutineRequestCardData = parsedPayload.data;
    if (payload.requestId !== args.requestId) {
      const recovered = this.settleCommittedReceipt(args, message.id, card);
      if (recovered) return recovered;
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      return { claimed: true, state: "invalid", error: "This routine request id does not match its confirmation card", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      const recovered = this.settleCommittedReceipt(args, message.id, card);
      if (recovered) return recovered;
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      return { claimed: true, state: "invalid", error: "This routine request belongs to another conversation", status: 403 };
    }
    if (card.answered) {
      this.forgetSettledReceipt(payload, message.id);
      return { claimed: true, state: "already_settled", behavior: card.answered };
    }

    try {
      const fingerprint = routineRequestFingerprint(payload, message.id);
      const receipt = this.routines.routineRequestReceipt(payload.requestId);
      if (receipt) {
        if (
          receipt.botId !== payload.botId ||
          receipt.threadId !== payload.threadId ||
          receipt.messageId !== message.id ||
          receipt.action !== payload.operation.action ||
          receipt.fingerprintVersion !== ROUTINE_REQUEST_FINGERPRINT_VERSION ||
          receipt.fingerprint !== fingerprint
        ) {
          throw new RoutineRequestError("This routine request does not match its durable commit receipt", 409);
        }
        return this.settleApplied(
          args.threadId,
          message.id,
          card,
          payload,
          receipt.resultId,
          receipt.appliedAt,
        );
      }
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      revalidateOperation(payload.operation, this.routines, payload.botId, this.now());
      if (payload.operation.action === "create" && payload.operation.forBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.operation.forBot);
        if (refusal) throw new RoutineRequestError(refusal, 404);
      }
      const resultId = this.apply(payload, message.id, fingerprint);
      return this.settleApplied(args.threadId, message.id, card, payload, resultId);
    } catch (error) {
      const status = error instanceof RoutineRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, held: redactSecretsInText(detail).slice(0, 500) },
      });
      return {
        claimed: true,
        state: "invalid",
        error: detail,
        status,
      };
    }
  }

  private settleApplied(
    threadId: string,
    messageId: string,
    card: RoutineRequestOptionCard,
    payload: RoutineRequestCardData,
    resultId: string,
    appliedAt = this.now(),
  ): ResolveRoutineRequestResult {
    const applied: RoutineRequestCardData = {
      ...payload,
      appliedAt,
      resultId,
    };
    const settled = this.store.patchMessage(threadId, messageId, {
      card: { ...card, answered: "allow", held: undefined, routineRequest: applied },
    });
    if (!settled) throw new RoutineRequestError("This routine confirmation card is no longer available", 409);
    this.forgetSettledReceipt(payload, messageId);
    return { claimed: true, state: "applied", action: payload.operation.action, resultId };
  }

  private forgetSettledReceipt(payload: RoutineRequestCardData, messageId: string): void {
    this.forgetReceipt(requestCommit(payload, messageId));
  }

  private settleCommittedReceipt(
    args: { botId: string; threadId: string; requestId: string },
    messageId: string,
    card: RoutineRequestOptionCard,
  ): ResolveRoutineRequestResult | null {
    const receipt = this.routines.routineRequestReceipt(args.requestId);
    if (!receipt) return null;
    if (receipt.botId !== args.botId || receipt.threadId !== args.threadId || receipt.messageId !== messageId) {
      return {
        claimed: true,
        state: "invalid",
        error: "This committed routine request belongs to another conversation",
        status: 403,
      };
    }
    const settled = this.store.patchMessage(args.threadId, messageId, {
      card: { ...card, answered: "allow", held: undefined },
    });
    if (!settled) {
      return {
        claimed: true,
        state: "invalid",
        error: "This routine confirmation card is no longer available",
        status: 409,
      };
    }
    this.forgetReceipt(receipt);
    return {
      claimed: true,
      state: "applied",
      action: receipt.action,
      resultId: receipt.resultId,
    };
  }

  private forgetReceipt(request: RoutineRequestCommit): void {
    try {
      this.routines.forgetRoutineRequestReceipt(request);
    } catch {
      // The transcript is already durably settled. Retaining a redundant
      // receipt after a cleanup write failure is safe and a later duplicate
      // response will retry this cleanup.
    }
  }

  private apply(payload: RoutineRequestCardData, messageId: string, fingerprint: string): string {
    const operation = payload.operation;
    const confirmationAt = this.now();
    switch (operation.action) {
      case "create":
        return this.routines.create(inputFromDefinition(
          operation.routine,
          operation.forBot?.botId ?? payload.botId,
          confirmationAt,
        ), {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "create",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        }).id;
      case "update": {
        const current = verifyManageSnapshot(operation, this.routines, payload.botId);
        const updated = this.routines.update(
          operation.routineId,
          updateFromChanges(operation.changes, confirmationAt, current.schedule),
          {
            requestId: payload.requestId,
            messageId,
            botId: payload.botId,
            threadId: payload.threadId,
            action: "update",
            fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
            fingerprint,
          },
        );
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "pause":
      case "resume": {
        verifyManageSnapshot(operation, this.routines, payload.botId);
        const updated = this.routines.update(operation.routineId, { enabled: operation.action === "resume" }, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: operation.action,
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "run_now": {
        verifyManageSnapshot(operation, this.routines, payload.botId);
        const run = this.routines.runNow(operation.routineId, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "run_now",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!run) throw new RoutineRequestError("That routine no longer exists", 404);
        return run.id;
      }
      case "delete":
        verifyManageSnapshot(operation, this.routines, payload.botId);
        if (!this.routines.remove(operation.routineId, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "delete",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        })) {
          throw new RoutineRequestError("That routine no longer exists", 404);
        }
        return operation.routineId;
      default:
        throw new RoutineRequestError("Unsupported persisted routine action");
    }
  }
}
