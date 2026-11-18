// Security invariant: a lock on the lent computer is lifted only by the owner's own answer on a card the harness wrote,
// raised only for a turn answering the owner's own line. A webhook's or a routine's run never raises one and never
// benefits from one. Nothing a bot says or writes can answer it, and what it allows is what the card showed.
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { CARRY_ON_MS } from "../computer-asks.ts";
import type { DecisionRow } from "../decision-log.ts";
import { readMemoryJournal } from "../memory-journal.ts";
import { hashMemoryText } from "../memory-store.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { redactSecretsInText } from "../redact.ts";
import { serverLine } from "../server-lines.ts";
import type { Message, Store } from "../store.ts";
import { turnWaitedOnPerson } from "../waiting-on-person.ts";
import { workspaceDir } from "../workspace.ts";

const TOOL = "lending_lift";
/** The request of a card for a whole bot's memory, which no line of a conversation asked for. */
const WHOLE_BOT = "whole-bot-memory";
/** A card shows what it allows; past this it says where the rest is. */
const SHOWN_CHARS = 2_000;
const CARRY_ON_EVERY_MS = 5_000;

const WORDS_CHARS = 400;
/** Where a bot's own and its conversations' folders are: true, and no help to the person reading. */
const BOT_FOLDER = /^.*[\\/](?:workspaces[\\/][^\\/]+|task-workspaces[\\/][^\\/]+[\\/][^\\/]+)[\\/]/u;

type Lift = NonNullable<NonNullable<Message["card"]>["lendingLift"]>;

/** What a changed file says now, for the card: the lines a memory file's last change added, or the file itself. */
export function changedWords(botId: string, file: string): string | undefined {
  const clip = (text: string) => { const trimmed = text.trim(); return trimmed.length > WORDS_CHARS ? `${trimmed.slice(0, WORDS_CHARS)}…` : trimmed; };
  const path = isAbsolute(file) ? file : join(workspaceDir(botId), file);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `→ ${readlinkSync(path)}`;
    if (!stat.isFile()) return undefined;
    const text = readFileSync(path, "utf8");
    const row = isAbsolute(file) ? undefined : readMemoryJournal(botId, 50).find((entry) => entry.path === file);
    // Only while it describes what's there now: anything written since would go unshown.
    const added = row?.afterHash && row.afterHash === hashMemoryText(text) ? row.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n") : "";
    return clip(added || text);
  } catch {
    return undefined;
  }
}

/** Work a bot handed into this conversation that was made, or run, after `since`. The conversation's own turns are roots
 * and what they hand on goes to other conversations, so neither counts. */
export function handedInSince(nodes: Iterable<{ id: string; rootId: string; threadId: string; createdAt: number; startedAt?: number }>, threadId: string, since: number): boolean {
  for (const node of nodes) if (node.threadId === threadId && node.id !== node.rootId && (node.createdAt > since || (node.startedAt ?? 0) > since)) return true;
  return false;
}

