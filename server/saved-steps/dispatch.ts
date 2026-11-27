import { allowsTool } from "../../shared/tool-scope.ts";
import { newId, type ProviderAdapter, type ProviderInstance, type RuntimeEvent, type SendTurnInput, type TurnStartResult } from "../contracts.ts";
import { createChatToolApproval } from "../drivers/chat-tool-approval.ts";
import { retriedTurnEvent, type RetriedTurn } from "../quick-model-fallback.ts";
import type { Message } from "../store.ts";
import type { LocalComputerSpec } from "./computer-client.ts";
import { requestKey } from "./key.ts";
import { declinedReply, fallbackNote, replayedReply, runSteps, type ReplayOutcome, type ReplayTurn } from "./replay.ts";
import type { ComputerCaller } from "./resolve.ts";
import { personTextRequest, recipeFitsRequest, stepLabel, type Recipe } from "./rules.ts";
import type { RecipeStore } from "./store.ts";

export interface EngineSlots { get(threadId: string): ProviderInstance | undefined; set(threadId: string, engine: ProviderInstance): void }
export interface ReplayRequest {
  botId: string;
  message: Message;
  /** The person's words this turn sends: several queued lines arrive as one turn, under the last line's message. */
  turnText: string;
  /** The person picked this computer as the bot's place, so its screen calls never stop to ask them first. */
  placePicked: boolean;
}
export interface DispatchDeps {
  recipes: Pick<RecipeStore, "find" | "forget">;
  enabled(): boolean;
  publish(event: RuntimeEvent): void;
  engines: EngineSlots;
  stopped(threadId: string): boolean;
  openCaller(computer: LocalComputerSpec, signal: AbortSignal): Promise<ComputerCaller & { close(): Promise<void> }>;
  /** Keeps the request from saving steps. A turn that begins with a replay starts from a screen the steps already changed;
   * a turn that sends more than the request's own line did work its words do not name.
   * False when the request cannot be marked, and then no replay runs. */
  taint(threadId: string): boolean;
  /** The engine never sees a replayed turn: what the turn would have handed it stays unreceived; the call returned hands it on if the AI takes over. */
  withholdHandoff(threadId: string): (turnId: string) => void;
  /** A replay answered without the engine, so the engine's session must learn that line and its reply from the conversation. */
  contextChanged(botId: string, threadId: string): void;
}

type Start = (input: SendTurnInput) => Promise<TurnStartResult>;
type Approval = ReturnType<typeof createChatToolApproval>;
type RunOutcome = ReplayOutcome | { kind: "error"; message: string };
type Failed = Extract<ReplayOutcome, { kind: "failed" }>;

interface Run extends RetriedTurn {
  turnId: string;
  threadId: string;
  botId: string;
  recipe: Recipe;
  engine: ProviderInstance;
  controller: AbortController;
  phase: "replay" | "fallback";
  finished: Promise<void>;
  handOn(turnId: string): void;
}

