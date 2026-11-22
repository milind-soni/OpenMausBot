// Skill Burger over HTTP. POST /api/skill-burgers saves the run in a conversation as a workflow skill, built here from
// the stored messages (their full inputs and outputs, already scrubbed of held secrets); GET lists the saved ones and
// reads one; DELETE with the sha256 the save returned is its Undo.
import { z } from "zod";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { Workflow } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { listWorkflowSkills, readWorkflowSkill, removeWorkflowSkill, saveWorkflowSkill } from "./store.ts";

export const SKILL_BURGERS_PATH = "/api/skill-burgers";

export interface SkillBurgerRouteDeps {
  /** The conversation's messages on its active branch. */
  messages(threadId: string): readonly RunMessage[];
  /** True when this thread is one of the bot's own conversations. */
  owns(botId: string, threadId: string): boolean;
  sees(auth: RequestAuth, threadId: string): boolean;
  /** Called after a save or removal, so open windows refresh their lists. */
  changed?(): void;
  root?: string;
}

const saveBody = z.union([
  z.object({ botId: z.string().min(1).max(100), threadId: z.string().min(1).max(200), summary: z.string().max(160).optional(), name: z.string().max(64).optional() }).strict(),
  // Undo of a removal: the workflow the list read before removing it, saved again under its name.
  z.object({ workflow: z.unknown(), name: z.string().max(64) }).strict(),
]);

export function createSkillBurgerRoutes(deps: SkillBurgerRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== SKILL_BURGERS_PATH && !path.startsWith(`${SKILL_BURGERS_PATH}/`)) return PASS;
    if (path === SKILL_BURGERS_PATH) {
      if (method === "GET") return json(res, 200, { skills: listWorkflowSkills(deps.root) });
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      const body = saveBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send botId and threadId." });
      let workflow: unknown;
      if ("workflow" in body.data) workflow = body.data.workflow;
      else {
        const { botId, threadId, summary } = body.data;
        if (!deps.owns(botId, threadId) || !deps.sees(auth, threadId)) return json(res, 404, { error: "No such conversation." });
        const draft = draftWorkflow(deps.messages(threadId), { summary });
        if (!draft) return json(res, 422, { error: "This run has nothing to save yet." });
        workflow = draft.workflow;
      }
      const saved = saveWorkflowSkill({ workflow: workflow as Workflow, name: body.data.name, root: deps.root });
      if ("error" in saved) return json(res, saved.taken ? 409 : 422, { error: saved.error });
      deps.changed?.();
      return json(res, 201, { skill: saved });
    }
    const name = decodeURIComponent(path.slice(SKILL_BURGERS_PATH.length + 1));
    if (method === "GET") {
      const found = readWorkflowSkill(name, deps.root);
      return found ? json(res, 200, found) : json(res, 404, { error: "No such skill." });
    }
    if (method === "DELETE") {
      const removed = removeWorkflowSkill(name, url.searchParams.get("sha256") ?? undefined, deps.root);
      if ("stale" in removed) return json(res, 409, { error: "This skill changed since it was saved. Remove it from Skills instead." });
      if ("error" in removed) return json(res, 500, { error: removed.error });
      deps.changed?.();
      return json(res, 200, { removed: true });
    }
    return json(res, 405, { error: "Use GET or DELETE." });
  };
}
