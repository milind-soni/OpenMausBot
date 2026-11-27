import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { exactRequest, requestKey } from "./key.ts";
import { ELEMENT_TOOLS, KEPT_ARGS, KEY_TOOLS, flipsToggle, holdsPersonWords, recipeFitsRequest, unsafeStep, windowScoped, type Recipe } from "./rules.ts";

export const MAX_RECIPES = 200;
export const UNUSED_MS = 60 * 24 * 60 * 60 * 1000;

const FILE_NAME = "saved-steps.json";
const VERSION = 1;

const identity = z.object({ bundleId: z.string().optional(), name: z.string().optional() });
const step = z.object({
  tool: z.enum(["click", "double_click", "right_click", "set_value", "press_key", "scroll", "launch_app", "bring_to_front", "hotkey"]),
  args: z.record(z.string(), z.unknown()),
  app: identity.optional(),
  window: z.object({ title: z.string() }).optional(),
  element: z.object({ role: z.string(), label: z.string(), path: z.array(z.string()) }).optional(),
});
const ADDRESSING_KEYS = new Set(["x", "y", "element_token", "element_index", "pid", "window_id", "session"]);
const argsFitTool = (tool: keyof typeof KEPT_ARGS, args: Record<string, unknown>) =>
  Object.keys(args).every((name) => !ADDRESSING_KEYS.has(name) && KEPT_ARGS[tool].includes(name));
const targetsFitTool = (entry: z.infer<typeof step>) => (!ELEMENT_TOOLS.has(entry.tool) || (entry.element !== undefined && entry.app !== undefined))
  && (!KEY_TOOLS.has(entry.tool) || (entry.app !== undefined && entry.window !== undefined))
  && !(entry.element && flipsToggle(entry.tool, entry.element.role)) && unsafeStep(entry) === null;
const safeBotId = (botId: string) => botId !== "" && botId !== "." && botId !== ".." && basename(botId) === botId && !/[\\/]/.test(botId);

const recipeSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  request: z.string(),
  steps: z.array(step.refine((entry) => argsFitTool(entry.tool, entry.args) && windowScoped(entry.tool, entry.args) && targetsFitTool(entry))).min(1).max(40),
  createdAt: z.number().finite(),
  lastUsedAt: z.number().finite(),
}).refine((recipe) => recipe.key === requestKey(recipe.request)
  && (!holdsPersonWords(recipe.steps) || (recipe.request === exactRequest(recipe.request) && recipeFitsRequest(recipe, recipe.request))));

export class RecipeStore {
  private readonly folder: (botId: string) => string;
  private readonly now: () => number;

  constructor(options: { folder: (botId: string) => string; now?: () => number }) {
    this.folder = options.folder;
    this.now = options.now ?? Date.now;
  }

  find(botId: string, key: string): Recipe | undefined {
    return this.read(botId).recipes.find((recipe) => recipe.key === key);
  }

  save(botId: string, recipe: Recipe): void {
    const kept = this.read(botId).recipes.filter((existing) => existing.key !== recipe.key && existing.id !== recipe.id);
    kept.push(recipe);
    kept.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    this.write(botId, kept.slice(0, MAX_RECIPES));
  }

  touch(botId: string, recipeId: string): void {
    const { recipes } = this.read(botId);
    const target = recipes.find((recipe) => recipe.id === recipeId);
    if (!target) return;
    target.lastUsedAt = this.now();
    this.write(botId, recipes);
  }

  forget(botId: string, recipeId: string): boolean {
    const { recipes } = this.read(botId);
    const remaining = recipes.filter((recipe) => recipe.id !== recipeId);
    if (remaining.length === recipes.length) return false;
    this.write(botId, remaining);
    return true;
  }

  private path(botId: string): string {
    return join(this.folder(botId), FILE_NAME);
  }

  private read(botId: string): { recipes: Recipe[] } {
    if (!safeBotId(botId)) return { recipes: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path(botId), "utf8"));
    } catch {
      return { recipes: [] };
    }
    if (typeof parsed !== "object" || parsed === null) return { recipes: [] };
    const { version, recipes } = parsed as { version?: unknown; recipes?: unknown };
    if (version !== VERSION || !Array.isArray(recipes)) return { recipes: [] };
    const cutoff = this.now() - UNUSED_MS;
    const valid: Recipe[] = [];
    for (const raw of recipes) {
      const result = recipeSchema.safeParse(raw);
      if (result.success && result.data.lastUsedAt >= cutoff) valid.push(result.data as Recipe);
    }
    return { recipes: valid };
  }

  private write(botId: string, recipes: Recipe[]): void {
    if (!safeBotId(botId)) return;
    const folder = this.folder(botId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path(botId), JSON.stringify({ version: VERSION, recipes }), { mode: 0o600 });
  }
}
