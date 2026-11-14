import { z } from "zod";

import type { BurstCardData } from "../../shared/burst.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { INSTRUCTIONS_MAX, ITEM_MAX, type BurstRefusal } from "../burst/manager.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const LIST_MAX = 1_000;
const itemsSchema = z.array(z.string().min(1).max(ITEM_MAX)).max(LIST_MAX);
const editSchema = z.object({ instructions: z.string().max(INSTRUCTIONS_MAX).optional(), items: itemsSchema.optional() }).strict();

export interface BurstRoutesDeps {
  owner(id: string): { botId: string; threadId: string } | null;
  /** Whether this person may see the chat this burst belongs to. */
  sees(auth: RequestAuth, threadId: string): boolean;
  /** Why this person may not press the card's buttons; the same rule as answering any card in that chat. */
  refusal(auth: RequestAuth, threadId: string, burstId: string): string | null;
  view(id: string): unknown;
  run(id: string): BurstCardData | BurstRefusal;
  cancel(id: string): BurstCardData | BurstRefusal;
  retry(id: string): BurstCardData | BurstRefusal;
  edit(id: string, plan: { instructions?: string; items?: readonly string[] }): BurstCardData | BurstRefusal;
}

/** A burst's card reads its rows here and acts here. Run is reachable only from a person's press: no bot tool can call it. */
export function createBurstRoutes(deps: BurstRoutesDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/bursts\/([\w-]+)(?:\/(run|cancel|retry|edit))?$/.exec(path);
    if (!match) return PASS;
    const [, id, action] = match;
    const owner = deps.owner(id!);
    if (!owner || !deps.sees(auth, owner.threadId)) return json(res, 404, { error: "That burst is gone." });
    if (!action) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, deps.view(id!));
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const refused = deps.refusal(auth, owner.threadId, id!);
    if (refused) return json(res, 403, { error: refused });
    let result: BurstCardData | BurstRefusal;
    if (action === "edit") {
      const parsed = editSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "That edit doesn't fit." });
      result = deps.edit(id!, parsed.data);
    } else {
      result = deps[action as "run" | "cancel" | "retry"](id!);
    }
    return "refused" in result ? json(res, 409, { error: result.refused }) : json(res, 200, result);
  };
}

const proposalSchema = z.object({
  task: z.string().min(1).max(4_000),
  instructions: z.string().max(INSTRUCTIONS_MAX),
  items: itemsSchema.min(1),
}).strict();

export interface BurstProposalDeps {
  requireActive(): void;
  /** Why this turn may not open a burst (a room, a hand-off, work that came in from outside); null when it may. */
  refusal(): string | null;
  /** The model the parts run on, and its name. */
  model(): { selection: ModelSelection; name: string };
  propose(input: { task: string; instructions: string; items: readonly string[]; model: ModelSelection; modelName: string }): BurstCardData | BurstRefusal;
  readBody(): Promise<unknown>;
}

/** The burst tool: a preview card and nothing more. */
export function createBurstProposalRoutes(deps: BurstProposalDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/internal/bursts") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    deps.requireActive();
    const refused = deps.refusal();
    if (refused) return json(res, 403, { error: refused });
    const parsed = proposalSchema.safeParse(await deps.readBody());
    if (!parsed.success) return json(res, 400, { error: "A burst needs a task, instructions and a list of items." });
    const model = deps.model();
    const card = deps.propose({ ...parsed.data, model: model.selection, modelName: model.name });
    return "refused" in card ? json(res, 400, { error: card.refused }) : json(res, 201, card);
  };
}
