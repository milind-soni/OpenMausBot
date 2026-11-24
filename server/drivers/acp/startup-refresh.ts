// Whether a turn waits for the model list an engine reads again at server start (startup-model-catalog.ts). Reading it
// can start a second engine process and walk every model's thinking levels; a turn that the saved list already serves
// goes ahead on it, and the list is read in the background.
//
// Adapted from pingdotgg/t3code@38067630229, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: apps/server/src/provider/Drivers/AntigravityDriver.ts keeps its model survey on
// a throwaway process at sign-in and on an explicit refresh, never awaited by a turn. Here the survey still runs at start
// when the saved list is old or from another build, but only a turn the saved list cannot serve waits for it; a turn
// that went ahead on the saved list never seeds the launch's default model from it, and a model the agent refuses then
// waits for the read and is tried once more.
import { boxMemory } from "../../box-memory.ts";
import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { engineMemory } from "../../engine-memory.ts";
import { roomBesideIdle } from "../session-idle.ts";

/** No memory gate (the desktop), or the room holds one more of the largest engines beside what runs now. */
export const roomForReadBeside = (): boolean => !engineMemory.enabled || roomBesideIdle(engineMemory.roomFactor(), boxMemory().bytes);

export interface StartupRefresh {
  /** The read is still under way and the saved list stands in for it: this turn does not wait. */
  standsIn(turn: SendTurnInput): boolean;
  /** Resolves when the read is over, whatever its outcome. */
  done(): Promise<void>;
  readonly pending: boolean;
}

export function startupRefresh(input: {
  /** The engine opts in (AcpSupport.modelListStandsIn): others keep waiting as before. */
  enabled: boolean;
  /** The read starts an engine process of its own that admission does not count: only stand in where that cannot crowd
   * the turn's own (no memory gate, or room for one more of the largest engines). */
  room: () => boolean;
  pending: Promise<void> | null;
  /** A saved list was put in place when the engine opened. */
  saved: () => boolean;
  catalog: () => ModelCatalog;
  normalize?: (turn: SendTurnInput, offered: readonly string[], catalog: ModelCatalog) => SendTurnInput;
}): StartupRefresh {
  let pending = input.pending !== null;
  const done = input.pending ? input.pending.then(() => { pending = false; }, () => { pending = false; }) : Promise.resolve();
  return {
    get pending() { return pending; },
    done: () => done,
    standsIn: (turn) => {
      if (!input.enabled || !pending || !input.saved() || !input.room()) return false;
      if (!turn.model) return true;
      const catalog = input.catalog();
      const ids = catalog.options.map((option) => option.id);
      const model = (input.normalize?.(turn, ids, catalog) ?? turn).model;
      return model !== undefined && ids.includes(model);
    },
  };
}

/** An agent's refusal of the model a turn asked for: the setter's invalid-params answer, or the driver's own check that
 * the session did not switch or does not list it. */
export function modelRefused(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : "";
  return /\bdid not switch to\b|\bdoes not advertise model\b|\bmodel not found\b|\bchanged model before the prompt\b/iu.test(message)
    || (value?.code === -32602 && /\bmodel\b/iu.test(message));
}
