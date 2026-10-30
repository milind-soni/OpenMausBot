// Webhook triggers a bot makes or changes from chat. Every change applies at once (OpenMausBot adds no confirmation
// card of its own); the conversation gets a receipt card with Undo, which never carries the address.
import { z } from "zod";

import type { WebhookRequestCardData, WebhookRequestDefinition, WebhookRequestOperation, WebhookRequestSnapshot } from "../shared/webhook-request.ts";
import { newId } from "./contracts.ts";
import { UNDO_STALE } from "./direct-apply.ts";
import { redactSecretsInText } from "./redact.ts";
import type { WebhookManager, WebhookTrigger } from "./webhooks.ts";

export interface WebhookRequestCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  autoApplied?: boolean;
  undone?: boolean;
  webhookRequest?: WebhookRequestCardData;
}

export interface WebhookRequestStore {
  messagesFor(threadId: string): Array<{ id: string; card?: WebhookRequestCard }>;
  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: WebhookRequestCard; from?: { botId: string; name: string; color: string } },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: WebhookRequestCard }): unknown;
}

export class WebhookRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const NAME_MAX = 80;
const INSTRUCTIONS_MAX = 20_000;
const definitionSchema = z.object({
  name: z.string().trim().min(1, "A webhook trigger needs a name").max(NAME_MAX),
  instructions: z.string().trim().max(INSTRUCTIONS_MAX).default(""),
  runOn: z.enum(["maus", "cloud"]).default("maus"),
  eventTypes: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict();
const changesSchema = definitionSchema.partial().strict()
  .refine((changes) => Object.keys(changes).length > 0, "The update action needs at least one field in changes");
const webhookIdSchema = z.string().trim().min(1).max(200);
const targetSchema = z.object({ botId: z.string(), name: z.string() }).optional();
const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), webhook: definitionSchema, forBot: targetSchema }),
  z.object({ action: z.literal("update"), webhookId: webhookIdSchema, changes: changesSchema, forBot: targetSchema }),
  ...(["pause", "resume", "run_now", "delete"] as const).map((action) =>
    z.object({ action: z.literal(action), webhookId: webhookIdSchema, forBot: targetSchema })),
]);

export type WebhookRequestResult = {
  requestId: string;
  messageId: string;
  state: "applied";
  action: WebhookRequestOperation["action"];
  resultId: string;
  summary: string;
  runId?: string;
};

export type UndoWebhookRequestResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true }
  | { claimed: true; state: "undone"; action: WebhookRequestOperation["action"]; webhookId: string };

function snapshot(webhook: WebhookTrigger): WebhookRequestSnapshot {
  return {
    name: webhook.name,
    instructions: webhook.prompt,
    runOn: webhook.runOn,
    enabled: webhook.enabled,
    ...(webhook.eventTypes?.length ? { eventTypes: [...webhook.eventTypes] } : {}),
  };
}

function managerInput(definition: Partial<WebhookRequestDefinition>) {
  return {
    ...(definition.name !== undefined ? { name: definition.name } : {}),
    ...(definition.instructions !== undefined ? { prompt: definition.instructions } : {}),
    ...(definition.runOn !== undefined ? { runOn: definition.runOn } : {}),
    ...(definition.eventTypes !== undefined ? { eventTypes: definition.eventTypes } : {}),
  };
}

/** What the card and the tool result say the trigger does, credential-scrubbed. */
export function webhookTriggerSentence(webhook: Pick<WebhookTrigger, "prompt" | "eventTypes">, botName: string): string {
  const instructions = redactSecretsInText(webhook.prompt).trim();
  const events = webhook.eventTypes?.length ? ` (only ${webhook.eventTypes.join(", ")})` : "";
  return `When another app sends something${events}, ${botName} ${instructions ? `follows: ${instructions.slice(0, 400)}` : "does what it is asked"}`;
}

const ACTION_TITLE: Record<WebhookRequestOperation["action"], string> = {
  create: "Automation set up",
  update: "Automation changed",
  pause: "Automation paused",
  resume: "Automation resumed",
  run_now: "Automation ran once",
  delete: "Automation deleted",
};

interface WebhookRequestServiceOptions {
  store: WebhookRequestStore;
  webhooks: WebhookManager;
  botName: (botId: string) => string;
  now?: () => number;
}

export class WebhookRequestService {
  private readonly options: WebhookRequestServiceOptions;

  constructor(options: WebhookRequestServiceOptions) {
    this.options = options;
  }

  private get now() { return this.options.now?.() ?? Date.now(); }

  private owned(webhookId: string, owner: string): WebhookTrigger {
    const webhook = this.options.webhooks.list().find((candidate) => candidate.id === webhookId);
    if (!webhook || webhook.botId !== owner) {
      throw new WebhookRequestError("No webhook trigger with that id belongs to this bot. Call trigger_info and copy its id.", 404);
    }
    return webhook;
  }

