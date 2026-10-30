// Which engine each bot runs on, on a Cloud home with the trial's Claude credit. While nothing of the person's own is
// signed in there, a bot on an engine that can't run (a copied bot's desktop engine, signed out here) runs on the credit,
// and where it came from is remembered under providers/, which never travels in a backup or a move. Once an engine of
// the person's own is signed in, every bot on the credit moves to it: back to the engine and model it came from when that
// one can run, otherwise to the new-bot default among the person's own engines.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, selectDefaultModelSelection, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import type { Store } from "./store.ts";

export interface CreditMovesOptions {
  credit: { owns(instanceId: string): boolean; status(): "active" | "used_up" | "ended"; storage(): string };
  store: Pick<Store, "bots" | "tasks" | "applyModelDefault" | "followBotModel" | "appendMessage">;
  context: DefaultSelectionContext;
  /** The saved new-bot defaults (the default model, the new-bot profile's model). */
  defaults(): Array<ModelSelection | undefined>;
  saveDefault(selection: ModelSelection): void;
  threadBusy(botId: string, threadId: string): boolean;
  engineName(instanceId: string): string;
  log?: (line: string) => void;
}

type Bot = CreditMovesOptions["store"]["bots"][number];
type Plan = { kind: "onto"; target: ModelSelection } | { kind: "off"; own: SelectableInstance[] } | null;

const FIELD = /^[\w.:/@+-]{1,200}$/;
const selection = (value: unknown): ModelSelection | null => {
  if (!value || typeof value !== "object") return null;
  const { instanceId, model, effort, variant } = value as Record<string, unknown>;
  if (typeof instanceId !== "string" || !FIELD.test(instanceId) || typeof model !== "string" || !FIELD.test(model)) return null;
  return { instanceId, model, ...(typeof effort === "string" && FIELD.test(effort) ? { effort: effort as ModelSelection["effort"] } : {}),
    ...(typeof variant === "string" && FIELD.test(variant) ? { variant } : {}) };
};

