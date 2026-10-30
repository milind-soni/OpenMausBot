// The setup card under a new bot's greeting: "What should I help you with first?" with a few answers. Picking one
// marks the conversation and sends its words, which run exactly as `/setup <words>` would (server/setup-mode.ts) while
// the chat shows the words. "Something else" is answered here, with no model: the bot's own line, and the
// conversation marked as waiting (on its task, so a reload or another device sees it); the person's next line there
// then runs as setup. Anything else the person writes runs as typed, and the card settles. Setup stays explicit: only
// a pick, the line after Something else, or a typed /setup ever starts it.
import { dataContextPrompt } from "../shared/data-context.ts";
import type { ResolvedSender } from "../shared/wire.ts";
import { linePersonKey } from "./host/thread-person.ts";
import { setupRequestLine } from "./initial-greeting.ts";
import type { RequestAuth } from "./request-auth.ts";
import { parseSetupCommand } from "./setup-mode.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { extractTurnImages } from "./turn-images.ts";

export type SetupRequestStore = Pick<Store, "bots" | "bot" | "taskByThread" | "messagesFor" | "patchMessage" | "appendMessage" | "patchTask">;

/** No role or instructions yet: what the New bot form calls Description and Instructions are empty. */
export function blankBot(bot: Pick<BotRecord, "soul" | "description">): boolean {
  return !bot.soul?.trim() && !bot.description?.trim();
}

/** The greeting whose setup card is open in this conversation: its first line, while the bot is blank and nothing has
 * been written there yet, by anyone. */
export function openSetupOffer(store: SetupRequestStore, botId: string, threadId: string): Message | null {
  const bot = store.bot(botId);
  if (!bot || !blankBot(bot) || !store.taskByThread(botId, threadId)) return null;
  const thread = store.messagesFor(threadId);
  const greeting = thread[0];
  if (thread.some((message) => message.role === "user")) return null;
  return greeting?.setupOffer === true && greeting.role === "bot" ? greeting : null;
}

export type SetupAsk =
  | { ok: true; message: Message }
  | { ok: true; already: true }
  | { ok: true; picked: true }
  | { ok: false; status: 404 | 409; error: string };

const HAS_INSTRUCTIONS = "This bot already has instructions. To change its job, type /setup and what you'd like it to do.";
const STARTED = "This chat has already started. Type /setup and what you'd like this bot to do.";
const SOMEONE_ELSE = "Someone else is setting this bot up.";

/** Who presses, recorded only where several people share the place, and only for a signed-in person whose lines carry
 * them as their sender (`sender`, as the send route stores it): anyone else could never take their own mark. */
export function setupPresser(shared: boolean, auth: RequestAuth, sender: ResolvedSender | undefined): string | undefined {
  return shared && auth.kind === "session" ? sender?.id : undefined;
}

/** The press. A second press by the same person while the conversation waits changes nothing, so a double click says
 * the line once; anyone else's is refused. `by`: who pressed (setupPresser); only their next line takes the mark.
 * `picked`: a choice on the card, whose words the caller sends next, so the bot's own line is not said. */
export function askForSetup(store: SetupRequestStore, botId: string, threadId: string, language: string | undefined, by?: string,
  picked = false): SetupAsk {
  const bot = store.bot(botId);
  const task = bot ? store.taskByThread(botId, threadId) : null;
  if (!bot || !task) return { ok: false, status: 404, error: "There is no such conversation." };
  if (task.setupRequest) {
    return task.setupRequest.by && task.setupRequest.by !== by ? { ok: false, status: 409, error: SOMEONE_ELSE } : { ok: true, already: true };
  }
  const offer = openSetupOffer(store, botId, threadId);
  if (!offer) return { ok: false, status: 409, error: blankBot(bot) ? STARTED : HAS_INSTRUCTIONS };
  if (picked) {
    store.patchTask(botId, threadId, { setupRequest: { at: Date.now(), ...(by ? { by } : {}) } });
    return { ok: true, picked: true };
  }
  const message = store.appendMessage(threadId, { role: "bot", kind: "text", text: setupRequestLine(language) });
  store.patchTask(botId, threadId, { setupRequest: { at: message.at, ...(by ? { by } : {}) } });
  return { ok: true, message };
}

