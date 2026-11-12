// A bot resets a stuck cloud computer (its own, or as a Chief one of a bot it manages): a line in the chat says so,
// and the computer is deleted the way Settings does, once its bot is not working; the line then says how it went.
import type { ServerResponse } from "node:http";

import type { json as sendJson } from "../harness/http.ts";
import { PASS } from "../routes/table.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import type { BotRecord, Store } from "../store.ts";

const PATH = "/api/internal/cloud-computer/reset";
/** The turn that called holds its own computer until it ends: the reset waits up to this long for it. */
export const RESET_RETRY_MS = 5_000;
export const RESET_RETRIES = 36;
const WHY_LIMIT = 300;

type Reset = { ok: boolean; pending?: true; missing?: true };
type Run = { threadId: string; messageId: string; fromId: string; targetId: string; targetName: string; text: string; boxId: string | null };
type Reply = { status: number; body: Record<string, unknown> };

export interface CloudComputerResetAsksDeps {
  store: Pick<Store, "appendMessage" | "patchMessage" | "bot" | "groupByThread">;
  /** Why `from` may not reset `target`'s cloud computer, in words for the bot; null when it may. */
  refusal(from: BotRecord, target: BotRecord): string | null;
  /** The id of the bot's own cloud computer now, null when it has none; throws when that cannot be read. */
  computer(botId: string): Promise<string | null>;
  /** Deletes the bot's own cloud computer, only while it is still `boxId`; throws with status 409 while it is in use. */
  reset(botId: string, boxId: string | null): Promise<Reset>;
  setTimer?(run: () => void, ms: number): void;
  /** The language of the person the conversation is for. */
  language?(threadId: string): string | undefined;
}

/** Why `target` has no cloud computer of its own to reset here, null when it may have one. Auto (no computer
 *  setting) counts: a bot on Auto can run on its own cloud computer, unless it uses its department's. */
export function noOwnCloudComputer(target: Pick<BotRecord, "name" | "computer" | "cloudBackend">, cloudOn: boolean, inherited: boolean): string | null {
  const own = cloudOn && (target.computer === undefined || target.computer === "cloud") && target.cloudBackend !== "vps" && !inherited;
  return own ? null : `${target.name} has no cloud computer of its own to reset here.`;
}

const inUse = (error: unknown) =>
  (error as { status?: unknown } | null)?.status === 409 && /in use/i.test(error instanceof Error ? error.message : "");

export function createCloudComputerResetAsks(deps: CloudComputerResetAsksDeps) {
  const { store } = deps;
  /** One reset in flight per bot's computer, by target bot id. */
  const running = new Map<string, Run>();
  const later = deps.setTimer ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });

  const words = (threadId: string, key: ServerLineKey, params: Record<string, string>) => serverLine(deps.language?.(threadId), key, params);

  function show(run: Run, line: string): void {
    store.patchMessage(run.threadId, run.messageId, { text: `${run.text}\n${line}` });
  }

  function finish(run: Run, line: string): void {
    running.delete(run.targetId);
    show(run, line);
  }

  async function attempt(run: Run, tries: number): Promise<void> {
    try {
      // Who may reset can change while it waits (a moved bot, another computer setting): checked again on every try.
      const from = store.bot(run.fromId), target = store.bot(run.targetId);
      if (!from || !target) { finish(run, words(run.threadId, "server.cloudReset.gone", { name: run.targetName })); return; }
      const refused = deps.refusal(from, target);
      if (refused) { finish(run, words(run.threadId, "server.cloudReset.failed", { reason: refused })); return; }
      const result = await deps.reset(run.targetId, run.boxId);
      const key = result.missing ? "server.cloudReset.missing" : result.pending ? "server.cloudReset.pending" : "server.cloudReset.done";
      finish(run, words(run.threadId, key, { name: run.targetName }));
    } catch (error) {
      if (inUse(error) && tries < RESET_RETRIES) {
        if (tries === 0) show(run, words(run.threadId, "server.cloudReset.waiting", { name: run.targetName }));
        later(() => void attempt(run, tries + 1), RESET_RETRY_MS);
        return;
      }
      finish(run, words(run.threadId, "server.cloudReset.failed", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** A bot's call: says so in the chat and starts the reset. `targetBotId` names another bot, for a Chief. */
  async function start(from: BotRecord, threadId: string, body: Record<string, unknown>): Promise<Reply> {
    const targetId = typeof body.targetBotId === "string" && body.targetBotId.trim() ? body.targetBotId.trim() : from.id;
    const target = store.bot(targetId);
    if (!target) return { status: 404, body: { error: "No bot has that id. Use list_bots for teammate ids." } };
    const refused = deps.refusal(from, target);
    if (refused) return { status: 403, body: { error: refused } };
    const why = typeof body.why === "string" ? body.why.trim().slice(0, WHY_LIMIT) : "";
    if (!why) return { status: 400, body: { error: "why is required: one sentence on what is wrong with the computer." } };
    const already: Reply = { status: 409, body: { error: `${target.name}'s cloud computer is already being reset. End this turn.` } };
    if (running.has(target.id)) return already;
    // The reset deletes the computer there is now, never a newer one made after this call.
    let boxId: string | null;
    try { boxId = await deps.computer(target.id); } catch (error) {
      return { status: 503, body: { error: `Could not check ${target.name}'s cloud computer: ${error instanceof Error ? error.message : String(error)}` } };
    }
    if (running.has(target.id)) return already;
    const text = words(threadId, "server.cloudReset.resetting", { name: target.name, why });
    const room = store.groupByThread(threadId);
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "text",
      text,
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
    });
    const run: Run = { threadId, messageId: message.id, fromId: from.id, targetId: target.id, targetName: target.name, text, boxId };
    running.set(target.id, run);
    void attempt(run, 0);
    const whose = target.id === from.id ? "Your" : `${target.name}'s`;
    return { status: 200, body: { text: `${whose} cloud computer is being reset: it is deleted, with everything on it, once ${target.name} is not working, and ${target.name}'s next turn makes a fresh one. End this turn now. You are not resumed: a line in this conversation shows how it went.` } };
  }

  return {
    /** POST /api/internal/cloud-computer/reset: { targetBotId?, why? } from a bot's turn. */
    async internal(args: { method: string; path: string; res: ServerResponse; json: typeof sendJson; sender: BotRecord; threadId: string; readBody(): Promise<unknown> }): Promise<typeof PASS | void> {
      if (args.path !== PATH) return PASS;
      if (args.method !== "POST") return void args.json(args.res, 405, { error: "POST only" });
      const body = await args.readBody();
      const reply = await start(args.sender, args.threadId, body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {});
      return void args.json(args.res, reply.status, reply.body);
    },
  };
}