export function createCreditMoves(options: CreditMovesOptions) {
  const { credit, store, context } = options;
  const file = () => join(credit.storage(), "moved.json");
  const onCredit = (chosen?: ModelSelection) => Boolean(chosen && credit.owns(chosen.instanceId));

  function origins(): Map<string, ModelSelection> {
    try {
      const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
      return new Map(Object.entries(raw).flatMap(([botId, value]) => { const from = selection(value); return from ? [[botId, from] as const] : []; }));
    } catch {
      return new Map();
    }
  }
  function remember(moved: Map<string, ModelSelection>) {
    const kept = Object.fromEntries([...moved].filter(([botId]) => store.bots.some(bot => bot.id === botId)));
    try {
      writeFileAtomic(file(), JSON.stringify(kept), { mode: 0o600 });
    } catch (error) {
      options.log?.(`[trial credit] could not remember which engines bots came from (${error instanceof Error ? error.name : "error"})`);
    }
  }

  /** Engines of the person's own that are signed in for sure: one whose sign-in can't be read yet never takes the bots. */
  const signedIn = (instances: readonly SelectableInstance[]) => instances.filter(instance =>
    !context.company?.(instance.instanceId) && readyToRun(instance, context) && instance.snapshot.authenticated === true);

  function plan(instances: readonly SelectableInstance[]): Plan {
    const own = signedIn(instances);
    if (own.length) return { kind: "off", own };
    const engine = instances.find(instance => credit.owns(instance.instanceId));
    if (!engine || credit.status() !== "active" || !readyToRun(engine, context) || !engine.models.default) return null;
    return { kind: "onto", target: { instanceId: engine.instanceId, model: engine.models.default } };
  }

  /** On an engine this Cloud can't run: signed out, not installed, turned off, or not there at all (a desktop's own). */
  function stranded(chosen: ModelSelection | undefined, instances: readonly SelectableInstance[]): boolean {
    if (!chosen || (!chosen.instanceId && !chosen.model) || credit.owns(chosen.instanceId)) return false;
    const engine = instances.find(instance => instance.instanceId === chosen.instanceId);
    return !engine || !readyToRun(engine, context);
  }

  function onto(target: ModelSelection, instances: readonly SelectableInstance[]) {
    let moved: Map<string, ModelSelection> | undefined;
    let remembered = false;
    for (const bot of store.bots) {
      const tasks = store.tasks(bot.id);
      const threads = tasks.filter(task => task.modelSelection !== undefined && stranded(task.modelSelection, instances)).map(task => task.threadId);
      const own = stranded(bot.modelSelection, instances);
      if (!own && !threads.length) continue;
      if (tasks.some(task => options.threadBusy(bot.id, task.threadId))) continue;
      if (own) {
        moved ??= origins();
        if (!moved.has(bot.id)) { moved.set(bot.id, structuredClone(bot.modelSelection)); remembered = true; }
        store.applyModelDefault(bot.id, target);
      }
      if (threads.length) store.followBotModel(bot.id, threads);
    }
    if (remembered) remember(moved!);
  }

  function off(own: SelectableInstance[]) {
    const replacement = selectDefaultModelSelection(own, undefined, context);
    if (!replacement.instanceId) return;
    if (options.defaults().some(onCredit)) options.saveDefault(replacement);
    let moved: Map<string, ModelSelection> | undefined;
    let forgot = false;
    for (const bot of store.bots) {
      const tasks = store.tasks(bot.id);
      const moving = tasks.filter(task => onCredit(task.modelSelection ?? bot.modelSelection));
      if (!moving.length && !onCredit(bot.modelSelection)) continue;
      if (moving.some(task => options.threadBusy(bot.id, task.threadId))) continue;
      moved ??= origins();
      const from = moved.get(bot.id);
      const back = from ? selectDefaultModelSelection(own, from, context) : null;
      const next = back?.instanceId ? back : onCredit(bot.modelSelection) ? replacement : bot.modelSelection;
      if (onCredit(bot.modelSelection)) store.applyModelDefault(bot.id, next);
      const pinned = moving.filter(task => task.modelSelection !== undefined).map(task => task.threadId);
      if (pinned.length) store.followBotModel(bot.id, pinned);
      if (moved.delete(bot.id)) forgot = true;
      const notice = `notice: ${options.engineName(next.instanceId)} is connected, so this conversation uses it now instead of the trial Claude credit.`;
      for (const task of moving) store.appendMessage(task.threadId, { role: "bot", kind: "activity", tool: { name: notice, ok: true } });
    }
    if (forgot) remember(moved!);
  }

  return {
    /** Moves the bots onto the credit, or off it, as the engines read now say. */
    settle(instances: readonly SelectableInstance[]): void {
      const next = plan(instances);
      if (next?.kind === "onto") onto(next.target, instances);
      else if (next?.kind === "off") off(next.own);
    },
    /** Whether `settle` would move this bot, for this thread, by the engines' last known state: a send settles it first. */
    due(bot: Pick<Bot, "id" | "modelSelection">, threadId: string, instances: readonly SelectableInstance[]): boolean {
      const next = plan(instances);
      const chosen = store.tasks(bot.id).find(task => task.threadId === threadId)?.modelSelection ?? bot.modelSelection;
      if (next?.kind === "onto") return stranded(bot.modelSelection, instances) || stranded(chosen, instances);
      return next?.kind === "off" && onCredit(chosen);
    },
    /** The credit's default model changed (the Admin's list): bots and defaults on the old default follow it. */
    followDefault(from: string, to: string): void {
      const was = (chosen?: ModelSelection) => onCredit(chosen) && chosen!.model === from;
      const swap = (chosen: ModelSelection): ModelSelection => ({ instanceId: chosen.instanceId, model: to });
      const saved = options.defaults().find(was);
      if (saved) options.saveDefault(swap(saved));
      for (const bot of store.bots) {
        if (!was(bot.modelSelection)) continue;
        store.applyModelDefault(bot.id, swap(bot.modelSelection));
        const pinned = store.tasks(bot.id).filter(task => was(task.modelSelection)).map(task => task.threadId);
        if (pinned.length) store.followBotModel(bot.id, pinned);
      }
    },
  };
}

export type CreditMoves = ReturnType<typeof createCreditMoves>;
