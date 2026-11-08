// A bot's widget tree is normalised, scrubbed of secrets and given its text fallback here, once; everything after reads the stored message.
import { tagsDevs } from "../shared/devs-mention.ts";
import {
  clientWidgetAction, parseWidgetInput, resolveWidgetAction, threadActionTarget, urlActionTarget, widgetActions, widgetFieldOptions, widgetFields, widgetToText, WIDGET_LIMITS,
  type WidgetAction, type WidgetActionEntry, type WidgetNode, type WidgetPayload, type WidgetRoot, type WidgetSettled,
} from "../shared/widget.ts";
import type { MausColor } from "../shared/wire.ts";
import type { ChatApps } from "./chat-apps.ts";
import type { BotFolders } from "./pages/bundle.ts";
import { createOptionsCard } from "./options-card.ts";
import { isSecretName, mask, redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export interface AgentCardStore {
  groupByThread(threadId: string): unknown;
  taskByThread(botId: string, threadId: string): unknown;
  messagesFor(threadId: string): Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

export type AgentCardResult =
  /** `masked`: something in the widget read as a secret and was stored masked. `leftOut`: a folder page's sentence naming
   * the files it left out. */
  | { ok: true; messageId: string; masked?: true; leftOut?: string }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

const NO_SUCH_WIDGET = "No widget with that id in this conversation.";
const EMPTY_FALLBACK = "[widget]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A room's row names the bot that wrote it. A direct thread's never does: there a bot-authored row carrying `from` is
 * replayed as another bot's line. */
export function speakerIn(store: Pick<AgentCardStore, "groupByThread">, threadId: string, bot: { id: string; name: string; color: MausColor }): Pick<Message, "from"> {
  return store.groupByThread(threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {};
}

/** Every string loses its secrets. Under an action's `payload` and a chart's `data` rows the keys are the bot's, so they are
 * scrubbed too, and a key naming a secret (api_key, db_password) masks its value whatever it looks like. */
function redactValue(value: unknown, botKeys: boolean): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, botKeys));
  if (!isRecord(value)) return value;
  const named = botKeys && typeof value.name === "string" && typeof value.value === "string" && isSecretName(value.name);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
    botKeys ? redactSecretsInText(key) : key,
    botKeys && typeof inner === "string" && (isSecretName(key) || (named && key === "value"))
      ? mask(inner)
      : redactValue(inner, botKeys || key === "payload"),
  ]));
}

/** `type` and `id` stay as written, so a held secret spelling part of one can never rename a node or break a press's ref. */
function redactNode(node: WidgetNode): WidgetNode {
  const out: WidgetNode = { type: node.type, id: node.id };
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "id") continue;
    out[key] = key === "children" && Array.isArray(value)
      ? (value as WidgetNode[]).map(redactNode)
      : redactValue(value, key === "data");
  }
  return out;
}

/** Two labels that held different secrets of one length now read the same, and a press could no longer say which it meant. */
function stillDistinct(root: WidgetRoot): boolean {
  const labels = widgetActions(root).filter((entry) => !entry.client).map((entry) => entry.label);
  const names = widgetFields(root).map((field) => field.name);
  return new Set(labels).size === labels.length && new Set(names).size === names.length;
}

const DEVS_TAP_REFUSAL = "widget: a tap can't tag @devs; only words the person types send a bug report to the MausBot team. Show no button or option for it: ask them in your message to type @devs and what went wrong.";

/** A press is recorded as the person's message, but a tap is never their own @devs tag: a bot asks them to type it instead. */
function offersDevsTap(root: WidgetRoot): boolean {
  if (widgetActions(root).some((entry) => !entry.client && tagsDevs(entry.label))) return true;
  return widgetFields(root).some((field) => widgetFieldOptions(field.node).some((option) => tagsDevs(String(option.label ?? "")) || tagsDevs(String(option.value ?? ""))));
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (isRecord(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : inner));
}

