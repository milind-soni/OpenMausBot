// App-event automations a bot makes or changes from chat. Every change applies at once (OpenMausBot adds no
// confirmation card of its own); the conversation gets one receipt card with Pause, Edit and Undo.
import { z } from "zod";

import type { AppTrigger, AppTriggerRequestCardData, AppTriggerRequestOperation } from "../shared/app-triggers.ts";
import { appLabel } from "./app-event-catalog.ts";
import { AppTriggerError, type AppTriggerManager } from "./app-triggers.ts";
import { newId } from "./contracts.ts";
import { UNDO_STALE } from "./direct-apply.ts";
import { redactSecretsInText } from "./redact.ts";

export interface AppTriggerRequestCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  autoApplied?: boolean;
  undone?: boolean;
  appTriggerRequest?: AppTriggerRequestCardData;
}

export interface AppTriggerRequestStore {
  messagesFor(threadId: string): Array<{ id: string; card?: AppTriggerRequestCard }>;
  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: AppTriggerRequestCard; from?: { botId: string; name: string; color: string } },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: AppTriggerRequestCard }): unknown;
}

const filterSchema = z.object({
  from: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(200).optional(),
  label: z.string().trim().max(200).optional(),
  text: z.string().trim().max(200).optional(),
}).strict();
const definitionSchema = z.object({
  name: z.string().trim().min(1, "An automation needs a name").max(80),
  instructions: z.string().trim().max(20_000).default(""),
  app: z.string().trim().min(1).max(80),
  event: z.string().trim().min(1).max(128),
  account: z.string().trim().max(128).optional(),
  filter: filterSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  runOn: z.enum(["maus", "cloud"]).optional(),
}).strict();
const changesSchema = definitionSchema.pick({ name: true, instructions: true, filter: true, config: true, runOn: true }).partial().strict()
  .refine((changes) => Object.keys(changes).length > 0, "The update action needs at least one field in changes");
const idSchema = z.string().trim().min(1).max(200);
const targetSchema = z.object({ botId: z.string(), name: z.string() }).optional();
const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), trigger: definitionSchema, forBot: targetSchema }),
  z.object({ action: z.literal("update"), triggerId: idSchema, changes: changesSchema, forBot: targetSchema }),
  ...(["pause", "resume", "run_now", "delete"] as const).map((action) => z.object({ action: z.literal(action), triggerId: idSchema, forBot: targetSchema })),
]);

const ACTION_TITLE: Record<AppTriggerRequestOperation["action"], string> = {
  create: "Automation set up",
  update: "Automation changed",
  pause: "Automation paused",
  resume: "Automation resumed",
  run_now: "Automation ran once",
  delete: "Automation deleted",
};

type Described = Pick<AppTrigger, "app" | "event" | "eventName" | "accountLabel" | "filter" | "delivery">;

/** When it fires, in English for the model: "When an email arrives in Gmail (sales) from acme.com (it checks every 15 minutes)". */
export function appWhenText(trigger: Described): string {
  const filter = trigger.filter ?? {};
  const details = [filter.from && `from ${filter.from}`, filter.subject && `about “${filter.subject}”`, filter.label && `labeled ${filter.label}`, filter.text && `mentioning “${filter.text}”`]
    .filter(Boolean).join(" ");
  const account = trigger.accountLabel ? ` (${trigger.accountLabel})` : "";
  const when = trigger.event === "GMAIL_NEW_GMAIL_MESSAGE"
    ? `When an email arrives in Gmail${account}`
    : `When “${trigger.eventName}” happens in ${appLabel(trigger.app)}${account}`;
  return `${when}${details ? ` ${details}` : ""}${trigger.delivery === "poll" ? " (it checks every 15 minutes)" : ""}`;
}

/** What the card and the tool result say it does; the app shows its own translated sentence. */
export function appTriggerSentence(trigger: Described & Pick<AppTrigger, "prompt">, botName: string): string {
  const instructions = redactSecretsInText(trigger.prompt).trim();
  return `${appWhenText(trigger)}, ${botName} ${instructions ? `follows: ${instructions.slice(0, 400)}` : "reviews the event"}`;
}

export type AppTriggerRequestResult = { requestId: string; messageId: string; state: "applied"; action: AppTriggerRequestOperation["action"]; resultId: string; summary: string; runId?: string };

export type UndoAppTriggerRequestResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true }
  | { claimed: true; state: "undone"; action: AppTriggerRequestOperation["action"]; triggerId: string };

interface AppTriggerRequestServiceOptions {
  store: AppTriggerRequestStore;
  triggers: AppTriggerManager;
  botName: (botId: string) => string;
  now?: () => number;
}

export class AppTriggerRequestService {
  private readonly options: AppTriggerRequestServiceOptions;

  constructor(options: AppTriggerRequestServiceOptions) {
    this.options = options;
  }

