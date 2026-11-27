//   POST /api/suggested-reply  {botId, threadId, after}  →  {text}
// `after` is the reply the composer saw; `text` is null whenever there is nothing to offer. Nothing is stored: the answer
// goes back to the asking composer only.
import { z } from "zod";

import { cleanSuggestion, lastExchange, SUGGESTION_MAX_WORDS, type LastExchange, type SuggestionRow } from "../../shared/suggested-reply.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const SUGGESTED_REPLY_PATH = "/api/suggested-reply";
export const SUGGESTED_REPLY_TIMEOUT_MS = 20_000;

export interface SuggestedReplyDeps {
  /** Settings → Features → Suggested replies. */
  enabled(): boolean;
  /** True when this thread is one of the bot's own conversations. */
  owns(botId: string, threadId: string): boolean;
  sees(auth: RequestAuth, threadId: string): boolean;
  /** The person may write to this bot. */
  mayChat(auth: RequestAuth, botId: string): boolean;
  /** The conversation's messages on its active branch. */
  messages(threadId: string): readonly SuggestionRow[];
  busy(botId: string, threadId: string): boolean;
  /** The bot's own engine on its smallest model, or null when it has none. */
  writer(botId: string): { generateText(prompt: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> } | null;
}

const body = z.object({ botId: z.string().min(1).max(200), threadId: z.string().min(1).max(200), after: z.string().min(1).max(200) }).strict();

export function suggestionPrompt(exchange: Pick<LastExchange, "ask" | "reply">): string {
  return [
    "Suggest the next message the person might send in this chat with their assistant.",
    `Write one short line in the person's own voice and language, at most ${SUGGESTION_MAX_WORDS} words: no quotes, no explanation, no emoji.`,
    "If no natural next message fits, answer NONE.",
    "",
    "<person>", exchange.ask, "</person>",
    "<assistant>", exchange.reply, "</assistant>",
  ].join("\n");
}

export function createSuggestedReplyRoutes(deps: SuggestedReplyDeps): RouteHandler {
  const running = new Map<string, AbortController>();
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== SUGGESTED_REPLY_PATH) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    let raw: unknown;
    try { raw = await readBody(req, 4_096); } catch { return json(res, 400, { error: "Send botId, threadId and after." }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: "Send botId, threadId and after." });
    const { botId, threadId, after } = parsed.data;
    if (!deps.owns(botId, threadId) || !deps.sees(auth, threadId) || !deps.mayChat(auth, botId)) return json(res, 404, { error: "No such conversation." });
    const current = () => {
      const exchange = lastExchange(deps.messages(threadId));
      return exchange?.replyId === after && !deps.busy(botId, threadId) ? exchange : null;
    };
    const exchange = deps.enabled() ? current() : null;
    const writer = exchange ? deps.writer(botId) : null;
    if (!exchange || !writer) return json(res, 200, { text: null });
    running.get(threadId)?.abort();
    const stop = new AbortController();
    running.set(threadId, stop);
    const gone = () => { if (!res.writableFinished) stop.abort(); };
    res.once("close", gone);
    let text: string | null = null;
    try {
      text = cleanSuggestion(await writer.generateText(suggestionPrompt(exchange), {
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(SUGGESTED_REPLY_TIMEOUT_MS)]),
        timeoutMs: SUGGESTED_REPLY_TIMEOUT_MS,
      }));
    } catch {
      text = null;
    } finally {
      res.off("close", gone);
      if (running.get(threadId) === stop) running.delete(threadId);
    }
    if (res.writableEnded || res.destroyed) return;
    return json(res, 200, { text: !stop.signal.aborted && text && current() ? text : null });
  };
}
