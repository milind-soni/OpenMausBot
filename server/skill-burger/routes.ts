// Skill Burger over HTTP. POST /api/skill-burgers saves the run in a conversation as a workflow skill for every chat and
// every bot, built here from the stored messages (their full inputs and outputs, already scrubbed of held secrets); GET
// lists every saved one; PATCH renames one or undoes a change to its steps; DELETE with the sha256 it was saved with is its
// Undo. Whoever can chat with the bot that made a run may add it; only whoever saved it, or an admin, changes it.
import { z } from "zod";

import { draftFromLayers, draftWorkflow } from "../../shared/skill-burger/draft.ts";
import { askOf, burgerLayers, burgerWorthy, type RunMessage } from "../../shared/skill-burger/layers.ts";
import { cleanSummary, summaryPrompt } from "../../shared/skill-burger/summary.ts";
import { caseName, type Workflow } from "../../shared/skill-burger/format.ts";
import { applyDecisions, decisionsPrompt, parseDecisions, type Decisions } from "../../shared/skill-burger/decisions.ts";
import { applyChoices, draftView } from "../../shared/skill-burger/draft-view.ts";
import { applyEdit, editUndo, insertFix } from "./edit.ts";
import type { RunHistory } from "./history.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { findWorkflowSkill, listWorkflowSkills, readWorkflowSkill, removeWorkflowSkill, renameWorkflowSkill, replaceWorkflowSkill, saveWorkflowSkill, saverOf } from "./store.ts";

export const SKILL_BURGERS_PATH = "/api/skill-burgers";
export const SKILL_BURGER_SUMMARY_PATH = "/api/skill-burger-summary";
export const SKILL_BURGER_DRAFT_PATH = "/api/skill-burger-draft";

export interface SkillBurgerRouteDeps {
  /** The conversation's messages on its active branch. */
  messages(threadId: string): readonly RunMessage[];
  /** True when this thread is one of the bot's own conversations. */
  owns(botId: string, threadId: string): boolean;
  sees(auth: RequestAuth, threadId: string): boolean;
  /** Every bot here, whose own burgers are listed and whose names a new one must not take. */
  botIds(): readonly string[];
  /** One line from the bot's small text model, or null when none answers. */
  summarize?(botId: string, prompt: string): Promise<string | null | undefined>;
  /** What this person may do with a bot: a Team Cloud member edits a bot's own burgers only where they can edit the bot. */
  levelOf?(auth: RequestAuth, botId: string): "none" | "view" | "chat" | "edit";
  /** The person making the request (a Team Cloud member's key), or null for this computer's own owner. */
  actorOf?(auth: RequestAuth): string | null;
  /** A teammate a run handed work to, by the id or name it used: its name and role now. */
  teammate?(idOrName: string): { id?: string; name: string; role?: string } | undefined;
  /** Each burger's recent runs. */
  history?: Pick<RunHistory, "list">;
  root?: string;
}

const NOT_YOURS = "Only the person who saved this Skill Burger, or an admin, can change it.";
const CANT_ADD = "Only people who can chat with this bot can add its Skill Burgers.";

const id = z.string().min(1).max(100);
const summaryBody = z.object({ botId: id, threadId: z.string().min(1).max(200) }).strict();
/** What the person changed on the card before saving: steps left out, inputs renamed or given another value. */
const choices = {
  skip: z.array(z.string().max(48)).max(60).optional(),
  inputs: z.record(z.string().max(40), z.object({ name: z.string().max(40).optional(), value: z.string().max(2_000).optional() }).strict()).optional(),
};
const saveBody = z.union([
  z.object({ botId: id, threadId: z.string().min(1).max(200), summary: z.string().max(160).optional(), name: z.string().max(64).optional(), ...choices }).strict(),
  // Undo of a removal: the workflow the list read before removing it, put back where it was under its name.
  z.object({ workflow: z.unknown(), name: z.string().max(64), botId: id.optional() }).strict(),
]);
const patchBody = z.union([
  z.object({ rename: z.string().min(1).max(64), sha256: z.string().max(64).optional() }).strict(),
  // Undo of a change to the steps: the id that change returned.
  z.object({ undo: z.string().min(1).max(64) }).strict(),
]);
/** "Update the burger with this fix": what the bot did to get past a failed step goes in just before that step. */
const fixBody = z.object({ runBotId: id, threadId: z.string().min(1).max(200), run: z.string().min(1).max(64), step: z.string().min(1).max(48) }).strict();
/** One tap's "Add the path": the steps the bot did by judgement for a case nobody had saved, after the run handed it over. */
const pathBody = z.object({ runBotId: id, threadId: z.string().min(1).max(200), run: z.string().min(1).max(64), decide: z.string().min(1).max(40), case: caseName }).strict();