/** The x on the chip or on the card: the conversation stops waiting and the card closes, so lines run as typed. Where
 * a presser is recorded, only they or an owner or admin may. */
export function cancelSetupRequest(store: SetupRequestStore, botId: string, threadId: string, by?: string,
  options: { admin?: boolean } = {}): "cleared" | "refused" | "unknown" {
  const task = store.bot(botId) ? store.taskByThread(botId, threadId) : null;
  if (!task) return "unknown";
  if (task.setupRequest?.by && task.setupRequest.by !== by && !options.admin) return "refused";
  if (task.setupRequest) store.patchTask(botId, threadId, { setupRequest: undefined });
  const greeting = store.messagesFor(threadId)[0];
  if (greeting?.setupOffer) store.patchMessage(threadId, greeting.id, { setupOffer: undefined });
  return "cleared";
}

/** A person left the team: every request they pressed stops waiting. How many. */
export function forgetSetupPresser(store: SetupRequestStore, person: string): number {
  let dropped = 0;
  for (const bot of store.bots) {
    for (const task of bot.tasks ?? []) {
      if (task.setupRequest?.by !== person) continue;
      store.patchTask(bot.id, task.threadId, { setupRequest: undefined });
      dropped++;
    }
  }
  return dropped;
}

export interface SetupTurn {
  botId: string;
  threadId: string;
  /** The stored line this turn answers. */
  line: Message;
  /** The person wrote it here: not a routine, another bot, a card, a coordination or an edit. */
  person: boolean;
  /** The line an edit replaced. */
  editedFrom?: string;
  /** The bot's model can set itself up (its tools are mounted); without them the line runs as typed. */
  mounted: boolean;
}

const command = (line: Message): boolean => (line.text ?? "").trimStart().startsWith("/");

/** The stored line, marked, when this turn is a setup request; null when it runs as typed. Called by startTurn once the
 * line is stored, which keeps the returned copy: a retry on the backup AI, a computer pick or an edit of it then stays
 * a setup request. */
export function takeSetupRequest(store: SetupRequestStore, turn: SetupTurn): Message | null {
  const { botId, threadId, line } = turn;
  if (line.role !== "user" || line.peerAsk) return null;
  if (line.setupRequest) return turn.mounted ? line : null;
  const edited = turn.editedFrom ? store.messagesFor(threadId).find((message) => message.id === turn.editedFrom) : undefined;
  if (edited?.setupRequest) {
    // Someone else's edit of the presser's line (a Team Cloud stores both senders) runs as typed.
    const author = linePersonKey(edited), editor = linePersonKey(line);
    return command(line) || (author && editor && author !== editor) ? null : mark(store, threadId, line, turn.mounted);
  }
  if (!turn.person || line.relayed) return null;
  const waiting = store.taskByThread(botId, threadId)?.setupRequest;
  if (!waiting) return null;
  // Someone else in a shared place: their line runs as typed and the presser's request keeps waiting.
  if (waiting.by && linePersonKey(line) !== waiting.by) return null;
  store.patchTask(botId, threadId, { setupRequest: undefined });
  // A command typed instead (/learn, a skill, or /setup itself) runs as typed; so does any line once the bot has been
  // given instructions some other way.
  const bot = store.bot(botId);
  if (command(line) || !bot || !blankBot(bot)) return null;
  return mark(store, threadId, line, turn.mounted);
}

function mark(store: SetupRequestStore, threadId: string, line: Message, mounted: boolean): Message | null {
  if (!mounted) return null;
  return store.patchMessage(threadId, line.id, { setupRequest: true }) ?? { ...line, setupRequest: true };
}

/** The person's words as a typed /setup. */
export function setupCommandText(text: string): string {
  return parseSetupCommand(text) ? text : `/setup ${text}`;
}

/** What the bot reads for a setup request, from the stored line, so a direct send, a queued one, a retry and an edit
 * read alike: its words as a typed /setup (the command must come first to be read as one), then what the person was
 * looking at in the Data tab. `nativeImages`: the AI takes the line's pictures as images, not as their tags. */
export function setupTurnText(line: Message, nativeImages: boolean): string {
  const words = nativeImages ? extractTurnImages(line.text ?? "").text : line.text ?? "";
  const request = setupCommandText(words);
  return line.dataContext ? `${request}\n\n${dataContextPrompt(line.dataContext)}` : request;
}
