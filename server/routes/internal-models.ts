import type { ModelSelection } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Per engine without `search`, as in t3code's orchestrator_capabilities: one call lands whole in the bot's context. */
export const MENU_SHORT = 8;
/** An engine with this many models or fewer is listed whole: "more: 2" would cost as much as the two ids. */
export const MENU_WHOLE = 12;
/** Models across all engines for one `search`. */
export const MENU_FOUND = 20;
/** Refusals in a row that end an engine's scan: with nothing listed yet the engine is unusable, else the rest is left to search. */
const MENU_CHECKS = 3;
export const SEARCH_MAX_CHARS = 200;

/** One live engine as the registry holds it in memory: list_models probes no engine. */
export interface MenuEngine {
  instanceId: string;
  driverKind: string;
  displayName: string | undefined;
  models: { default: string; options: ReadonlyArray<{ id: string; label: string; orgBlocked?: true }> };
  adapter: { capabilities: { effortLevels?: readonly string[] } };
}

/** An id alone when its label only restates it. */
export type MenuModel = string | { id: string; label: string };

export interface MenuRow {
  instanceId: string;
  name: string;
  models?: MenuModel[];
  /** Matching models not listed: `search` finds them. */
  more?: number;
  efforts?: readonly string[];
  /** Why no thread can run on this engine now; it then lists no models. */
  unusable?: string;
}

export interface ModelMenu {
  current: ModelSelection;
  engines: MenuRow[];
  /** Engines that can't run anything now (not set up, turned off, unreachable), by name: a row each would cost more than they say. */
  unavailable?: string[];
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The engines and models a bot may open a thread of its own on. `refusal` is the check start_thread applies, so a listed
 * model always opens; the current model, then `pinned` ones, lead their engine's list. */
export function modelMenu(input: {
  engines: readonly MenuEngine[];
  current: ModelSelection;
  pinned: readonly ModelSelection[];
  refusal(selection: ModelSelection): string | null;
  down(engine: MenuEngine): boolean;
  search?: string;
}): ModelMenu {
  const terms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  let room = MENU_FOUND;
  const engines: MenuRow[] = [], unavailable: string[] = [];
  for (const engine of input.engines) {
    const { instanceId } = engine;
    const name = engine.displayName || engine.driverKind;
    const labels = new Map(engine.models.options.filter((option) => !option.orgBlocked).map((option) => [option.id, option.label]));
    const ids = [...new Set([...[input.current, ...input.pinned].filter((pin) => pin.instanceId === instanceId).map((pin) => pin.model), engine.models.default, ...labels.keys()])]
      .filter(Boolean);
    const matching = terms.length ? ids.filter((id) => terms.every((term) => `${name} ${id} ${labels.get(id) ?? ""}`.toLowerCase().includes(term))) : ids;
    if (!matching.length && !(terms.length && terms.every((term) => name.toLowerCase().includes(term)))) continue;
    if (input.down(engine)) {
      unavailable.push(name);
      continue;
    }
    if (!matching.length) continue;
    const cap = terms.length ? room : matching.length <= MENU_WHOLE ? matching.length : MENU_SHORT;
    const listed: string[] = [];
    let examined = 0, refusedInRow = 0, why: string | null = null;
    for (const id of matching) {
      if (listed.length >= cap) break;
      examined += 1;
      const refused = input.refusal({ instanceId, model: id });
      if (!refused) {
        listed.push(id);
        refusedInRow = 0;
        continue;
      }
      why ??= refused;
      if (++refusedInRow >= MENU_CHECKS) break;
    }
    const more = matching.length - examined;
    if (!listed.length && why) {
      engines.push({ instanceId, name, unusable: why });
      continue;
    }
    room -= listed.length;
    const efforts = engine.adapter.capabilities.effortLevels ?? [];
    engines.push({
      instanceId, name,
      ...(listed.length ? { models: listed.map((id): MenuModel => {
        const label = labels.get(id);
        return label && !squash(id).includes(squash(label)) ? { id, label } : id;
      }) } : {}),
      ...(more > 0 ? { more } : {}),
      ...(efforts.length ? { efforts } : {}),
    });
  }
  return { current: input.current, engines, ...(unavailable.length ? { unavailable } : {}) };
}

/** Only dispatch inside the internal capability gate: the menu is the calling bot's own. */
export function createInternalModelRoutes(deps: {
  requireActive(): void;
  menu(search: string | undefined): ModelMenu | null;
}): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (method !== "GET" || path !== "/api/internal/models") return PASS;
    deps.requireActive();
    const menu = deps.menu(url.searchParams.get("search")?.trim().slice(0, SEARCH_MAX_CHARS) || undefined);
    return menu ? json(res, 200, menu) : json(res, 404, { error: "This bot no longer exists." });
  };
}
