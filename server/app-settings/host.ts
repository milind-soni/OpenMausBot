// The app_settings tool for one turn: find, get and set over the registry, where the entry's tier is the whole policy.
// Writes happen only in the owner's own turn, a confirm setting always waits on a card the owner answers (Full access
// never skips it), a secret never passes through the bot, and an owner-only setting is only explained.
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { AppSettingRequest } from "../../shared/app-settings.ts";
import type { Notification } from "../../shared/notification.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import { json } from "../harness/http.ts";
import { buildNotification } from "../notify.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { turnWaitedOnPerson } from "../waiting-on-person.ts";
import { display, findSettings, type SettingEntry, type WritableEntry } from "./registry.ts";

export const TOOL = "app_settings";
export const APP_SETTINGS_HOLD_MS = 9 * 60_000;
export const WRITE_BUDGET = 10;
const FIND_LIMIT = 8;
const NOT_RETRY = "Do not retry it; ask the user what they would like instead.";
const NOT_SET = "not set";
const text = (value: string) => value || NOT_SET;

export interface Turn {
  botId: string;
  threadId: string;
  generation: string;
}

type Outcome = { kind: "applied"; text: string } | { kind: "failed"; error: string } | { kind: "denied" } | { kind: "timeout" };
interface Held {
  botId: string;
  threadId: string;
  entry: WritableEntry;
  value: unknown;
  before: string;
  earlier: unknown;
  settle(outcome: Outcome): void;
  timer: ReturnType<typeof setTimeout>;
  answered?: true;
}
/** `before`: the typed value read before the write; `after`: what it read as once applied, so Undo can tell it changed since. */
interface Undoable {
  entry: WritableEntry;
  before: unknown;
  after: string;
}

export type UndoResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

export interface AppSettingsDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage" | "setActivity" | "setTaskActivity" | "taskByThread">;
  dataDir: string;
  entries: readonly SettingEntry[];
  holdMs?: number;
  /** Non-null when the turn is the owner's own (phones.turnOwner). */
  turnOwner(turn: Turn): string | null;
  guestDriven(threadId: string): boolean;
  /** The secret card, as request_credential posts it. */
  requestCredential(bot: BotRecord, threadId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  connectorThread(botId: string, threadId: string): { group?: GroupRecord } | null;
  activeGroupTurnForBot(botId: string): { threadId: string } | null;
  notify(notification: Notification | null): void;
  language(threadId: string): string | undefined;
}