/** The tool rows of the bot's own steps between the run handing over `run` and the run going on: what it did by judgement. */
export function judgementLayers(messages: readonly RunMessage[], run: string) {
  const isRunCall = (message: RunMessage) => message.kind === "activity" && /(?:^|__)run_workflow$/.test(message.tool?.name ?? "");
  const handed = messages.findIndex((message) => isRunCall(message) && (message.tool?.output ?? "").includes(run));
  if (handed < 0) return [];
  const after = messages.slice(handed + 1);
  const resumed = after.findIndex(isRunCall);
  return burgerLayers(resumed < 0 ? after : after.slice(0, resumed)).filter((layer) => layer.status === "done");
}

/** The tool rows of what the bot did between a run stopping at a failed step and going on from it: its fix. */
export function fixLayers(messages: readonly RunMessage[], run: string) {
  const isRunCall = (message: RunMessage) => message.kind === "activity" && /(?:^|__)run_workflow$/.test(message.tool?.name ?? "");
  const stopped = messages.findIndex((message) => isRunCall(message) && (message.tool?.output ?? "").includes(run) && /stopped/i.test(message.tool?.output ?? ""));
  if (stopped < 0) return [];
  const after = messages.slice(stopped + 1);
  const resumed = after.findIndex(isRunCall);
  return burgerLayers(resumed < 0 ? [] : after.slice(0, resumed)).filter((layer) => layer.status === "done");
}

/** What the bot said in the run, in its own replies since the person's last ask. */
function botWords(messages: readonly RunMessage[]): string {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.role === "user" && messages[index]!.kind === "text") { start = index + 1; break; }
  return messages.slice(start).filter((message) => message.role !== "user" && message.kind === "text" && message.text?.trim()).map((message) => message.text!.trim()).join("\n").slice(-3_000);
}

function outputOf(layer: { output?: string } | undefined): unknown {
  if (!layer?.output) return undefined;
  try { return JSON.parse(layer.output); } catch { return layer.output.slice(0, 40); }
}

/** Decisions the summary pass read in a run, kept until it is saved; a run whose steps changed since finds none. */
function createDecisionCache(limit = 200) {
  const kept = new Map<string, Decisions>();
  const key = (threadId: string, workflow: Workflow) => `${threadId}:${workflow.steps.map((step) => `${step.id}=${step.label}`).join("|")}`;
  return {
    remember(threadId: string, workflow: Workflow, decisions: Decisions) {
      kept.delete(key(threadId, workflow));
      kept.set(key(threadId, workflow), decisions);
      while (kept.size > limit) kept.delete(kept.keys().next().value!);
    },
    find: (threadId: string, workflow: Workflow) => kept.get(key(threadId, workflow)) ?? null,
  };
}