const STOPPED = { kind: "stopped" } as const satisfies ReplayOutcome;
const LOOKUPS = ["list_apps", "list_windows", "get_window_state"] as const;
const COMPUTER_SERVER = "computer";
const REMEMBERED_REPLIES = 256;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class SavedStepsDispatch {
  private readonly deps: DispatchDeps;
  private readonly runs = new Map<string, Run>();
  private readonly answered = new Map<string, { turnId: string; recipeId: string }>();
  private readonly unmarked = new Set<string>();
  private readonly replayable = new Map<string, { toolScope: unknown }>();

  constructor(deps: DispatchDeps) {
    this.deps = deps;
  }

  sendTurn(engine: ProviderInstance, request: ReplayRequest | null, input: SendTurnInput, start: Start): Promise<TurnStartResult> {
    this.runs.delete(input.threadId);
    this.replayable.delete(input.threadId);
    if (request && this.replayHolds(request, input)) {
      this.replayable.set(input.threadId, { toolScope: input.toolScope });
      while (this.replayable.size > REMEMBERED_REPLIES) this.replayable.delete(this.replayable.keys().next().value!);
    }
    if (request && request.turnText !== request.message.text) {
      if (!this.deps.taint(input.threadId)) this.unmarked.add(input.threadId);
      return start(input);
    }
    const computer = input.integrations?.localComputer;
    const recipe = request && computer ? this.recipeFor(request, input) : undefined;
    if (!request || !computer || !recipe || !this.deps.taint(input.threadId)) return start(input);
    const { threadId } = input;
    const run: Run = {
      turnId: newId(), threadId, botId: request.botId, recipe, engine, controller: new AbortController(), phase: "replay", finished: Promise.resolve(),
      handOn: this.deps.withholdHandoff(threadId),
    };
    const asked = new Set<string>();
    const approval = createChatToolApproval({
      signal: run.controller.signal,
      open: (ask) => {
        asked.add(ask.id);
        this.emit(run, {
          type: "request.opened", requestType: "permission", requestId: ask.id, tool: ask.tool, summary: ask.summary,
          approvalScope: "local-computer", allowSession: false,
        });
      },
      resolved: (ask, allowed, source) => this.emit(run, {
        type: "request.resolved", requestId: ask.id, behavior: allowed ? "allow" : "deny", source, approvalScope: "local-computer",
      }),
      openQuestion: () => {},
      resolvedQuestion: () => {},
    });
    this.runs.set(threadId, run);
    this.deps.engines.set(threadId, this.standIn(run, approval, asked));
    // After dispatch binds this turn id to the request, so no event of the replay comes before its turn is known.
    run.finished = new Promise((resolve) => {
      setImmediate(() => {
        this.replay(run, computer, input, start, approval).then(resolve, (error: unknown) => {
          console.warn(`saved steps on ${threadId} ended early: ${errorText(error)}`);
          run.controller.abort();
          if (this.runs.get(threadId) === run && run.phase === "replay") this.end(run, { kind: "error", message: errorText(error) });
          resolve();
        });
      });
    });
    return Promise.resolve({ turnId: run.turnId });
  }

  /** The bus's gate for adapter events: true when this took the AI's event for a replay it handed over. */
  take(event: RuntimeEvent): boolean {
    const run = this.runs.get(event.threadId);
    if (!run || run.phase !== "fallback") return false;
    const kept = retriedTurnEvent(run, event);
    if (kept === null) return false;
    if (kept === "dropped") return true;
    if (kept.type === "turn.completed") this.forgetRun(run);
    this.deps.publish(kept);
    return true;
  }

  /** True when a turn of the thread's ending request sent more than its line and could not be marked; it must not save. Taking it forgets it. */
  takeUnmarked(threadId: string): boolean {
    return this.unmarked.delete(threadId);
  }

  /** Whether the thread's latest turn met every condition for replaying this recipe, so "next time no AI" would hold. */
  wouldReplay(threadId: string, recipe: Recipe): boolean {
    const turn = this.replayable.get(threadId);
    return turn !== undefined && toolsAllowed(recipe, turn.toolScope);
  }

  /** True for the events of a replay still answering without the AI, its turn.completed included. */
  answering(event: RuntimeEvent): boolean {
    const run = this.runs.get(event.threadId);
    return run !== undefined && run.phase === "replay" && event.turnId === run.turnId;
  }

  /** The recipe that answered this turn with no AI. */
  replayed(threadId: string, turnId: string): string | undefined {
    const answer = this.answered.get(threadId);
    return answer?.turnId === turnId ? answer.recipeId : undefined;
  }

  private replayHolds(request: ReplayRequest, input: SendTurnInput): boolean {
    return this.deps.enabled() && input.approvalMode === "full" && input.integrations?.localComputer?.scope === "local-computer"
      && request.placePicked && personTextRequest(request.message) && request.turnText === request.message.text;
  }

  private recipeFor(request: ReplayRequest, input: SendTurnInput): Recipe | undefined {
    if (!this.replayHolds(request, input)) return undefined;
    const text = request.turnText;
    const recipe = this.deps.recipes.find(request.botId, requestKey(text));
    return recipe && recipeFitsRequest(recipe, text) && toolsAllowed(recipe, input.toolScope) ? recipe : undefined;
  }

  private standIn(run: Run, approval: Approval, asked: ReadonlySet<string>): ProviderInstance {
    const { adapter } = run.engine;
    const standIn: ProviderAdapter = {
      get provider() { return adapter.provider; },
      get capabilities() { return adapter.capabilities; },
      get cacheKeepWarm() { return adapter.cacheKeepWarm; },
      sendTurn: (input) => adapter.sendTurn(input),
      async interruptTurn(threadId, turnId) {
        if (run.phase === "fallback") return adapter.interruptTurn(threadId, turnId);
        run.controller.abort();
        await run.finished;
      },
      respondToRequest: async (threadId, requestId, decision) => (asked.has(requestId)
        ? approval.answer(requestId, decision.behavior, decision.message)
        : adapter.respondToRequest(threadId, requestId, decision)),
      steer: async () => "refused",
      hasSession: (threadId) => adapter.hasSession(threadId),
      stopAll: () => adapter.stopAll(),
      onEvent: (listener) => adapter.onEvent(listener),
    };
    return Object.create(run.engine, { adapter: { value: standIn } }) as ProviderInstance;
  }

  private async replay(run: Run, computer: LocalComputerSpec, input: SendTurnInput, start: Start, approval: Approval): Promise<void> {
    this.emit(run, { type: "turn.started" });
    const outcome = await this.runSteps(run, computer, approval);
    approval.close();
    if (outcome.kind === "failed") return this.fallBack(run, outcome, input, start);
    if (outcome.kind === "error") this.forget(run);
    this.end(run, outcome);
  }

  private async runSteps(run: Run, computer: LocalComputerSpec, approval: Approval): Promise<RunOutcome> {
    const { signal } = run.controller;
    if (signal.aborted) return STOPPED;
    let caller: Awaited<ReturnType<DispatchDeps["openCaller"]>>;
    try {
      caller = await this.deps.openCaller(computer, signal);
    } catch (error) {
      if (signal.aborted) return STOPPED;
      const [first] = run.recipe.steps;
      return { kind: "failed", done: 0, total: run.recipe.steps.length, tool: first!.tool, label: stepLabel(first!), error: errorText(error) };
    }
    try {
      return await runSteps(run.recipe, this.turn(run), { caller, approval, publish: this.deps.publish, signal });
    } catch (error) {
      return signal.aborted ? STOPPED : { kind: "error", message: errorText(error) };
    } finally {
      await caller.close().catch(() => {});
    }
  }

  private async fallBack(run: Run, failed: Failed, input: SendTurnInput, start: Start): Promise<void> {
    if (!failed.gate) this.forget(run);
    if (run.controller.signal.aborted || this.deps.stopped(run.threadId)) return this.end(run, STOPPED);
    this.deps.engines.set(run.threadId, run.engine);
    const note = fallbackNote(failed);
    const noted = (text: string) => `${text}\n\n${note}`;
    const handed = { ...input, text: noted(input.text), ...(input.recoveryText !== undefined ? { recoveryText: noted(input.recoveryText) } : {}) };
    run.phase = "fallback";
    run.handOn(run.turnId);
    let sent: TurnStartResult;
    try {
      sent = await start(handed);
    } catch (error) {
      if (this.runs.get(run.threadId) === run) this.end(run, { kind: "error", message: errorText(error) });
      return;
    }
    run.retryTurnId ??= sent.turnId;
    if (this.deps.stopped(run.threadId)) void run.engine.adapter.interruptTurn(run.threadId).catch(() => {});
  }

  private end(run: Run, outcome: Exclude<RunOutcome, Failed>): void {
    try {
      if (run.phase === "replay") this.markContextChanged(run);
      if (outcome.kind === "done") {
        this.answered.delete(run.threadId);
        this.answered.set(run.threadId, { turnId: run.turnId, recipeId: run.recipe.id });
        while (this.answered.size > REMEMBERED_REPLIES) this.answered.delete(this.answered.keys().next().value!);
        this.reply(run, replayedReply(run.recipe));
        this.emit(run, { type: "turn.completed", ok: true, stopReason: "end_turn" });
      } else if (outcome.kind === "declined") {
        this.reply(run, declinedReply(outcome));
        this.emit(run, { type: "turn.completed", ok: true, stopReason: "end_turn", denials: [`mcp__computer__${outcome.tool}`] });
      } else if (outcome.kind === "stopped") {
        this.emit(run, { type: "turn.completed", ok: false, stopReason: "interrupted" });
      } else {
        this.emit(run, { type: "runtime.error", message: outcome.message });
        this.emit(run, { type: "turn.completed", ok: false, stopReason: outcome.message });
      }
    } finally {
      this.forgetRun(run);
    }
  }

  private markContextChanged(run: Run): void {
    try {
      this.deps.contextChanged(run.botId, run.threadId);
    } catch (error) {
      console.warn(`saved steps on ${run.threadId}: the conversation was not marked for the engine to read again: ${errorText(error)}`);
    }
  }

  private forget(run: Run): void {
    try {
      this.deps.recipes.forget(run.botId, run.recipe.id);
    } catch (error) {
      console.warn(`saved steps ${run.recipe.id} for ${run.botId} not forgotten: ${errorText(error)}`);
    }
  }

  private forgetRun(run: Run): void {
    if (this.runs.get(run.threadId) === run) this.runs.delete(run.threadId);
  }

  private reply(run: Run, text: string): void {
    this.emit(run, { type: "item.completed", itemType: "assistant_text", itemId: newId(), text });
  }

  private turn(run: Run): ReplayTurn {
    return { threadId: run.threadId, turnId: run.turnId, provider: run.engine.driverKind, providerInstanceId: run.engine.instanceId };
  }

  private emit(run: Run, event: DistributiveOmit<RuntimeEvent, "eventId" | "createdAt" | "threadId" | "provider">): void {
    this.deps.publish({ eventId: newId(), createdAt: new Date().toISOString(), ...this.turn(run), ...event } as RuntimeEvent);
  }
}

function toolsAllowed(recipe: Recipe, toolScope: unknown): boolean {
  return [...LOOKUPS, ...recipe.steps.map((step) => step.tool)].every((name) => allowsTool(toolScope, { kind: "mcp", server: COMPUTER_SERVER, name }));
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