function clip(text: string): string {
  return text.length <= WIDGET_LIMITS.fallback ? text : `${text.slice(0, WIDGET_LIMITS.fallback - 1).trimEnd()}…`;
}

type CanonicalWidget =
  | { ok: true; root: WidgetRoot; text: string; masked: boolean }
  | { ok: false; status: 400; error: string };

/** Scrubbed before clipped: half a key no longer looks like one. */
function canonicalWidget(input: Record<string, unknown>): CanonicalWidget {
  const parsed = parseWidgetInput(input.widget);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const given = input.fallback_text;
  if (given !== undefined && given !== null && typeof given !== "string") {
    return { ok: false, status: 400, error: "fallback_text: must be a string." };
  }
  const root = redactNode(parsed.value);
  if (!stillDistinct(root)) {
    return { ok: false, status: 400, error: "widget: two actions or fields read the same once secrets were removed; give each a plain, distinct label and name." };
  }
  if (offersDevsTap(root)) return { ok: false, status: 400, error: DEVS_TAP_REFUSAL };
  const text = clip(redactSecretsInText(given?.trim() || widgetToText(root)));
  // The bot is told when the scrub changed what it wrote: a payload field it named `key` for an id reads back masked.
  return { ok: true, root, text: text || EMPTY_FALLBACK, masked: stable(root) !== stable(parsed.value) };
}

/** The route has already checked that the conversation is the calling bot's own. */
export interface AgentCardArgs {
  store: AgentCardStore;
  bot: { id: string; name: string; color: MausColor };
  threadId: string;
  input: unknown;
  /** The row a widget call wrote: the calling session made it, so it is never offered back to it as unseen. */
  authored?(messageId: string): void;
  /** The server built this card from records, not the bot. */
  serverCard?: true;
  apps?: Pick<ChatApps, "createAppCard" | "recordMcpAppCall">;
  /** The bot's own folders, for a page shown from a folder. */
  folders?: BotFolders;
}

export type McpAppCardInput = { tool: "mcp_app" } & Record<string, unknown>;

export function createAgentCard(args: AgentCardArgs & { input: McpAppCardInput }): Promise<AgentCardResult>;
export function createAgentCard(args: AgentCardArgs & { folders: BotFolders }): AgentCardResult | Promise<AgentCardResult>;
export function createAgentCard(args: AgentCardArgs): AgentCardResult;
export function createAgentCard(args: AgentCardArgs): AgentCardResult | Promise<AgentCardResult> {
  const { store, bot, threadId, input } = args;
  if (!isRecord(input) || input.tool === undefined) return createOptionsCard(args);
  if (input.tool === "mcp_app") {
    if (!args.apps?.recordMcpAppCall) return Promise.resolve({ ok: false, status: 400, error: "MCP apps are not available on this computer." });
    return args.apps.recordMcpAppCall({ bot, threadId, input, ...(args.authored ? { authored: args.authored } : {}) });
  }
  if (input.tool === "show_html" || input.tool === "update_html") {
    if (!args.apps) return { ok: false, status: 400, error: "Pages are not available on this computer." };
    return args.apps.createAppCard({ bot, threadId, input, ...(args.authored ? { authored: args.authored } : {}), ...(args.folders ? { folders: args.folders } : {}) });
  }
  if (input.tool !== "show_widget" && input.tool !== "update_widget") {
    return { ok: false, status: 400, error: "tool: must be show_widget or update_widget." };
  }

  if (input.tool === "show_widget") {
    const widget = canonicalWidget(input);
    if (!widget.ok) return widget;
    const message = store.appendMessage(threadId, { role: "bot", kind: "widget", text: widget.text, widget: { v: 1, root: widget.root }, ...speakerIn(store, threadId, bot), ...(args.serverCard ? { serverCard: true as const } : {}) });
    args.authored?.(message.id);
    return { ok: true, messageId: message.id, ...(widget.masked ? { masked: true as const } : {}) };
  }

  const existing = store.messagesFor(threadId).find((message) => message.id === input.widget_id);
  // A server-built card keeps `serverCard` through an edit, and that mark is what replay and presses trust; only the server
  // may edit it, and a bot is told nothing more than that the id is missing.
  if (!existing || existing.kind !== "widget" || !existing.widget || (existing.from && existing.from.botId !== bot.id) ||
      (existing.serverCard && !args.serverCard)) {
    return { ok: false, status: 404, error: NO_SUCH_WIDGET };
  }
  if (existing.widget.settled) return { ok: false, status: 409, error: "The person already answered that widget. Show a new one." };
  const widget = canonicalWidget(input);
  if (!widget.ok) return widget;
  // A new tree renumbers its nodes: the revision tells a press on the old one apart.
  const rev = (existing.widget.rev ?? 0) + 1;
  const patched = store.patchMessage(threadId, existing.id, { text: widget.text, widget: { v: 1, root: widget.root, rev } });
  if (!patched) return { ok: false, status: 404, error: NO_SUCH_WIDGET };
  args.authored?.(patched.id);
  return { ok: true, messageId: patched.id, ...(widget.masked ? { masked: true as const } : {}) };
}

