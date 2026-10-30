// When the AI a bot runs on reaches its usage limit, or is signed out, the bot carries on with another AI the person has
// set up until that limit resets or the AI is signed in again, without anyone being asked, and the person hears it once
// for that stretch. What is held (an engine's limit on the reset clock, one model's own limit, a sign-in that expired)
// is saved, so every new turn and thread of every bot starts on the AI that carries on, a restart included.
import { readFileSync } from "node:fs";

import { approvalModeFor, modelSwitchNeedsAsk, type ApprovalMode } from "../../shared/approval-mode.ts";
import { writeFileAtomic } from "../atomic.ts";
import { recoveryCapabilityError } from "../automatic-recovery.ts";
import type { InstanceConfigMap, ProviderAdapter, RuntimeEvent } from "../contracts.ts";
import { readyToRun, selectDefaultModelSelection, type DefaultSelectionContext, type SelectableInstance } from "../default-model-selection.ts";
import { engineFailureKind } from "../drivers/engine-errors.ts";
import { classifyError } from "../drivers/retry.ts";
import { billsEachUse, failoverLine, limitBackupAllowed, signedOutLine, type LimitFailover } from "../limit-failover.ts";
import { LimitNotices, limitNoticeText, signedOutNoticeText } from "../limit-notices.ts";
import { UNNAMED_LIMIT_MS } from "../limit-resets.ts";
import type { ModelSelection } from "../../shared/wire.ts";

/** What a usage limit refused (the runtime error's `limit`): the account on that engine, one model's own window, or
 * one model's extra usage credits. */
export type LimitScope = "engine" | "model" | "credits";
/** Why another AI carries on: one of those limits, or the AI's sign-in expired. */
export type TakeoverScope = LimitScope | "signed-out";

/** A model's own limit holds that model at most this long before it is tried again, in case its window ended early. */
export const MODEL_HOLD_MS = 6 * 60 * 60_000;
/** A signed-out AI is tried again by a new turn no sooner than this after its last refusal, in case it signed in again
 * some way this server did not see; a finished sign-in in the app, or a turn on it that works, ends the hold at once. */
export const SIGNED_OUT_RECHECK_MS = UNNAMED_LIMIT_MS;
/** A sign-out's one notice stands until the AI is signed in again or works; past this it is said again. */
const SIGNED_OUT_STRETCH_MS = 30 * 24 * 60 * 60_000;

/** A model held by its own limit: until when, when the limit said it resets, and which limit it is. */
export interface ModelHold { until: number; resetsAt?: number; scope: "model" | "credits" }

export type TakeoverEngine = SelectableInstance & { displayName?: string; capabilities: ProviderAdapter["capabilities"] };
type Bot = { id: string; name: string };
/** A bot as one of its threads sees it: its approval level decides which AI it may move to by itself. */
type ThreadBot = Bot & Parameters<typeof approvalModeFor>[0];

export interface LimitTakeoverDeps {
  file: string;
  /** Where model holds and sign-outs are kept across restarts. */
  holdsFile?: string;
  /** Every engine here as last read: no probe, so a turn never waits on one. */
  engines(): TakeoverEngine[];
  configs(): InstanceConfigMap;
  context: DefaultSelectionContext;
  /** Until when this engine refuses work, or null. */
  blockedUntil(instanceId: string): number | null;
  /** When this engine's limit resets, when that is known. */
  resetAt?(instanceId: string): number | null;
  /** The backups the person chose for this bot, or for every bot. */
  chosen(botId: string): ModelSelection[];
  /** The backups a signed-out AI's turns go to, as for a turn its AI never started: the bot's own list, or the
   * installation's one backup while Automatic recovery is on. `chosen` when not given. */
  signedOutChosen?(botId: string): ModelSelection[];
  engineName(instanceId: string): string;
  tell(bot: Bot, text: string): void;
  /** A conversation moved off a limited or signed-out AI: it goes back once that ends. */
  record(failover: LimitFailover): void;
  /** OMB_QUOTA_SWITCH: off, nothing carries on by itself. */
  enabled?(): boolean;
  /** Where the AIs run, for the sign-out notice: "on the Cloud", "on this computer". */
  where?: string;
  /** The AI's status, as last read, says it is signed out. */
  signedOutNow?(instanceId: string): boolean;
  /** A sign-out was first noticed: what the app shows of that AI's sign-in is read again. */
  signedOutNoticed?(instanceId: string): void;
  now?(): number;
}

interface SavedHolds { models?: Record<string, ModelHold>; signedOut?: Record<string, number> }

