// The setup card under a new bot's greeting (server/setup-request.ts): POST is a pick (with its words) or "Something
// else" (without), DELETE the x on the card or its chip. Open to anyone who may write in that conversation (client
// scope, like sending a message): a pick does nothing a typed /setup could not.
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { askForSetup, cancelSetupRequest, type SetupRequestStore } from "../setup-request.ts";
import type { Message } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SetupRequestRouteDeps {
  store: SetupRequestStore;
  /** The language the server writes the bot's lines in. */
  language(): string | undefined;
  /** Why this caller may not write in this conversation (a Cloud guest in the owner's chat), or null. */
  sendRefusal(auth: RequestAuth, threadId: string): string | null;
  /** Who this caller is where several people share the place (their reactor key); undefined where one person does. */
  presser(auth: RequestAuth): string | undefined;
  /** The conversation's AI has the tools a bot sets itself up with. */
  canSetUp(botId: string, threadId: string): boolean;
  /** Sends the caller's words in this conversation exactly as a typed message, starting (or queueing) its turn. A
   * refusal throws an error with its HTTP status. */
  send(auth: RequestAuth, botId: string, threadId: string, text: string): Promise<{ ok: true; message?: Message }>;
}

const PATH = /^\/api\/bots\/([\w-]+)\/setup-request$/;
const ID = /^[\w-]{1,128}$/;
const PICK_LIMIT = 500;
const NO_TOOLS = "This bot's AI can't set it up by itself. Tell the bot what you'd like it to do instead.";

export function createSetupRequestRoutes(deps: SetupRequestRouteDeps): RouteHandler {
  /** Conversations whose pick is on its way: a second tap, a letter key or another tab must not send it twice. */
  const picking = new Set<string>();
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(PATH);
    if (!m || (method !== "POST" && method !== "DELETE")) return PASS;
    const botId = m[1]!;
    const body = await readBody(req, 2048);
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    if (!ID.test(threadId)) return json(res, 400, { error: "threadId is required" });
    if (!deps.store.bot(botId)) return json(res, 404, { error: "no such bot" });
    const refused = deps.sendRefusal(auth, threadId);
    if (refused) return json(res, 403, { error: refused });
    if (method === "DELETE") {
      // An owner or admin may clear someone else's, so one never strands the chat.
      const outcome = cancelSetupRequest(deps.store, botId, threadId, deps.presser(auth), { admin: ownerOrAdmin(auth) });
      if (outcome === "unknown") return json(res, 404, { error: "There is no such conversation." });
      if (outcome === "refused") return json(res, 403, { error: "Only the person who pressed Set me up, or an owner or admin, can stop it." });
      return json(res, 200, { ok: true });
    }
    const picked = body?.text === undefined ? undefined : typeof body.text === "string" ? body.text.trim() : "";
    if (picked !== undefined && (!picked || picked.length > PICK_LIMIT)) {
      return json(res, 400, { error: `text must be the words of a choice, at most ${PICK_LIMIT} characters` });
    }
    if (deps.store.taskByThread(botId, threadId) && !deps.canSetUp(botId, threadId)) return json(res, 409, { error: NO_TOOLS });
    const key = `${botId}:${threadId}`;
    if (picking.has(key)) return json(res, 409, { error: "That answer is already on its way." });
    const asked = askForSetup(deps.store, botId, threadId, deps.language(), deps.presser(auth), picked !== undefined);
    if (!asked.ok) return json(res, asked.status, { error: asked.error });
    if (picked === undefined) return json(res, 200, asked);
    picking.add(key);
    try {
      const sent = await deps.send(auth, botId, threadId, picked);
      return json(res, 200, { ok: true, ...(sent.message ? { message: sent.message } : {}) });
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status !== "number") throw error;
      deps.store.patchTask(botId, threadId, { setupRequest: undefined });
      return json(res, status, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      picking.delete(key);
    }
  };
}