export function createAppSettings(deps: AppSettingsDeps) {
  const { store, entries } = deps;
  const holdMs = deps.holdMs ?? APP_SETTINGS_HOLD_MS;
  const held = new Map<string, Held>();
  const openByBot = new Map<string, string>();
  const undoable = new Map<string, Undoable>();
  const writes = new Map<string, number>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const reply = (status: number, body: Record<string, unknown>) => ({ status, body });
  const refuse = (status: number, error: string) => reply(status, { error });
  const describe = (entry: SettingEntry) => ({ id: entry.id, label: entry.label, tier: entry.tier, value: text(entry.read()), where: entry.where });
  const decide = (turn: Turn, bot: BotRecord | undefined, entry: SettingEntry, summary: string, decision: "auto-approved" | "card-shown", requestId?: string) =>
    appendDecision(deps.dataDir, { threadId: turn.threadId, ...(requestId ? { requestId } : {}), botId: turn.botId, botName: bot?.name, tool: TOOL, summary: `${entry.id}: ${summary}`, decision, source: "app-settings" });
  const from = (bot: BotRecord, threadId: string) => (deps.connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {});
  const card = (bot: BotRecord, threadId: string, entry: WritableEntry, before: string, after: string, requestId: string, options: string[], settled: Partial<OptionCardData>) => {
    const language = deps.language(threadId);
    const shown = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    const appSettingRequest: AppSettingRequest = { settingId: entry.id, label: entry.label, before, after, tier: entry.tier };
    return store.appendMessage(threadId, {
      role: "bot", kind: "options", ...from(bot, threadId),
      card: { title: serverLine(language, "server.appSettings.change", { label: entry.label }), subtitle: `${shown(before)} → ${shown(after)}`, options, requestId, tool: TOOL, fixedOptions: true, appSettingRequest, ...settled },
    });
  };
  const spendWrite = (turn: Turn): string | null => {
    const spent = writes.get(turn.generation) ?? 0;
    if (spent >= WRITE_BUDGET) return `This turn has already changed ${WRITE_BUDGET} settings. Ask the user to send a new message before changing more.`;
    writes.set(turn.generation, spent + 1);
    if (writes.size > 200) writes.delete(writes.keys().next().value!);
    return null;
  };

  async function apply(entry: WritableEntry, value: unknown, before: string): Promise<Outcome> {
    const refusal = await entry.write(value);
    if (refusal) return { kind: "failed", error: refusal };
    return { kind: "applied", text: `Changed ${entry.label} from ${text(before)} to ${text(entry.read())}.` };
  }

  async function setSafe(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, before: string) {
    const earlier = entry.current();
    const outcome = await apply(entry, value, before);
    if (outcome.kind !== "applied") return refuse(409, outcome.kind === "failed" ? outcome.error : "The change was not applied.");
    const after = entry.read();
    const requestId = randomUUID();
    card(bot, turn.threadId, entry, before, after, requestId, [], { answered: "allow", dismissed: true, autoApplied: true });
    undoable.set(requestId, { entry, before: earlier, after });
    decide(turn, bot, entry, `${text(before)} → ${text(after)}`, "auto-approved", requestId);
    return reply(200, { text: `${outcome.text} The user can undo it from the card in the conversation.` });
  }

  async function setConfirm(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, before: string) {
    if (openByBot.has(bot.id)) return refuse(409, "A settings change is already waiting on the user. End your turn and wait for the answer.");
    const requestId = randomUUID();
    const after = display(value);
    let settle!: (outcome: Outcome) => void;
    const answer = new Promise<Outcome>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => settleHold(requestId, { kind: "timeout" }), holdMs);
    timer.unref?.();
    held.set(requestId, { botId: bot.id, threadId: turn.threadId, entry, value, before, earlier: entry.current(), settle, timer });
    openByBot.set(bot.id, requestId);
    const message = card(bot, turn.threadId, entry, before, after, requestId, ["Change", "Cancel"], {});
    decide(turn, bot, entry, `${text(before)} → ${text(after)}`, "card-shown", requestId);
    waiting(bot, turn.threadId, true);
    deps.notify(buildNotification("approval", bot, turn.threadId, message.card!.subtitle, { avatarUrl: bot.avatarUrl }));
    const outcome = await answer;
    held.delete(requestId);
    if (openByBot.get(bot.id) === requestId) openByBot.delete(bot.id);
    waiting(bot, turn.threadId, false);
    if (outcome.kind === "timeout") {
      const stale = store.messagesFor(turn.threadId).find((candidate) => candidate.id === message.id);
      if (stale?.card && !stale.card.answered) store.patchMessage(turn.threadId, stale.id, { card: { ...stale.card, answered: "unavailable", dismissed: true } });
      return refuse(409, `Nobody answered the "${entry.label}" card in time, so nothing changed. ${NOT_RETRY}`);
    }
    if (outcome.kind === "denied") return refuse(409, `The user cancelled the change to ${entry.label}. ${NOT_RETRY}`);
    if (outcome.kind === "failed") return refuse(409, `The user allowed it, but the change failed: ${outcome.error}`);
    return reply(200, { text: outcome.text });
  }

  function waiting(bot: BotRecord, threadId: string, on: boolean) {
    const group = deps.connectorThread(bot.id, threadId)?.group;
    if (group) {
      if (deps.activeGroupTurnForBot(bot.id)?.threadId === threadId && (on || turnWaitedOnPerson(store.bot(bot.id)))) store.setActivity(bot.id, on ? "waiting-on-you" : "working");
    } else if (on ? store.taskByThread(bot.id, threadId)?.busy : turnWaitedOnPerson(store.taskByThread(bot.id, threadId))) {
      store.setTaskActivity(bot.id, threadId, on ? "waiting-on-you" : "working");
    }
  }

  function settleHold(requestId: string, outcome: Outcome) {
    const entry = held.get(requestId);
    if (!entry || entry.answered) return;
    entry.answered = true;
    clearTimeout(entry.timer);
    entry.settle(outcome);
  }

  async function set(turn: Turn, body: Record<string, unknown>) {
    const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
    if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (entry.tier === "owner-only") return refuse(403, `${entry.label} is changed only by the owner, in ${entry.where}. Tell the user where to find it; do not try another way.`);
    if (deps.guestDriven(turn.threadId) || deps.turnOwner(turn) === null) return refuse(403, "Settings change only in the owner's own conversation. This turn was not started by the owner here, so nothing changed; you may still read settings.");
    if (entry.tier === "secret") {
      if (body.value !== undefined) return refuse(400, `Never send a key or token as a value. Call set on ${entry.id} with no value: a secure card asks the user for it, and you never see it.`);
      const budget = spendWrite(turn);
      if (budget) return refuse(429, budget);
      const posted = await deps.requestCredential(bot, turn.threadId, { credentialId: entry.credentialId, reason: typeof body.reason === "string" ? body.reason : undefined });
      if (!posted.body.error && posted.body.alreadyConfigured === true) return reply(200, { text: `${entry.label} is already set. To replace it, the user changes it in ${entry.where}.` });
      if (posted.status >= 300) return refuse(posted.status, String(posted.body.error ?? "The secure card could not be shown."));
      return reply(200, { text: `A secure card for ${entry.label} is ready in MausBot. End this turn now and say in one line that you are waiting for it; MausBot resumes you when the user saves it or declines. You never see the key.` });
    }
    const parsed = entry.value.safeParse(body.value);
    if (!parsed.success) return refuse(400, `${entry.label} takes ${entry.allowed}. ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    const before = entry.read();
    return entry.tier === "safe" ? setSafe(turn, bot, entry, parsed.data, before) : setConfirm(turn, bot, entry, parsed.data, before);
  }

  return {
    async handle(body: Record<string, unknown>, turn: Turn): Promise<{ status: number; body: Record<string, unknown> }> {
      if (body.action === "find") {
        const query = typeof body.query === "string" ? body.query : "";
        const hits = findSettings(entries, query, FIND_LIMIT).map(describe);
        return reply(200, { text: hits.length ? JSON.stringify(hits) : `No setting matches ${JSON.stringify(query)}. Try other words, or tell the user it is not something bots can change.` });
      }
      if (body.action === "get") {
        const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
        if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
        return reply(200, { text: JSON.stringify({ ...describe(entry), help: entry.help, ...("allowed" in entry ? { allowed: entry.allowed } : {}),
          change: entry.tier === "owner-only" ? `only the owner, in ${entry.where}` : entry.tier === "secret" ? "set with no value opens a secure card" : entry.tier === "confirm" ? "set shows the user a Change/Cancel card and waits" : "set applies at once, with Undo on the card" }) });
      }
      if (body.action === "set") return set(turn, body);
      return refuse(400, "action must be find, get or set.");
    },

    /** The person's answer to a "Change X?" card; Allow counts only from an owner's review. */
    resolveAndSend(res: ServerResponse, args: { threadId: string; requestId: string; behavior: string }, ownerReview: boolean): boolean {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const current = message?.card;
      if (!message || !current) return false;
      if (args.behavior === "allow" && !ownerReview) {
        json(res, 403, { error: "Approve settings changes from the desktop app or a paired Full-access device. In a local browser, wait until every bot is idle." });
        return true;
      }
      const hold = held.get(args.requestId);
      if (!hold || hold.threadId !== args.threadId) {
        if (!current.answered) store.patchMessage(args.threadId, message.id, { card: { ...current, answered: "unavailable", dismissed: true } });
        json(res, 200, { ok: true, outcome: "unavailable" });
        return true;
      }
      if (hold.answered) {
        json(res, 200, { ok: true, outcome: "rejected", alreadySettled: true });
        return true;
      }
      const allowed = args.behavior === "allow";
      const bot = store.bot(hold.botId);
      store.patchMessage(args.threadId, message.id, { card: { ...current, answered: allowed ? "allow" : "deny" } });
      appendDecision(deps.dataDir, { threadId: args.threadId, requestId: args.requestId, botId: hold.botId, botName: bot?.name, tool: TOOL, summary: `${hold.entry.id}: ${current.subtitle}`, decision: allowed ? "user-approved" : "user-denied", source: "user" });
      if (!allowed) {
        settleHold(args.requestId, { kind: "denied" });
        json(res, 200, { ok: true, outcome: "rejected" });
        return true;
      }
      void apply(hold.entry, hold.value, hold.before).then((outcome) => {
        if (outcome.kind === "applied") undoable.set(args.requestId, { entry: hold.entry, before: hold.earlier, after: hold.entry.read() });
        settleHold(args.requestId, outcome);
      });
      json(res, 200, { ok: true, outcome: "allowed-once" });
      return true;
    },

    /** Undo on an applied card: restores the value read before the change, unless it changed since. */
    async undo(args: { threadId: string; requestId: string }): Promise<UndoResult> {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const current = message?.card;
      if (!message || !current) return { claimed: false };
      if (current.undone) return { claimed: true, state: "already_undone" };
      const change = undoable.get(args.requestId);
      if (!change || current.answered !== "allow") return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
      if (change.entry.read() !== change.after) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      const refusal = change.before === undefined ? "The earlier value is not one that can be set back." : await change.entry.write(change.before);
      if (refusal) return { claimed: true, state: "invalid", error: refusal, status: 409 };
      undoable.delete(args.requestId);
      store.patchMessage(args.threadId, message.id, { card: { ...current, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}
