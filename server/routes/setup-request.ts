// Set me up under a new bot's greeting (server/setup-request.ts): POST is the press, DELETE the x on its chip.
// Open to anyone who may write in that conversation (client scope, like sending a message): the press does nothing a
// typed /setup could not.
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { askForSetup, cancelSetupRequest, type SetupRequestStore } from "../setup-request.ts";
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
}

const PATH = /^\/api\/bots\/([\w-]+)\/setup-request$/;
const ID = /^[\w-]{1,128}$/;
const NO_TOOLS = "This bot's AI can't set it up by itself. Tell the bot what you'd like it to do instead.";

export function createSetupRequestRoutes(deps: SetupRequestRouteDeps): RouteHandler {
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
    if (deps.store.taskByThread(botId, threadId) && !deps.canSetUp(botId, threadId)) return json(res, 409, { error: NO_TOOLS });
    const asked = askForSetup(deps.store, botId, threadId, deps.language(), deps.presser(auth));
    if (!asked.ok) return json(res, asked.status, { error: asked.error });
    return json(res, 200, asked);
  };
}
