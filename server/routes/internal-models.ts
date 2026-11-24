import { EFFORT_LEVELS, type ModelSelection } from "../../shared/wire.ts";
import type { EngineHint } from "../host/engine-hints.ts";
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
  models: { default: string; options: ReadonlyArray<{ id: string; label: string; orgBlocked?: true; needsCliUpdate?: string; effortLevels?: readonly string[] }> };
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
  /** How the person connects it again, when it is signed out. */
  connect?: string;
  /** Models the engine has but won't run until something changes, with what: the bot can say so instead of calling them gone. */
  blocked?: Array<{ id: string; why: string }>;
}

/** Engines that can't run now for the same reason, fixed the same way: one entry each would repeat the line. */
export type UnavailableGroup = { engines: string[] } & EngineHint;

export interface ModelMenu {
  current: ModelSelection;
  engines: MenuRow[];
  /** Engines that can't run anything now (not set up, turned off, unreachable), by why and how to connect. */
  unavailable?: UnavailableGroup[];
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The engines and models a bot may open a thread of its own on. `refusal` is the check start_thread applies, so a listed
 * model always opens; the current model, then `pinned` ones, lead their engine's list. */
export function modelMenu(input: {
  engines: readonly MenuEngine[];
  current: ModelSelection;
  pinned: readonly ModelSelection[];
  refusal(selection: ModelSelection): string | null;
  /** Why `engine` can't run now and how it is connected; null while it can. */
  down(engine: MenuEngine): EngineHint | null;
  /** A signed-out engine's hint: its row keeps start_thread's own refusal as the reason and adds how to connect. */
  signedOut?(engine: MenuEngine): EngineHint | null;
  /** Engines whose saved settings could not be read, with the same. */
  broken?: ReadonlyArray<{ name: string; hint: EngineHint }>;
  search?: string;
}): ModelMenu {
  const terms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  let room = MENU_FOUND;
  const engines: MenuRow[] = [], groups = new Map<string, UnavailableGroup>();
  const nameMatches = (name: string) => terms.every((term) => name.toLowerCase().includes(term));
  const unavailable = (name: string, hint: EngineHint) => {
    const key = `${hint.why}\n${hint.connect}`;
    const group = groups.get(key);
    if (group) group.engines.push(name);
    else groups.set(key, { engines: [name], ...hint });
  };
  for (const engine of input.engines) {
    const { instanceId } = engine;
    const name = engine.displayName || engine.driverKind;
    const labels = new Map(engine.models.options.filter((option) => !option.orgBlocked && !option.needsCliUpdate).map((option) => [option.id, option.label]));
    const ids = [...new Set([...[input.current, ...input.pinned].filter((pin) => pin.instanceId === instanceId).map((pin) => pin.model), engine.models.default, ...labels.keys()])]
      .filter(Boolean);
    const matches = (id: string, label = "") => terms.every((term) => `${name} ${id} ${label}`.toLowerCase().includes(term));
    const matching = ids.filter((id) => matches(id, labels.get(id)));
    const blocked = engine.models.options.filter((option) => (option.orgBlocked || option.needsCliUpdate) && matches(option.id, option.label)).slice(0, MENU_SHORT)
      .map((option) => ({ id: option.id, why: option.orgBlocked ? "turned off by this account's organization" : `needs ${name} CLI ${option.needsCliUpdate} or newer: update it` }));
    // An engine not set up often has no models to match yet: without a search it is still named, with why.
    if (!matching.length && !blocked.length && !nameMatches(name)) continue;
    const down = input.down(engine);
    if (down) {
      unavailable(name, down);
      continue;
    }
    if (!matching.length && !blocked.length) {
      // Signed out with no models to try: named with why, like an engine that is down.
      const signedOut = nameMatches(name) ? input.signedOut?.(engine) : null;
      if (signedOut) unavailable(name, signedOut);
      continue;
    }
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
      const connect = input.signedOut?.(engine)?.connect;
      engines.push({ instanceId, name, unusable: why, ...(connect ? { connect } : {}), ...(blocked.length ? { blocked } : {}) });
      continue;
    }
    room -= listed.length;
    const effortByModel = new Map(engine.models.options.map((option) => [option.id, option.effortLevels]));
    const fallbackEfforts = engine.adapter.capabilities.effortLevels ?? [];
    const seenEfforts = new Set<string>(
      listed.length ? listed.flatMap((id) => effortByModel.get(id) ?? fallbackEfforts) : fallbackEfforts,
    );
    const efforts = [...new Set([...EFFORT_LEVELS, ...fallbackEfforts])].filter((level) => seenEfforts.has(level));
    engines.push({
      instanceId, name,
      ...(listed.length ? { models: listed.map((id): MenuModel => {
        const label = labels.get(id);
        return label && !squash(id).includes(squash(label)) ? { id, label } : id;
      }) } : {}),
      ...(more > 0 ? { more } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(blocked.length ? { blocked } : {}),
    });
  }
  for (const { name, hint } of input.broken ?? []) if (nameMatches(name)) unavailable(name, hint);
  return { current: input.current, engines, ...(groups.size ? { unavailable: [...groups.values()] } : {}) };
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
