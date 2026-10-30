import { PASS, type RouteHandler } from "./table.ts";

export interface SavedStepsRouteDeps {
  bot(id: string): unknown;
  forget(botId: string, recipeId: string): boolean;
}

const RECIPE_ID = /^[\w-]{1,64}$/;

/** Not in CLIENT_ALLOW (server/request-auth.ts): only the owner and admins forget a saved recipe. */
export function createSavedStepsRoutes(deps: SavedStepsRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/saved-steps\/([^/]+)$/);
    if (!m || method !== "DELETE") return PASS;
    if (!deps.bot(m[1])) return json(res, 404, { error: "bot not found" });
    if (!RECIPE_ID.test(m[2])) return json(res, 400, { error: "recipe id must be letters, digits, - or _" });
    return json(res, 200, { forgotten: deps.forget(m[1], m[2]) });
  };
}