export function createSkillBurgerRoutes(deps: SkillBurgerRouteDeps): RouteHandler {
  const decisionsFor = createDecisionCache();
  const admin = (auth: RequestAuth) => auth.scopes.includes("admin");
  const level = (auth: RequestAuth, botId: string) => (admin(auth) ? "edit" : deps.levelOf?.(auth, botId) ?? "none");
  /** Whoever can chat with the bot that made a run may add it for everyone. */
  const mayAdd = (auth: RequestAuth, botId: string) => level(auth, botId) === "chat" || level(auth, botId) === "edit";
  /** Only whoever saved a burger, or an admin, renames it, removes it or changes its steps. */
  const mayChange = (auth: RequestAuth, name: string) => {
    if (admin(auth)) return true;
    const actor = deps.actorOf?.(auth);
    return Boolean(actor && saverOf(name, deps.root) === actor);
  };
  const drafted = (messages: readonly RunMessage[], summary?: string) => draftWorkflow(messages, { ...(summary ? { summary } : {}), ...(deps.teammate ? { teammate: deps.teammate } : {}) });
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path === SKILL_BURGER_DRAFT_PATH) {
      // The card's view of the finished run: the same draft a save writes, so its step ids are the ones saved.
      if (method !== "POST") return json(res, 405, { error: "Use POST." });
      const body = summaryBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send botId and threadId." });
      const { botId, threadId } = body.data;
      if (!deps.owns(botId, threadId) || !deps.sees(auth, threadId)) return json(res, 404, { error: "No such conversation." });
      const messages = deps.messages(threadId);
      const draft = drafted(messages);
      return json(res, 200, { draft: draft ? draftView(draft.workflow, draft.layers, messages) : null });
    }
    if (path === SKILL_BURGER_SUMMARY_PATH) {
      if (method !== "POST") return json(res, 405, { error: "Use POST." });
      const body = summaryBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send botId and threadId." });
      const { botId, threadId } = body.data;
      if (!deps.owns(botId, threadId) || !deps.sees(auth, threadId)) return json(res, 404, { error: "No such conversation." });
      const messages = deps.messages(threadId);
      const layers = burgerLayers(messages).filter((layer) => layer.status === "done");
      const ask = askOf(messages);
      if (!burgerWorthy(layers) || !ask || !deps.summarize) return json(res, 200, { summary: null });
      const draft = drafted(messages);
      const words = botWords(messages);
      const [reply, decided] = await Promise.all([
        deps.summarize(botId, summaryPrompt(ask, layers)).catch(() => null),
        draft && words ? deps.summarize(botId, decisionsPrompt(ask, draft.workflow.steps.map((step, index) => ({ id: step.id, label: step.label, output: outputOf(draft.layers[index]) })), words)).catch(() => null) : null,
      ]);
      const decisions = parseDecisions(decided);
      if (draft && decisions) decisionsFor.remember(threadId, draft.workflow, decisions);
      return json(res, 200, { summary: cleanSummary(reply) });
    }
    if (path !== SKILL_BURGERS_PATH && !path.startsWith(`${SKILL_BURGERS_PATH}/`)) return PASS;
    const botIds = deps.botIds();
    if (path === SKILL_BURGERS_PATH) {
      if (method === "GET") return json(res, 200, { skills: listWorkflowSkills(deps.root).map((skill) => ({ ...skill, canChange: mayChange(auth, skill.name) })) });
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      const body = saveBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send botId and threadId." });
      let saved;
      const savedBy = deps.actorOf?.(auth) ?? null;
      if ("workflow" in body.data) {
        // Undo of a removal: whoever removed it may put it back.
        const { workflow, name, botId } = body.data;
        if (!admin(auth) && !(botId && mayAdd(auth, botId))) return json(res, 403, { error: NOT_YOURS });
        saved = saveWorkflowSkill({ workflow, name, origin: botId, savedBy, botIds, root: deps.root });
      } else {
        const { botId, threadId, summary, name, skip, inputs } = body.data;
        if (!deps.owns(botId, threadId) || !deps.sees(auth, threadId)) return json(res, 404, { error: "No such conversation." });
        if (!mayAdd(auth, botId)) return json(res, 403, { error: CANT_ADD });
        const draft = drafted(deps.messages(threadId), summary);
        if (!draft) return json(res, 422, { error: "This run has nothing to save yet." });
        const chosen = applyChoices(applyDecisions(draft.workflow, decisionsFor.find(threadId, draft.workflow)), { ...(skip ? { skip } : {}), ...(inputs ? { inputs } : {}) });
        if ("error" in chosen) return json(res, 422, { error: chosen.error });
        saved = saveWorkflowSkill({ workflow: chosen, name, origin: botId, savedBy, botIds, root: deps.root });
      }
      if ("error" in saved) return json(res, saved.taken ? 409 : 422, { error: saved.error });
      return json(res, 201, { skill: saved });
    }
    const name = decodeURIComponent(path.slice(SKILL_BURGERS_PATH.length + 1));
    const stale = () => json(res, 409, { error: "This Skill Burger changed since. Reload and try again." });
    if (method === "POST" && name.endsWith("/fix")) {
      const body = fixBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send the run and the step it fixed." });
      const { runBotId, threadId, run, step } = body.data;
      const burger = name.slice(0, -"/fix".length);
      if (!deps.owns(runBotId, threadId) || !deps.sees(auth, threadId)) return json(res, 404, { error: "No such conversation." });
      if (!mayChange(auth, burger)) return json(res, 403, { error: NOT_YOURS });
      const found = readWorkflowSkill(burger, deps.root);
      const sha256 = listWorkflowSkills(deps.root).find((skill) => skill.name === burger)?.sha256;
      if (!found || !sha256) return json(res, 404, { error: "No such skill." });
      const layers = fixLayers(deps.messages(threadId), run);
      if (!layers.length) return json(res, 422, { error: "The bot did nothing to fix it that could be saved." });
      const fix = draftFromLayers(layers, askOf(deps.messages(threadId)) ?? "", found.workflow.summary, deps.teammate ? { teammate: deps.teammate } : {}).steps;
      const next = insertFix(found.workflow, step, fix);
      if ("error" in next) return json(res, 422, next);
      const saved = replaceWorkflowSkill({ name: burger, workflow: next, sha256, root: deps.root });
      if ("stale" in saved) return stale();
      if ("error" in saved) return json(res, 422, saved);
      return json(res, 200, { skill: saved, undo: editUndo.keep(burger, found.workflow, saved.sha256) });
    }
    if (method === "POST" && name.endsWith("/paths")) {
      const body = pathBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send the run, its decide step and the case." });
      const { runBotId, threadId, run, decide, case: chosen } = body.data;
      const burger = name.slice(0, -"/paths".length);
      if (!deps.owns(runBotId, threadId) || !deps.sees(auth, threadId)) return json(res, 404, { error: "No such conversation." });
      if (!mayChange(auth, burger)) return json(res, 403, { error: NOT_YOURS });
      const found = readWorkflowSkill(burger, deps.root);
      const sha256 = listWorkflowSkills(deps.root).find((skill) => skill.name === burger)?.sha256;
      if (!found || !sha256) return json(res, 404, { error: "No such skill." });
      const layers = judgementLayers(deps.messages(threadId), run);
      if (!layers.length) return json(res, 422, { error: "The bot did nothing for this case that could be saved." });
      const steps = draftFromLayers(layers, askOf(deps.messages(threadId)) ?? "", found.workflow.summary).steps;
      const next = applyEdit(found.workflow, { action: "add_case", decide: { id: decide }, case: chosen, steps });
      if ("error" in next) return json(res, 422, next);
      const saved = replaceWorkflowSkill({ name: burger, workflow: next, sha256, root: deps.root });
      if ("stale" in saved) return stale();
      if ("error" in saved) return json(res, 422, saved);
      return json(res, 200, { skill: saved, undo: editUndo.keep(burger, found.workflow, saved.sha256) });
    }
    if (method === "GET" && name.endsWith("/runs")) {
      // A burger's recent runs, by the bots this person can see.
      const burger = name.slice(0, -"/runs".length);
      const visible = new Set(admin(auth) ? botIds : botIds.filter((botId) => level(auth, botId) !== "none"));
      return json(res, 200, { runs: deps.history?.list(burger, visible) ?? [] });
    }
    if (method === "GET") {
      const runner = url.searchParams.get("runner");
      if (runner) {
        if (level(auth, runner) === "none") return json(res, 404, { error: "No such skill." });
        const found = findWorkflowSkill(runner, name, deps.root);
        return found ? json(res, 200, { workflow: found.workflow }) : json(res, 404, { error: "No such skill." });
      }
      const found = readWorkflowSkill(name, deps.root);
      return found ? json(res, 200, found) : json(res, 404, { error: "No such skill." });
    }
    if (method === "PATCH") {
      const body = patchBody.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Send rename or undo." });
      if (!mayChange(auth, name)) return json(res, 403, { error: NOT_YOURS });
      if ("undo" in body.data) {
        const kept = editUndo.take(body.data.undo);
        if (!kept || kept.name !== name) return json(res, 404, { error: "There is nothing to undo." });
        const restored = replaceWorkflowSkill({ name, workflow: kept.previous, sha256: kept.sha256, root: deps.root });
        if ("stale" in restored) return stale();
        return "error" in restored ? json(res, 422, { error: restored.error }) : json(res, 200, { skill: restored });
      }
      const result = renameWorkflowSkill({ name, to: body.data.rename, botIds, sha256: body.data.sha256, root: deps.root });
      if ("stale" in result) return stale();
      if ("error" in result) return json(res, result.taken ? 409 : 422, { error: result.error });
      return json(res, 200, { skill: result });
    }
    if (method === "DELETE") {
      if (!mayChange(auth, name)) return json(res, 403, { error: NOT_YOURS });
      const removed = removeWorkflowSkill(name, url.searchParams.get("sha256") ?? undefined, deps.root);
      if ("stale" in removed) return stale();
      if ("error" in removed) return json(res, 500, { error: removed.error });
      return json(res, 200, { removed: true });
    }
    return json(res, 405, { error: "Use GET, PATCH or DELETE." });
  };
}