  submit(args: {
    botId: string;
    threadId: string;
    operation: unknown;
    from?: { botId: string; name: string; color: string };
    canCommit?: () => boolean;
  }): WebhookRequestResult {
    const parsed = operationSchema.safeParse(args.operation);
    if (!parsed.success) throw new WebhookRequestError(parsed.error.issues[0]?.message ?? "Invalid webhook trigger request");
    const operation = parsed.data as WebhookRequestOperation;
    const owner = operation.forBot?.botId ?? args.botId;
    const webhooks = this.options.webhooks;
    const before = operation.action === "create" ? undefined : this.owned(operation.webhookId, owner);
    if (operation.action === "create") {
      const duplicate = webhooks.list().find((webhook) => webhook.botId === owner && webhook.enabled &&
        webhook.name === operation.webhook.name && webhook.prompt === operation.webhook.instructions);
      if (duplicate) {
        throw new WebhookRequestError(`An enabled webhook trigger with the same name and instructions already exists (${duplicate.id}). Use trigger_info to review it, then change that one instead.`, 409);
      }
    }
    if (args.canCommit && !args.canCommit()) throw new WebhookRequestError("The requesting turn ended before this change could be saved", 401);
    let after: WebhookTrigger | null = null;
    let runId: string | undefined;
    switch (operation.action) {
      case "create":
        after = webhooks.create({ ...managerInput(operation.webhook), name: operation.webhook.name, prompt: operation.webhook.instructions, botId: owner, enabled: true }).webhook;
        break;
      case "update":
        after = webhooks.update(operation.webhookId, managerInput(operation.changes));
        break;
      case "pause":
      case "resume":
        after = webhooks.update(operation.webhookId, { enabled: operation.action === "resume", verificationPending: false });
        break;
      case "run_now": {
        const result = webhooks.test(operation.webhookId);
        runId = result?.runId;
        after = before ?? null;
        break;
      }
      case "delete":
        if (!webhooks.remove(operation.webhookId)) throw new WebhookRequestError("That webhook trigger no longer exists.", 404);
        break;
    }
    const subject = after ?? before!;
    const resultId = subject.id;
    const botName = this.options.botName(owner);
    const summary = webhookTriggerSentence(subject, botName);
    const requestId = newId();
    const payload: WebhookRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      createdAt: this.now,
      operation,
      resultId,
      undo: {
        name: redactSecretsInText(subject.name),
        ...(after && operation.action !== "run_now" ? { appliedUpdatedAt: after.updatedAt } : {}),
        ...(before && (operation.action === "update" || operation.action === "delete") ? { before: snapshot(before) } : {}),
      },
    };
    const message = this.options.store.appendMessage(args.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: `${ACTION_TITLE[operation.action]}: ${redactSecretsInText(subject.name)}`,
        subtitle: summary,
        options: [],
        answered: "allow",
        dismissed: true,
        autoApplied: true,
        requestId,
        tool: operation.action === "create" ? "create_trigger" : "manage_trigger",
        webhookRequest: payload,
      },
      ...(args.from ? { from: args.from } : {}),
    });
    return { requestId, messageId: message.id, state: "applied", action: operation.action, resultId, summary, ...(runId ? { runId } : {}) };
  }

  undo(args: { botId: string; threadId: string; requestId: string }): UndoWebhookRequestResult {
    const message = this.options.store.messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.webhookRequest);
    const card = message?.card;
    const payload = card?.webhookRequest;
    if (!message || !card || !payload) return { claimed: false };
    if (card.undone) return { claimed: true, state: "already_undone" };
    const cannot = (error: string, status = 409): UndoWebhookRequestResult => ({ claimed: true, state: "invalid", error, status });
    const stale: UndoWebhookRequestResult = { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) return cannot("This change belongs to another conversation", 403);
    const operation = payload.operation;
    const owner = operation.forBot?.botId ?? payload.botId;
    const webhooks = this.options.webhooks;
    const webhookId = payload.resultId ?? "";
    const current = webhooks.list().find((candidate) => candidate.id === webhookId && candidate.botId === owner);
    try {
      switch (operation.action) {
        case "run_now":
          return cannot("A test call can't be undone.");
        case "create":
          if (!current || !webhooks.remove(webhookId)) return stale;
          break;
        case "update":
        case "pause":
        case "resume": {
          const before = payload.undo?.before;
          if (!current || current.updatedAt !== payload.undo?.appliedUpdatedAt) return stale;
          const patch = operation.action === "update"
            ? before ? { ...managerInput(before), eventTypes: before.eventTypes ?? [], enabled: before.enabled } : undefined
            : { enabled: operation.action === "pause" };
          if (!patch || !webhooks.update(webhookId, patch)) return stale;
          break;
        }
        case "delete":
          if (current || !webhooks.restore(webhookId)) return stale;
          break;
      }
    } catch (error) {
      return cannot(redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500));
    }
    this.options.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
    return { claimed: true, state: "undone", action: operation.action, webhookId };
  }
}