  private owned(triggerId: string, owner: string): AppTrigger {
    const trigger = this.options.triggers.get(triggerId);
    if (!trigger || trigger.botId !== owner) throw new AppTriggerError("No automation with that id belongs to this bot. Call list_triggers and copy its id.", 404);
    return trigger;
  }

  async submit(args: { botId: string; threadId: string; operation: unknown; from?: { botId: string; name: string; color: string }; canCommit?: () => boolean }): Promise<AppTriggerRequestResult> {
    const parsed = operationSchema.safeParse(args.operation);
    if (!parsed.success) throw new AppTriggerError(parsed.error.issues[0]?.message ?? "Invalid automation request");
    const operation = parsed.data as AppTriggerRequestOperation;
    const owner = operation.forBot?.botId ?? args.botId;
    const triggers = this.options.triggers;
    const before = operation.action === "create" ? undefined : this.owned(operation.triggerId, owner);
    if (args.canCommit && !args.canCommit()) throw new AppTriggerError("The requesting turn ended before this change could be saved", 401);
    let after: AppTrigger | null = null;
    let runId: string | undefined;
    switch (operation.action) {
      case "create": {
        const { instructions, ...definition } = operation.trigger;
        after = await triggers.create({ ...definition, prompt: instructions, botId: owner, sourceThreadId: args.threadId });
        break;
      }
      case "update": {
        const { instructions, ...changes } = operation.changes;
        after = await triggers.update(operation.triggerId, { ...changes, ...(instructions !== undefined ? { prompt: instructions } : {}) });
        break;
      }
      case "pause":
      case "resume":
        after = await triggers.update(operation.triggerId, { enabled: operation.action === "resume" });
        break;
      case "run_now":
        runId = (await triggers.runNow(operation.triggerId))?.runId;
        after = before ?? null;
        break;
      case "delete":
        if (!await triggers.remove(operation.triggerId)) throw new AppTriggerError("That automation no longer exists.", 404);
        break;
    }
    const subject = after ?? before!;
    const summary = appTriggerSentence(subject, this.options.botName(owner));
    const requestId = newId();
    const payload: AppTriggerRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      createdAt: this.options.now?.() ?? Date.now(),
      operation,
      resultId: subject.id,
      undo: {
        name: redactSecretsInText(subject.name),
        ...(after && operation.action !== "run_now" ? { appliedUpdatedAt: after.updatedAt } : {}),
        ...(before && (operation.action === "update" || operation.action === "delete")
          ? { before: { name: before.name, prompt: before.prompt, runOn: before.runOn, enabled: before.enabled, config: before.config, ...(before.filter ? { filter: before.filter } : {}) } }
          : {}),
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
        appTriggerRequest: payload,
      },
      ...(args.from ? { from: args.from } : {}),
    });
    return { requestId, messageId: message.id, state: "applied", action: operation.action, resultId: subject.id, summary, ...(runId ? { runId } : {}) };
  }

  async undo(args: { botId: string; threadId: string; requestId: string }): Promise<UndoAppTriggerRequestResult> {
    const message = this.options.store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appTriggerRequest);
    const card = message?.card;
    const payload = card?.appTriggerRequest;
    if (!message || !card || !payload) return { claimed: false };
    if (card.undone) return { claimed: true, state: "already_undone" };
    const cannot = (error: string, status = 409): UndoAppTriggerRequestResult => ({ claimed: true, state: "invalid", error, status });
    const stale: UndoAppTriggerRequestResult = { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) return cannot("This change belongs to another conversation", 403);
    const operation = payload.operation;
    const owner = operation.forBot?.botId ?? payload.botId;
    const triggers = this.options.triggers;
    const triggerId = payload.resultId ?? "";
    const current = triggers.get(triggerId);
    const mine = current && current.botId === owner ? current : null;
    try {
      switch (operation.action) {
        case "run_now":
          return cannot("A test run can't be undone.");
        case "create":
          if (!mine || !await triggers.remove(triggerId)) return stale;
          break;
        case "update":
        case "pause":
        case "resume": {
          const before = payload.undo?.before;
          if (!mine || mine.updatedAt !== payload.undo?.appliedUpdatedAt) return stale;
          const patch = operation.action === "update"
            ? before ? { name: before.name, prompt: before.prompt, runOn: before.runOn, enabled: before.enabled, filter: before.filter ?? null, restoreConfig: before.config } : undefined
            : { enabled: operation.action === "pause" };
          if (!patch || !await triggers.update(triggerId, patch)) return stale;
          break;
        }
        case "delete":
          if (current || !await triggers.restore(triggerId)) return stale;
          break;
      }
    } catch (error) {
      return cannot(redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500));
    }
    this.options.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
    return { claimed: true, state: "undone", action: operation.action, triggerId };
  }
}
