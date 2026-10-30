import { randomUUID } from "node:crypto";
import { botFolder } from "../bot-folder.ts";
import type { AppConfig } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { createComputerJournalRoutes } from "../routes/computer-journal.ts";
import { createSavedStepsRoutes } from "../routes/saved-steps.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { Message } from "../store.ts";
import { openComputerCaller } from "./computer-client.ts";
import { SavedStepsDispatch, type DispatchDeps, type EngineSlots } from "./dispatch.ts";
import { ComputerJournal, hostScope, type JournalCapability, type RequestJournal } from "./journal.ts";
import { buildRecipe, otherToolsHarmless, personTextRequest } from "./rules.ts";
import { RecipeStore } from "./store.ts";

export { COMPUTER_JOURNAL_PATH } from "./journal-tap.ts";

export interface SavedStepsDeps {
  enabled(): boolean;
  bot(id: string): unknown;
  publish(event: RuntimeEvent): void;
  engines: EngineSlots;
  stopped(threadId: string): boolean;
  generation(threadId: string): string | undefined;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): void;
  withholdHandoff: DispatchDeps["withholdHandoff"];
  contextChanged: DispatchDeps["contextChanged"];
  folder?: (botId: string) => string;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface SettledRequest {
  botId: string;
  threadId: string;
  request: Message;
  reply: Message;
  after: readonly Message[];
  generations: ReadonlySet<string>;
  automated: boolean;
}

/** `personLine`: the request began with the person's own line here, not work a peer handed on with the person's origin. */
export interface RequestOwner { automation?: unknown; origin?: { kind: string }; personLine?: boolean }

export const personRequest = (owner: RequestOwner): boolean => owner.automation === undefined && owner.origin?.kind === "user";

export interface SavedSteps {
  journal: ComputerJournal;
  recipes: RecipeStore;
  dispatch: SavedStepsDispatch;
  gateChecked(capability: JournalCapability): void;
  journals(owner: RequestOwner | undefined): boolean;
  /** Saved steps can run on this server (macOS only in v1), whatever the setting says; clients show the switch only then. */
  here(): boolean;
  routes: RouteHandler;
  journalRoutes(internal: { capability: JournalCapability; readBody(): Promise<unknown> }): RouteHandler;
  requestSettled(settled: SettledRequest): void;
  requestEnded(threadId: string, generations: ReadonlySet<string>): void;
  observe(event: RuntimeEvent): void;
}

export function savedStepsEnabled(cfg: Pick<AppConfig, "features">): boolean {
  return cfg.features?.savedSteps !== false;
}

const keepsFromSaving = (event: RuntimeEvent): boolean =>
  (event.type === "request.resolved" && event.behavior !== "allow") || (event.type === "turn.completed" && (event.denials?.length ?? 0) > 0);

export function createSavedSteps(deps: SavedStepsDeps): SavedSteps {
  const platform = deps.platform ?? process.platform;
  // Linux ships cua-driver 0.19.3 and Windows its 0.28.2 Rust build; neither is known to answer list_windows and elements_complete as replay needs.
  const enabled = () => platform === "darwin" && deps.enabled();
  const journal = new ComputerJournal();
  const now = deps.now ?? Date.now;
  const recipes = new RecipeStore({ folder: deps.folder ?? botFolder, now: deps.now });
  const taint = (threadId: string): boolean => {
    const generation = deps.generation(threadId);
    if (generation === undefined) return false;
    journal.taint({ threadId, generation });
    return true;
  };
  const dispatch = new SavedStepsDispatch({
    recipes,
    enabled,
    publish: deps.publish,
    engines: deps.engines,
    stopped: deps.stopped,
    openCaller: openComputerCaller,
    taint,
    withholdHandoff: deps.withholdHandoff,
    contextChanged: deps.contextChanged,
  });

  const markOrSave = ({ botId, threadId, request, reply, after, automated }: SettledRequest, taken: RequestJournal | null): void => {
    const replayed = reply.turnId === undefined ? undefined : dispatch.replayed(threadId, reply.turnId);
    if (replayed !== undefined) {
      recipes.touch(botId, replayed);
      if (request.quickModel !== undefined) deps.patchMessage(threadId, request.id, { quickModel: undefined });
      deps.patchMessage(threadId, reply.id, { savedSteps: { recipeId: replayed, replayed: true } });
      return;
    }
    if (!enabled() || automated || !taken?.calls.length || !personTextRequest(request) || after.some((line) => line.role === "user") || !otherToolsHarmless(after)) return;
    const built = buildRecipe({ request: request.text ?? "", journal: taken, id: randomUUID(), now: now() });
    if (!built.ok || !dispatch.wouldReplay(threadId, built.recipe)) return;
    recipes.save(botId, built.recipe);
    deps.patchMessage(threadId, reply.id, { savedSteps: { recipeId: built.recipe.id, learned: true } });
  };

  return {
    journal,
    recipes,
    dispatch,
    routes: createSavedStepsRoutes({ bot: deps.bot, forget: (botId, id) => recipes.forget(botId, id) }),
    gateChecked(capability) {
      const scope = hostScope(capability);
      if (scope) journal.gateChecked(scope);
      else if (capability.kind === "computer") journal.taint({ threadId: capability.threadId, generation: capability.generation });
    },
    journals: (owner) => owner?.personLine === true && personRequest(owner) && enabled(),
    here: () => platform === "darwin",
    journalRoutes: (internal) => createComputerJournalRoutes({ ...internal, enabled, record: (scope, entry) => journal.record(scope, entry) }),
    requestSettled(settled) {
      const taken = journal.take(settled.threadId, settled.generations);
      const unmarked = dispatch.takeUnmarked(settled.threadId);
      try {
        markOrSave(settled, unmarked ? null : taken);
      } catch (error) {
        console.warn(`saved steps for ${settled.botId} on ${settled.threadId} not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    requestEnded(threadId, generations) {
      journal.take(threadId, generations);
      dispatch.takeUnmarked(threadId);
    },
    observe(event) {
      if (keepsFromSaving(event)) taint(event.threadId);
    },
  };
}
