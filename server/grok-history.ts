import type { GrokHistoryAnswer } from "../shared/grok-import.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { readGrokChat } from "./grok-local.ts";
import type { SetupMachine } from "./setup-import.ts";
import type { Message, Store } from "./store.ts";

export const GROK_HISTORY_TITLE = "Chat from Grok Bot";
export type GrokHistoryStore = Pick<Store, "bot" | "createTask" | "importTranscript" | "messagesFor">;

type Entry = Record<string, unknown>;
type Line = { role: Message["role"]; text: string };

const words = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const record = (value: unknown): Entry => (value && typeof value === "object" && !Array.isArray(value) ? value as Entry : {});
const list = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
const lines = (...parts: string[]) => parts.filter(Boolean).join("\n");

function widget(message: Entry, entry: Entry): string {
  const { prompt, options } = record(message.widget);
  const choices = list(options);
  const picked = choices.find((option) => option.value === entry.respondedValue)?.label ?? entry.respondedValue;
  return lines(words(prompt), choices.length ? `Choices: ${choices.map((option) => words(option.label)).filter(Boolean).join(", ")}` : "",
    words(picked) ? `Answer: ${words(picked)}` : entry.widgetSkipped === true ? "Skipped" : "");
}

/** What the Bot sent, by the type Grok Bot gives it. A card becomes a line saying what it was. */
const BOT_SENT = new Map<string, (message: Entry, entry: Entry) => string>([
  ["text", (message) => {
    const images = list(message.images).length;
    return lines(words(message.content), images === 1 ? "Sent 1 image" : images > 1 ? `Sent ${images} images` : "");
  }],
  ["widget", widget],
  ["bot-template-share", (message) => words(message.name) && [`Shared the Bot template "${words(message.name)}"`, words(message.shareUrl)].filter(Boolean).join(": ")],
  ["connector", (message) => words(message.connector) && `Asked to connect ${words(message.connector)}`],
]);

/** Each kind of entry in a Grok Bot chat; a kind or type not here is left out. */
const ENTRY = new Map<string, (entry: Entry) => Line | null>([
  ["message", (entry) => {
    if (entry.role !== "user" && entry.role !== "assistant") return null;
    const from = words(record(entry.fromAgent).name), to = words(record(entry.toAgent).name), text = words(entry.content);
    return { role: entry.role === "user" ? "user" : "bot", text: text && (from ? `${from}:\n${text}` : to ? `To ${to}:\n${text}` : text) };
  }],
  ["send-message", (entry) => {
    const message = record(entry.message);
    const sent = BOT_SENT.get(words(message.type));
    return sent ? { role: "bot", text: sent(message, entry) } : null;
  }],
  ["event", (entry) => {
    const { type, automationName, action } = record(entry.event);
    return type === "automation-changed" && words(automationName) ? { role: "bot", text: `Routine "${words(automationName)}" ${words(action)}`.trim() } : null;
  }],
]);

/** A Grok Bot chat slice's entries, read as untrusted, as one linear conversation in Grok Bot's order and times. */
export function grokChatMessages(entries: readonly unknown[]): Message[] {
  const ordered = entries.map(record)
    .filter((entry) => Number.isSafeInteger(entry.seq) && Number.isFinite(entry.timestampMs))
    .sort((a, b) => (a.seq as number) - (b.seq as number));
  const messages: Message[] = [];
  for (const [index, entry] of ordered.entries()) {
    if (index > 0 && entry.seq === ordered[index - 1]!.seq) continue;
    const line = ENTRY.get(words(entry.kind))?.(entry);
    const text = line && redactSecretsInText(line.text);
    if (!line || !text) continue;
    messages.push({ id: `grok-${entry.seq as number}`, kind: "text", role: line.role, text, at: entry.timestampMs as number, parentId: messages.at(-1)?.id ?? null });
  }
  return messages;
}

/** Brings a moved Bot's chat into one new thread on `botId`, as a record only: nothing runs, replies or notifies. Asked
 * again, it finds that thread and adds nothing. Null when there is no such bot. */
export function importGrokHistory(store: GrokHistoryStore, machine: SetupMachine, botId: string, grokName: string): GrokHistoryAnswer | null {
  const bot = store.bot(botId);
  if (!bot) return null;
  const earlier = bot.tasks?.find((task) => task.title === GROK_HISTORY_TITLE);
  const kept = earlier ? store.messagesFor(earlier.threadId).length : 0;
  if (kept) return { messages: kept };
  const chat = readGrokChat(machine, grokName);
  if ("reason" in chat) return chat;
  const messages = grokChatMessages(chat.entries);
  if (!messages.length) return { reason: "empty" };
  const task = earlier ?? store.createTask(botId, GROK_HISTORY_TITLE);
  if (!task) return null;
  store.importTranscript(task.threadId, messages, messages.at(-1)!.id);
  return { messages: messages.length };
}