function storedWidget(store: Pick<AgentCardStore, "messagesFor">, threadId: string, messageId: string): WidgetPayload | undefined {
  return store.messagesFor(threadId).find((message) => message.id === messageId && message.kind === "widget")?.widget;
}

export type WidgetPress =
  | {
      ok: true;
      messageId: string;
      text: string;
      label: string;
      action: WidgetAction;
      /** This press folds the widget (confirm, cancel, submit) and has not yet. */
      settles: boolean;
      /** Call once the message is accepted, with its `queueId` when it was queued. */
      settle(queueId?: string): void;
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** A press on a device-handled action: where the device goes, or a refusal when that conversation is gone or the widget changed. */
export type DevicePress =
  | {
      ok: true;
      messageId: string;
      device: { openThread: { botId: string; threadId: string } | { groupId: string; threadId: string } } | { openUrl: string };
    }
  | { ok: false; status: 404 | 409; error: string };

const BAD_PRESS = "widgetAction must be {messageId, ref, values?, other?, rev?}, with values an object of text and on/off fields and other an object of text.";
const STALE_PRESS = "This widget changed. Check it and press again.";

function isValues(value: unknown): value is Record<string, string | boolean> | undefined | null {
  if (value === undefined || value === null) return true;
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "boolean");
}

function isOther(value: unknown): value is Record<string, string> | undefined | null {
  if (value === undefined || value === null) return true;
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRevision(value: unknown): value is number | undefined | null {
  return value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/** A press on a device-handled action: where the device goes, or a refusal when that conversation is gone. */
function devicePress(
  store: Pick<AgentCardStore, "groupByThread" | "taskByThread">,
  messageId: string,
  entry: WidgetActionEntry,
): DevicePress | undefined {
  if (entry.action.type === "open_thread") {
    const target = threadActionTarget(entry.action);
    if (!target) return undefined;
    let open: { botId: string; threadId: string } | { groupId: string; threadId: string } | undefined;
    if (target.groupId !== undefined) {
      const group = store.groupByThread(target.threadId) as { id: string } | undefined;
      if (group?.id === target.groupId) open = { groupId: target.groupId, threadId: target.threadId };
    } else if (target.botId !== undefined && store.taskByThread(target.botId, target.threadId)) {
      open = { botId: target.botId, threadId: target.threadId };
    }
    return open
      ? { ok: true, messageId, device: { openThread: open } }
      : { ok: false, status: 404, error: "That conversation is no longer here." };
  }
  if (entry.action.type === "open_url") {
    const url = urlActionTarget(entry.action);
    return url ? { ok: true, messageId, device: { openUrl: url } } : undefined;
  }
  return undefined;
}

/** A press on a device-handled action: where the device goes, or a refusal when that conversation is gone or the widget changed.
 * Returns undefined when the press is not a device-handled action, so the caller answers it as a press that sends. */
export function prepareDevicePress(
  store: Pick<AgentCardStore, "groupByThread" | "messagesFor" | "taskByThread">,
  threadId: string,
  widgetAction: unknown,
  sendId: string | undefined,
): DevicePress | undefined {
  if (!isRecord(widgetAction)) return undefined;
  const { messageId, ref, rev } = widgetAction;
  if (typeof messageId !== "string" || typeof ref !== "string" || !isRevision(rev)) return undefined;
  const payload = storedWidget(store, threadId, messageId);
  if (!payload?.root) return undefined;
  const client = clientWidgetAction(payload, ref);
  if (!client) return undefined;
  const retry = sendId !== undefined && payload.settled?.sendId === sendId;
  if (!retry && !payload.settled && (rev ?? 0) !== (payload.rev ?? 0)) return { ok: false, status: 409, error: STALE_PRESS };
  return devicePress(store, messageId, client);
}

/** Writes nothing until `settle()`. A press on an older `rev` is refused (its ref may now be another button); a retry with
 * the settling press's `sendId` resolves as if still live, and its `settle()` does nothing. */
export function prepareWidgetPress(
  store: Pick<AgentCardStore, "messagesFor" | "patchMessage">,
  threadId: string,
  widgetAction: unknown,
  sendId: string | undefined,
): WidgetPress {
  if (!isRecord(widgetAction)) return { ok: false, status: 400, error: BAD_PRESS };
  const { messageId, ref, values, other, rev } = widgetAction;
  if (typeof messageId !== "string" || !/^[\w-]+$/.test(messageId) ||
      typeof ref !== "string" || ref.length < 1 || ref.length > 64 || !isValues(values) || !isOther(other) || !isRevision(rev)) {
    return { ok: false, status: 400, error: BAD_PRESS };
  }
  const stored = () => storedWidget(store, threadId, messageId);
  const payload = stored();
  if (!payload?.root) return { ok: false, status: 404, error: "That widget is not in this conversation." };
  const retry = sendId !== undefined && payload.settled?.sendId === sendId;
  if (!retry && !payload.settled && (rev ?? 0) !== (payload.rev ?? 0)) return { ok: false, status: 409, error: STALE_PRESS };
  const resolved = resolveWidgetAction(retry ? { v: 1, root: payload.root } : payload, ref, values ?? undefined, other ?? undefined);
  if (!resolved.ok) return resolved;
  const { label, action, tone } = resolved;
  const sent = { ...(Object.keys(resolved.values).length > 0 ? { values: resolved.values } : {}), ...(resolved.other ? { other: resolved.other } : {}) };
  return {
    ok: true,
    messageId,
    text: resolved.text,
    label,
    action,
    settles: Boolean(tone) && !retry,
    settle: (queueId) => {
      // Read again: two requests for one press can both get here, and the bot may have replaced the tree meanwhile.
      const current = stored();
      if (retry || !tone || !current || current.settled) return;
      const settled: WidgetSettled = { ref, label, tone, at: Date.now(), ...(sendId ? { sendId } : {}), ...sent, ...(queueId ? { queueId } : {}) };
      store.patchMessage(threadId, messageId, { widget: { ...current, settled } });
    },
  };
}

/** A cancelled queued press never reached the bot, so the widget is live again. */
export function reopenCancelledPress(store: Pick<AgentCardStore, "messagesFor" | "patchMessage">, threadId: string, queueId: string): void {
  const waiting = store.messagesFor(threadId).filter((message) =>
    message.kind === "widget" && message.widget?.settled?.queueId === queueId);
  for (const message of waiting) {
    const { settled: _settled, ...live } = message.widget!;
    store.patchMessage(threadId, message.id, { widget: live });
  }
}
