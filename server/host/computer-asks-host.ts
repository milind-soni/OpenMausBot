// On the person's own Cloud: the asks its bots raise for their computer, read against what
// lends now, the ask_for_computer call itself, and a request that goes on by itself once the computer is on.
import type { ServerResponse } from "node:http";

import { ComputerAsks } from "../computer-asks.ts";
import type { json as sendJson } from "../harness/http.ts";
import { PASS } from "../routes/table.ts";
import type { Notification } from "../notify.ts";
import type { SharedComputers } from "../shared-computers.ts";
import type { Store } from "../store.ts";
import { ASK_FOR_COMPUTER_TOOL, COMPUTER_NEEDS } from "../../shared/computer-ask.ts";

type Turn = { botId: string; threadId: string; generation: string };

export interface ComputerAsksHostDeps {
  store: Store;
  notify(notification: Notification | null): void;
  lending: Pick<SharedComputers, "lendingNow" | "known"> & { changed: () => void; askTool: string | null };
  /** Whose computers these are on a Cloud home. */
  principal: string;
  threadBusy(botId: string, threadId: string): boolean;
  queued(botId: string, threadId: string): boolean;
  continueRequest(botId: string, text: string, opts: { threadId: string; cardContinuation: true; requestMessageId: string }): Promise<unknown>;
  /** Why this turn can't use the person's computer, in the words the bot says; null when it can. */
  refusal(turn: Turn): string | null;
  request(threadId: string): { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean } | undefined;
  /** The turn still runs: one that ended raises nothing. */
  active(turn: Turn): boolean;
}

export function createComputerAsksHost(deps: ComputerAsksHostDeps) {
  const { store } = deps;
  const asks = new ComputerAsks({
    store,
    notify: deps.notify,
    online: () => deps.lending.lendingNow(deps.principal),
    known: () => deps.lending.known(deps.principal),
    carryOn: ({ botId, threadId, requestMessageId }, text) => {
      if (!store.taskByThread(botId, threadId)) return true;
      if (deps.threadBusy(botId, threadId) || deps.queued(botId, threadId)) return false;
      // Someone wrote since the bot asked: they lead now.
      if (store.activePath(threadId).findLast((message) => message.role === "user" && message.kind === "text")?.id !== requestMessageId) return true;
      void deps.continueRequest(botId, text, { threadId, cardContinuation: true, requestMessageId }).catch((error: unknown) => {
        console.warn(`computer asks: the request could not go on: ${error instanceof Error ? error.message : String(error)}`);
      });
      return true;
    },
  });
  deps.lending.changed = () => asks.lendingChanged();
  deps.lending.askTool = ASK_FOR_COMPUTER_TOOL;

  /** POST /api/internal/computer-asks: { need, why } from a bot's turn. */
  async function call(turn: Turn, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = body && typeof body === "object" ? body as { need?: unknown; why?: unknown } : {};
    if (!deps.active(turn)) return { status: 401, body: { error: "This turn has ended." } };
    const need = COMPUTER_NEEDS.find((candidate) => candidate === input.need);
    if (!need) return { status: 400, body: { error: `need must be one of ${COMPUTER_NEEDS.join(", ")}` } };
    const bot = store.projectBotForTask(turn.botId, turn.threadId);
    if (!bot) return { status: 404, body: { error: "This bot no longer exists." } };
    if (need === "screen" && bot.computer === "off") {
      return { status: 403, body: { error: "This bot has no computer. Change its Computer setting to use their computer's apps and screen." } };
    }
    const refused = deps.refusal(turn);
    if (refused) return { status: 403, body: { error: refused } };
    const request = deps.request(turn.threadId);
    const requestMessageId = request?.messageId && !request.stopped && request.generations.has(turn.generation) ? request.messageId : undefined;
    const reply = await asks.ask({ threadId: turn.threadId, bot, need, why: input.why, ...(requestMessageId ? { requestMessageId } : {}) });
    return { status: 200, body: { state: reply.state, text: ComputerAsks.say(reply, bot.name) } };
  }

  /** Inside index.ts's /api/internal/ block, after the capability bearer is checked: this route, or PASS. */
  async function internal(ctx: { method: string; path: string; res: ServerResponse; json: typeof sendJson; turn: Turn; readBody: () => Promise<unknown> }): Promise<typeof PASS | void> {
    if (ctx.method !== "POST" || ctx.path !== "/api/internal/computer-asks") return PASS;
    const answer = await call(ctx.turn, await ctx.readBody());
    ctx.json(ctx.res, answer.status, answer.body);
  }

  return { asks, call, internal };
}
