// A bot asks the person to reset a stuck cloud computer (its own, or as a Chief one of a bot it manages): a card
// in the chat, and on Allow the computer is deleted the way Settings does, once its bot is not working.
import type { ServerResponse } from "node:http";

import { newId } from "../contracts.ts";
import type { json as sendJson } from "../harness/http.ts";
import { optionCardsForTools } from "../message-db.ts";
import { PASS } from "../routes/table.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import type { BotRecord, Store } from "../store.ts";

export const RESET_CLOUD_COMPUTER_TOOL = "reset_cloud_computer";
const PATH = "/api/internal/cloud-computer/reset";
/** The turn that asked holds its own computer until it ends: Allow waits up to this long for it. */
export const RESET_RETRY_MS = 5_000;
export const RESET_RETRIES = 36;
const WHY_LIMIT = 300;

type Reset = { ok: boolean; pending?: true; missing?: true };
type Ask = { threadId: string; messageId: string; targetId: string; targetName: string; subtitle: string; boxId: string | null };
type Reply = { status: number; body: Record<string, unknown> };

export interface CloudComputerResetAsksDeps {
  store: Pick<Store, "appendMessage" | "patchMessage" | "messagesFor" | "bot" | "groupByThread">;
  /** Why `from` may not ask to reset `target`'s cloud computer, in words for the bot; null when it may. */
  refusal(from: BotRecord, target: BotRecord): string | null;
  /** The id of the bot's own cloud computer now, null when it has none; throws when that cannot be read. */
  computer(botId: string): Promise<string | null>;
  /** Deletes the bot's own cloud computer, only while it is still `boxId`; throws with status 409 while it is in use. */
  reset(botId: string, boxId: string | null): Promise<Reset>;
  /** Cards a previous run left open; defaults to the message database. */
  openCards?(): Array<{ threadId: string; messageId: string }>;
  setTimer?(run: () => void, ms: number): void;
  /** The language of the person the conversation is for. */
  language?(threadId: string): string | undefined;
}

const inUse = (error: unknown) =>
  (error as { status?: unknown } | null)?.status === 409 && /in use/i.test(error instanceof Error ? error.message : "");

export function createCloudComputerResetAsks(deps: CloudComputerResetAsksDeps) {
  const { store } = deps;
  const asks = new Map<string, Ask>();
  const later = deps.setTimer ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });

  const words = (threadId: string, key: ServerLineKey, params: Record<string, string>) => serverLine(deps.language?.(threadId), key, params);

  function show(ask: Ask, line: string, answered?: "allow" | "deny"): void {
    const card = store.messagesFor(ask.threadId).find((message) => message.id === ask.messageId)?.card;
    if (!card) return;
    store.patchMessage(ask.threadId, ask.messageId, { card: { ...card, ...(answered ? { answered } : {}), subtitle: line ? `${ask.subtitle}\n${line}` : ask.subtitle } });
  }

  async function run(ask: Ask, tries: number): Promise<void> {
    try {
      const result = await deps.reset(ask.targetId, ask.boxId);
      const key = result.missing ? "server.cloudReset.missing" : result.pending ? "server.cloudReset.pending" : "server.cloudReset.done";
      show(ask, words(ask.threadId, key, { name: ask.targetName }));
    } catch (error) {
      if (inUse(error) && tries < RESET_RETRIES) {
        if (tries === 0) show(ask, words(ask.threadId, "server.cloudReset.waiting", { name: ask.targetName }));
        later(() => void run(ask, tries + 1), RESET_RETRY_MS);
        return;
      }
      show(ask, words(ask.threadId, "server.cloudReset.failed", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** A bot's call: shows the card. `targetBotId` names another bot, for a Chief. */
  async function propose(from: BotRecord, threadId: string, body: Record<string, unknown>): Promise<Reply> {
    const targetId = typeof body.targetBotId === "string" && body.targetBotId.trim() ? body.targetBotId.trim() : from.id;
    const target = store.bot(targetId);
    if (!target) return { status: 404, body: { error: "No bot has that id. Use list_bots for teammate ids." } };
    const refused = deps.refusal(from, target);
    if (refused) return { status: 403, body: { error: refused } };
    const why = typeof body.why === "string" ? body.why.trim().slice(0, WHY_LIMIT) : "";
    if (!why) return { status: 400, body: { error: "why is required: one sentence on what is wrong with the computer." } };
    const already: Reply = { status: 409, body: { error: `A card asking to reset ${target.name}'s cloud computer is already waiting for the person. End this turn.` } };
    const waiting = () => [...asks.values()].some((ask) => ask.targetId === target.id);
    if (waiting()) return already;
    // Allow resets the computer there is now, never a newer one made after the card was shown.
    let boxId: string | null;
    try { boxId = await deps.computer(target.id); } catch (error) {
      return { status: 503, body: { error: `Could not check ${target.name}'s cloud computer: ${error instanceof Error ? error.message : String(error)}` } };
    }
    if (waiting()) return already;
    const subtitle = [why, words(threadId, "server.cloudReset.what", { name: target.name })].filter(Boolean).join("\n");
    const room = store.groupByThread(threadId);
    const requestId = newId();
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "options",
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      card: { title: words(threadId, "server.cloudReset.title", { name: target.name }), subtitle, options: ["Allow", "Deny"], requestId, requestType: "permission", tool: RESET_CLOUD_COMPUTER_TOOL },
    });
    asks.set(requestId, { threadId, messageId: message.id, targetId: target.id, targetName: target.name, subtitle, boxId });
    const whose = target.id === from.id ? "your" : `${target.name}'s`;
    return { status: 200, body: { text: `A card asking the person to reset ${whose} cloud computer is now in this conversation. End this turn now and say in one line that it waits for them. On Allow the computer is deleted once ${target.name} is not working, and ${target.name}'s next turn makes a fresh one. You are not resumed: the card shows how it went.` } };
  }

  return {
    /** A tap on the card; false when the card is not one of these. */
    answer(requestId: string, behavior: string | undefined): boolean {
      const ask = asks.get(requestId);
      if (!ask) return false;
      asks.delete(requestId);
      if (behavior !== "allow") { show(ask, "", "deny"); return true; }
      show(ask, words(ask.threadId, "server.cloudReset.resetting", { name: ask.targetName }), "allow");
      void run(ask, 0);
      return true;
    },

    /** A card a previous run left open has nothing behind it now: closed at startup. */
    dismissStale(): number {
      let closed = 0;
      for (const { threadId, messageId } of (deps.openCards ?? (() => optionCardsForTools([RESET_CLOUD_COMPUTER_TOOL])))()) {
        const card = store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
        if (!card || card.answered || card.dismissed || card.expired || asks.has(card.requestId ?? "")) continue;
        if (store.patchMessage(threadId, messageId, { card: { ...card, expired: true, options: [] } })) closed += 1;
      }
      return closed;
    },

    /** POST /api/internal/cloud-computer/reset: { targetBotId?, why? } from a bot's turn. */
    async internal(args: { method: string; path: string; res: ServerResponse; json: typeof sendJson; sender: BotRecord; threadId: string; readBody(): Promise<unknown> }): Promise<typeof PASS | void> {
      if (args.path !== PATH) return PASS;
      if (args.method !== "POST") return void args.json(args.res, 405, { error: "POST only" });
      const body = await args.readBody();
      const reply = await propose(args.sender, args.threadId, body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {});
      return void args.json(args.res, reply.status, reply.body);
    },
  };
}