export interface LendingLiftDeps {
  store: Pick<Store, "appendMessage" | "messagesFor" | "patchMessage" | "activePath" | "bot" | "botByThread" | "groupByThread" | "projectBotForTask" | "setTaskActivity" | "taskByThread">;
  /** The bot's memory review (server/lending-memory.ts): what changed, under the token that accepts exactly that. */
  memory: { info(botId: string): { token: string; changed: string[] }; accept(botId: string, token: string): boolean };
  /** What a changed file now says, for the card; undefined when there's nothing to show. */
  words(botId: string, file: string): string | undefined;
  /** The answer being given comes from one of the owner's own devices, never a process on this machine. */
  ownersAnswer(card: NonNullable<Message["card"]>): boolean;
  /** The person stopped this conversation's work: nothing goes on by itself after that. */
  stopped(threadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  queued(botId: string, threadId: string): boolean;
  continueRequest(botId: string, text: string, opts: { threadId: string; cardContinuation: true; requestMessageId: string }): Promise<unknown>;
  language(threadId: string): string | undefined;
  /** What to call the lent computer. */
  device(): string;
  notify(notification: Notification | null): void;
  decide(row: Omit<DecisionRow, "at">): void;
  setTimer?: typeof setTimeout;
  now?: () => number;
}

export function createLendingLifts(deps: LendingLiftDeps) {
  const { store } = deps;
  const setTimer = deps.setTimer ?? setTimeout, now = deps.now ?? Date.now;
  const cards = (threadId: string, requestMessageId: string) => store.messagesFor(threadId).filter((line) => line.card?.lendingLift?.requestMessageId === requestMessageId);
  /** Still waiting on the person: not answered, and not settled by the harness (expired, stopped, dismissed). */
  const open = (card: NonNullable<Message["card"]>) => !card.answered && !card.expired && !card.stopped && !card.dismissed;
  /** Allowed by the owner, read from the card as it is now, never trusted from how it got there. */
  const allowedByOwner = (card: NonNullable<Message["card"]>) => card.answered === "allow" && !card.dismissed && !card.expired && deps.ownersAnswer(card);

  function subtitle(threadId: string, botId: string, memory: { changed: readonly string[] } | null, outside: boolean, botOpened = false): string {
    const language = deps.language(threadId);
    const parts: string[] = [];
    if (memory) {
      parts.push(serverLine(language, "server.lendingLift.memory"));
      // A skill's folder says nothing its SKILL.md doesn't. Either separator: the names come from the Cloud's own paths.
      const skillFolders = new Set(memory.changed.flatMap((file) => /[\\/]SKILL\.md$/u.test(file) ? [file.slice(0, -"/SKILL.md".length)] : []));
      for (const file of memory.changed) {
        if (skillFolders.has(file)) continue;
        const words = deps.words(botId, file);
        parts.push(`- ${file.replace(BOT_FOLDER, "")}`, ...(words ? [redactSecretsInText(words)] : []));
      }
    }
    if (outside) parts.push(serverLine(language, botOpened ? "server.lendingLift.botOpened" : "server.lendingLift.outside", { device: deps.device() }));
    const whole = parts.join("\n");
    return whole.length <= SHOWN_CHARS ? whole : `${whole.slice(0, SHOWN_CHARS)}…\n${serverLine(language, "server.lendingLift.more")}`;
  }

  function carryOn(botId: string, threadId: string, requestMessageId: string, since: number): void {
    if (!store.taskByThread(botId, threadId) || deps.stopped(threadId)) return;
    // Someone wrote since: they lead now.
    if (store.activePath(threadId).findLast((message) => message.role === "user" && message.kind === "text")?.id !== requestMessageId) return;
    if (deps.threadBusy(botId, threadId) || deps.queued(botId, threadId)) {
      if (now() - since >= CARRY_ON_MS) return;
      (setTimer(() => carryOn(botId, threadId, requestMessageId, since), CARRY_ON_EVERY_MS) as { unref?: () => void }).unref?.();
      return;
    }
    const text = "[They allowed it on the card.] Carry on with their request where you left off: list_shared_computers gives its computer_id for shared_computer. Verify the result before saying it's done.";
    void deps.continueRequest(botId, text, { threadId, cardContinuation: true, requestMessageId }).catch((error: unknown) => {
      console.warn(`lending lift: the request could not go on: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    /** The one card for this line of the owner's. "declined": they said Not now to it, so nothing is asked again until their next line. */
    raise(input: { botId: string; threadId: string; requestMessageId: string; memoryChanged: boolean; outside: boolean; botOpened?: boolean }): "open" | "declined" {
      const { botId, threadId, requestMessageId, memoryChanged, outside } = input;
      const botOpened = outside && input.botOpened === true;
      const bot = store.bot(botId);
      const memory = memoryChanged ? deps.memory.info(botId) : null;
      const lift: Lift = { requestMessageId, ...(memory ? { memoryToken: memory.token } : {}), ...(outside ? { outside: true as const } : {}), ...(botOpened ? { botOpened: true as const } : {}) };
      const last = cards(threadId, requestMessageId).at(-1);
      if (last?.card && open(last.card)) {
        // What it allows is what it shows: keep both current while it waits.
        if (last.card.lendingLift?.memoryToken !== lift.memoryToken || last.card.lendingLift?.outside !== lift.outside || last.card.lendingLift?.botOpened !== lift.botOpened) {
          store.patchMessage(threadId, last.id, { card: { ...last.card, subtitle: subtitle(threadId, botId, memory, outside, botOpened), lendingLift: lift } });
        }
        return "open";
      }
      // A line's Not now holds for that line; a bot's holds until its memory changes again.
      if (last?.card?.answered === "deny" && (requestMessageId !== WHOLE_BOT || last.card.lendingLift?.memoryToken === lift.memoryToken)) return "declined";
      const language = deps.language(threadId);
      const room = store.groupByThread(threadId);
      const title = serverLine(language, requestMessageId === WHOLE_BOT ? "server.lendingLift.wholeBotTitle" : "server.lendingLift.title", { bot: bot?.name ?? "", device: deps.device() });
      const requestId = `lending-lift-${randomUUID()}`;
      store.appendMessage(threadId, {
        role: "bot", kind: "options",
        ...(room && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
        card: { title, subtitle: subtitle(threadId, botId, memory, outside, botOpened), options: [serverLine(language, "server.lendingLift.allow"), serverLine(language, "server.lendingLift.notNow")], requestId, requestType: "permission", tool: TOOL, lendingLift: lift },
      });
      deps.decide({ threadId, requestId, botId, botName: bot?.name, tool: TOOL, summary: title, decision: "card-shown", source: "question" });
      if (store.projectBotForTask(botId, threadId)?.busy) store.setTaskActivity(botId, threadId, "waiting-on-you");
      if (bot) deps.notify(buildNotification("approval", bot, threadId, title));
      return "open";
    },

    /** Security invariant: a bot's memory just became locked. The card goes to its own main chat, for the owner alone to
     * answer from one of their devices, and shows exactly what it would allow, like any other. */
    memoryLocked(botId: string): void {
      const bot = store.bot(botId);
      if (!bot?.threadId) return;
      this.raise({ botId, threadId: bot.threadId, requestMessageId: WHOLE_BOT, memoryChanged: true, outside: false });
    },

    /** They said Not now to this line of theirs. */
    declined(threadId: string, requestMessageId: string): boolean {
      return cards(threadId, requestMessageId).at(-1)?.card?.answered === "deny";
    },

    /** Where in this conversation, and when, the owner let this line of theirs through what came in from outside; null if they haven't. */
    outsideAllowed(threadId: string, requestMessageId: string | undefined): { index: number; at: number } | null {
      if (!requestMessageId) return null;
      const lines = store.messagesFor(threadId);
      const index = lines.findLastIndex((line) => line.card?.lendingLift?.requestMessageId === requestMessageId && line.card.lendingLift.outside === true && allowedByOwner(line.card));
      const at = index < 0 ? undefined : lines[index]!.card!.lendingLift!.allowedAt;
      return index < 0 || typeof at !== "number" ? null : { index, at };
    },

    /** The person's answer; null when the request is not one of these cards. */
    resolve(threadId: string, requestId: string, behavior: string): { status: number; body: Record<string, unknown> } | null {
      const message = store.messagesFor(threadId).find((line) => line.card?.requestId === requestId && line.card.lendingLift);
      const card = message?.card, lift = card?.lendingLift;
      if (!message || !card || !lift) return null;
      if (!open(card)) return { status: 200, body: { ok: true, outcome: card.answered === "allow" ? "allowed-once" : card.answered === "deny" ? "rejected" : "unavailable", alreadySettled: true } };
      if (behavior !== "allow" && behavior !== "deny") return { status: 400, body: { error: serverLine(deps.language(threadId), "server.lendingLift.chooseAnswer") } };
      if (!deps.ownersAnswer(card)) return { status: 403, body: { error: serverLine(deps.language(threadId), "server.lendingLift.ownerDeviceOnly") } };
      const botId = message.from?.botId ?? store.botByThread(threadId)?.id ?? "";
      const bot = store.bot(botId);
      const allowed = behavior === "allow";
      if (allowed && lift.memoryToken && !deps.memory.accept(botId, lift.memoryToken)) {
        // It changed again after the card was shown: show what's there now, and let them decide on that.
        const memory = deps.memory.info(botId);
        store.patchMessage(threadId, message.id, { card: { ...card, subtitle: subtitle(threadId, botId, memory, lift.outside === true, lift.botOpened === true), lendingLift: { ...lift, memoryToken: memory.token } } });
        return { status: 200, body: { ok: true, outcome: "changed-again" } };
      }
      // When they allowed it: work handed in after this shuts it again.
      store.patchMessage(threadId, message.id, { card: { ...card, answered: allowed ? "allow" : "deny", ...(allowed ? { lendingLift: { ...lift, allowedAt: now() } } : {}) } });
      deps.decide({ threadId, requestId, botId, botName: bot?.name, tool: TOOL, summary: card.title, decision: allowed ? "user-approved" : "user-denied", source: "user" });
      if (turnWaitedOnPerson(store.taskByThread(botId, threadId))) store.setTaskActivity(botId, threadId, "working");
      if (allowed && store.groupByThread(threadId)) {
        store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: serverLine(deps.language(threadId), "server.lendingLift.askAgain"), ok: true } });
      } else if (allowed) carryOn(botId, threadId, lift.requestMessageId, now());
      return { status: 200, body: { ok: true, outcome: allowed ? "allowed-once" : "rejected" } };
    },
  };
}