/** A turn its AI stopped for want of a sign-in. ACP engines stop an account out of credit or with no active plan as
 * "auth_required" too; signing in again fixes neither, so those words are no sign-out. */
export function signedOutStop(stopReason: string | null | undefined, said: string | undefined): boolean {
  return stopReason === "auth_required" && !(said && (engineFailureKind(said) === "credits" || classifyError({ text: said }).reason === "quota"));
}
/** A row a conversation shows when its turn carried on elsewhere: `setup` marks the one signing in fixes. */
export interface CarriedOnRow { name: string; ok: boolean; setup?: boolean }

export function createLimitTakeover(deps: LimitTakeoverDeps) {
  const now = deps.now ?? Date.now;
  const notices = new LimitNotices(deps.file, now);
  const heldModels = new Map<string, ModelHold>();
  /** Each signed-out AI and when it last refused a turn for that. */
  const signedOut = new Map<string, number>();
  /** What each thread's turn said in its last setup error, until that turn ends. */
  const setupSaid = new Map<string, string>();
  const modelKey = (selection: ModelSelection) => `${selection.instanceId}\u0000${selection.model}`;
  const signedOutKey = (instanceId: string) => `signed-out\u0000${instanceId}`;
  const incidentKey = (botId: string) => `incident\u0000${botId}`;
  /** The notice and incident key of what refused: the account on an engine, a sign-in, or one model. */
  const limitedKey = (from: ModelSelection, scope: TakeoverScope) => scope === "engine" ? from.instanceId
    : scope === "signed-out" ? signedOutKey(from.instanceId) : modelKey(from);

  /** What a restart left held, without what has run out. */
  const load = (file: string): void => {
    let saved: SavedHolds;
    try { saved = JSON.parse(readFileSync(file, "utf8")) as SavedHolds; } catch { return; }
    for (const [key, hold] of Object.entries(saved?.models ?? {})) {
      if (Number.isFinite(hold?.until) && hold.until > now() && (hold.scope === "model" || hold.scope === "credits")) heldModels.set(key, hold);
    }
    for (const [instanceId, at] of Object.entries(saved?.signedOut ?? {})) {
      if (Number.isFinite(at) && at > now() - SIGNED_OUT_STRETCH_MS) signedOut.set(instanceId, at);
    }
  };
  if (deps.holdsFile) load(deps.holdsFile);

  const save = (): void => {
    if (!deps.holdsFile) return;
    const holds: SavedHolds = { models: Object.fromEntries(heldModels), signedOut: Object.fromEntries(signedOut) };
    try {
      writeFileAtomic(deps.holdsFile, JSON.stringify(holds), { mode: 0o600 });
    } catch (error) {
      console.error(`limit takeover: could not save holds: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const modelHeld = (selection: ModelSelection): ModelHold | null => {
    const held = heldModels.get(modelKey(selection));
    if (!held) return null;
    if (held.until > now()) return held;
    heldModels.delete(modelKey(selection));
    save();
    return null;
  };

  const holdModel = (selection: ModelSelection, scope: "model" | "credits", resetsAt?: number): void => {
    const at = now(), named = resetsAt !== undefined && resetsAt > at ? resetsAt : undefined;
    heldModels.set(modelKey(selection), { until: Math.min(named ?? at + UNNAMED_LIMIT_MS, at + MODEL_HOLD_MS), ...(named ? { resetsAt: named } : {}), scope });
    save();
  };

  /** A new turn on this AI goes to another one: it refused a sign-in within the re-check interval, or its status says
   * it is still signed out. */
  const signedOutHeld = (instanceId: string): boolean => {
    const at = signedOut.get(instanceId);
    return at !== undefined && (now() - at < SIGNED_OUT_RECHECK_MS || deps.signedOutNow?.(instanceId) === true);
  };

  const noteSignedOut = (instanceId: string): void => {
    const first = !signedOut.has(instanceId);
    signedOut.set(instanceId, now());
    save();
    if (first) deps.signedOutNoticed?.(instanceId);
  };

  /** The AI is signed in again, or a turn on it worked: every bot's next turn may use it, and its next sign-out is told. */
  const signedIn = (instanceId: string): void => {
    if (!signedOut.delete(instanceId)) return;
    save();
    notices.endedEverywhere(signedOutKey(instanceId));
  };

  const usable = (engines: TakeoverEngine[], current: TakeoverEngine, selection: ModelSelection, scope: TakeoverScope, approval?: ApprovalMode): boolean => {
    const engine = engines.find((candidate) => candidate.instanceId === selection.instanceId);
    if (!engine || !readyToRun(engine, deps.context) || deps.blockedUntil(engine.instanceId) !== null || modelHeld(selection) !== null) return false;
    if (engine.instanceId !== current.instanceId) {
      if (signedOutHeld(engine.instanceId)) return false;
      // Another sign-in to the same plan never carries a limit (that rotates accounts); it may stand in for one signed out.
      if (scope !== "signed-out" && !limitBackupAllowed(current, engine, deps.configs()[engine.instanceId])) return false;
      // The same rule as switching by hand: a level the other AI has no such mode for needs the person first.
      if (approval && modelSwitchNeedsAsk(approval, current.driverKind, engine.driverKind)) return false;
    }
    if (recoveryCapabilityError(current, engine)) return false;
    return engine.models.default === selection.model || engine.models.options.some((model) => model.id === selection.model);
  };

  /** The AIs that may carry on while `from` is limited or signed out, best first: for one model's limit the same AI's own
   * default model, then the backups the person chose, then (for a limit) the AI MausBot would pick for a new bot among
   * the rest that draw on a plan. One that bills each use spends the person's money, so it carries on only as a backup
   * they chose; a signed-out AI's turns go only to a backup they chose. `approval`: the thread's level, when known. */
  function backups(botId: string, from: ModelSelection, scope: TakeoverScope = "engine", approval?: ApprovalMode): ModelSelection[] {
    const engines = deps.engines();
    const current = engines.find((engine) => engine.instanceId === from.instanceId);
    if (!current) return [];
    const out: ModelSelection[] = [];
    const add = (selection: ModelSelection) => {
      if (selection.instanceId === from.instanceId && (scope === "engine" || scope === "signed-out" || selection.model === from.model)) return;
      if (out.some((known) => known.instanceId === selection.instanceId && known.model === selection.model)) return;
      if (usable(engines, current, selection, scope, approval)) out.push({ instanceId: selection.instanceId, model: selection.model });
    };
    if (scope === "model" || scope === "credits") add({ instanceId: current.instanceId, model: current.models.default });
    for (const selection of scope === "signed-out" ? deps.signedOutChosen?.(botId) ?? deps.chosen(botId) : deps.chosen(botId)) add(selection);
    if (scope === "signed-out") return out;
    const others = engines.filter((engine) => engine.instanceId !== from.instanceId && engine.access !== "api" && !billsEachUse(deps.configs()[engine.instanceId])
      && usable(engines, current, { instanceId: engine.instanceId, model: engine.models.default }, scope, approval));
    const pick = selectDefaultModelSelection(others, undefined, deps.context);
    if (pick.instanceId && pick.model) add(pick);
    return out;
  }

  const label = (selection: ModelSelection, from: ModelSelection) => (selection.instanceId === from.instanceId
    ? `${deps.engineName(selection.instanceId)} ${selection.model}` : deps.engineName(selection.instanceId));
  /** What refused, as the person knows it: the AI, or for one model's own limit that AI's model. */
  const refusedName = (from: ModelSelection, scope: TakeoverScope) => (scope === "model" || scope === "credits"
    ? `${deps.engineName(from.instanceId)} ${from.model}` : deps.engineName(from.instanceId));

  /** Once for this stretch of `from`'s limit or sign-out: which AI carries on for `bot` meanwhile, or that it waits.
   * The words told, or null when this stretch was told already. */
  const tell = (bot: Bot, from: ModelSelection, facts: { resetsAt?: number; scope?: TakeoverScope; backup?: ModelSelection }): string | null => {
    const scope = facts.scope ?? "engine";
    const signOut = scope === "signed-out";
    if (!notices.first(bot.id, limitedKey(from, scope), signOut ? now() + SIGNED_OUT_STRETCH_MS : facts.resetsAt)) return null;
    const backup = facts.backup ? { backup: label(facts.backup, from) } : {};
    const text = signOut ? signedOutNoticeText({ engine: refusedName(from, scope), bot: bot.name, where: deps.where ?? "on this computer", ...backup })
      : limitNoticeText({ engine: refusedName(from, scope), bot: bot.name, ...(facts.resetsAt ? { resetsAt: facts.resetsAt } : {}), ...(scope === "credits" ? { credits: true } : {}), ...backup });
    deps.tell(bot, text);
    return text;
  };

  /** A conversation of `botId` moved from `from` to `to` because `from` was limited or signed out; it goes back once
   * that ends. */
  const moved = (botId: string, threadId: string, from: ModelSelection, to: ModelSelection, resetsAt?: number, scope?: TakeoverScope): void => {
    deps.record({ botId, threadId, from, to, resetsAt: resetsAt ?? null, at: now(), ...(scope === "signed-out" ? { why: "signed-out" as const } : {}) });
  };

  /** A turn on `selection` worked for this bot: its engine's next limit is a new stretch, and it is plainly signed in. */
  const worked = (botId: string, selection: ModelSelection): void => {
    for (const who of [botId, incidentKey(botId)]) {
      notices.ended(who, selection.instanceId);
      notices.ended(who, modelKey(selection));
    }
    if (heldModels.delete(modelKey(selection))) save();
    signedIn(selection.instanceId);
  };

  return {
    backups,
    /** This model alone, held by its own limit; null when it is not. */
    modelHeld,
    /** This model's own limit refused a turn: it is held until the reset the limit named, an hour when it named none,
     * and at most MODEL_HOLD_MS. */
    holdModel,
    /** The AI refused a turn because it is signed out. */
    noteSignedOut,
    signedIn,
    /** Whether a conversation moved off this signed-out AI waits before going back: until it is signed in again or a
     * turn on it works. */
    stillSignedOut: (instanceId: string): boolean => signedOut.has(instanceId),
    /** Before a turn on `selection`: what holds that AI, when another AI can take the turn instead, so it starts there
     * with no refused turn first. Null when nothing holds it, or when nothing could carry on and the AI is tried as
     * usual. `recovering`: Automatic recovery has backups of its own for a limit. */
    heldAtStart(bot: ThreadBot, selection: ModelSelection, recovering = false): { scope: TakeoverScope; resetsAt?: number } | null {
      const engineUntil = deps.blockedUntil(selection.instanceId);
      const model = engineUntil === null ? modelHeld(selection) : null;
      const scope: TakeoverScope | null = engineUntil !== null ? "engine" : model ? model.scope : signedOutHeld(selection.instanceId) ? "signed-out" : null;
      if (!scope) return null;
      const carries = (deps.enabled?.() ?? true) && backups(bot.id, selection, scope, approvalModeFor(bot)).length > 0;
      if (!carries && !(recovering && scope !== "signed-out")) return null;
      const resetsAt = scope === "engine" ? deps.resetAt?.(selection.instanceId) ?? undefined : model?.resetsAt;
      return { scope, ...(resetsAt && resetsAt > now() ? { resetsAt } : {}) };
    },
    /** Every runtime event of a bot's thread, with the model its turn ran on: a model's own limit holds that model, a
     * refused sign-in holds the AI, and a turn that works ends what held it. */
    noteRuntimeEvent(botId: string, selection: ModelSelection | undefined, event: RuntimeEvent): void {
      if (event.type === "runtime.error" && event.setup) setupSaid.set(event.threadId, event.message);
      const said = event.type === "turn.completed" || event.type === "session.exited" ? setupSaid.get(event.threadId) : undefined;
      if (said !== undefined) setupSaid.delete(event.threadId);
      if (!selection) return;
      if (event.type === "runtime.error" && (event.limit === "model" || event.limit === "credits")) holdModel(selection, event.limit, event.limitResetsAt);
      else if (event.type === "turn.completed" && event.ok) worked(botId, selection);
      else if (event.type === "turn.completed" && signedOutStop(event.stopReason, said)) noteSignedOut(selection.instanceId);
    },
    tell,
    moved,
    /** A turn refused at its start (a limit, or a sign-out) runs on `to` now: the conversation goes back once that ends,
     * the person hears it once, and these are the rows its conversation shows: one line, and for a sign-out told here,
     * the notice whose Sign in fixes it. */
    carriedOn(bot: Bot, threadId: string, from: ModelSelection, to: ModelSelection, facts: { scope: TakeoverScope; resetsAt?: number }): CarriedOnRow[] {
      moved(bot.id, threadId, from, to, facts.resetsAt, facts.scope);
      const told = tell(bot, from, { ...facts, backup: to });
      const line = facts.scope === "signed-out" ? signedOutLine(refusedName(from, facts.scope), label(to, from))
        : failoverLine(refusedName(from, facts.scope), label(to, from), facts.resetsAt);
      return [{ name: `recovery: ${line}`, ok: true }, ...(told && facts.scope === "signed-out" ? [{ name: `notice: ${told}`, ok: true, setup: true }] : [])];
    },
    /** True once per bot for each stretch of this limit or sign-out: the one incident its Chief is told about, not one per
     * refused turn. */
    firstIncident(botId: string, from: ModelSelection, scope: TakeoverScope = "engine", resetsAt?: number): boolean {
      return notices.first(incidentKey(botId), limitedKey(from, scope), scope === "signed-out" ? now() + SIGNED_OUT_STRETCH_MS : resetsAt);
    },
    worked,
  };
}

export type LimitTakeover = ReturnType<typeof createLimitTakeover>;
