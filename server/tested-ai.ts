// Test before trusting: a new bot's default is an AI that answered one tiny test message whenever any AI did.
//
// Nothing waits for a test. The default is chosen by ranking at once (shared/ai-ranking.ts); the person's own AIs are
// tested in the background in the order the default takes them, one at a time, stopping at the first that answers. One
// miss demotes nothing: that AI is tried again in two minutes, and only two misses in a row count as "didn't answer"
// (selectDefaultModelSelection's `answered`), when the default moves to the best AI that did; a failed AI is tried once
// more ten minutes later. Results are kept for a day per instance and sign-in, so a start or a settings save doesn't send
// another test message.
//
// The first bot the app made follows the default (the `follower`, kept with the results) until the person writes to it
// or chooses a model for it or one of its conversations. It moves only after a test result, only to an AI that answered,
// and only away from one that didn't answer or up to a better one: a status read alone never moves it. A saved default
// (Settings, `openmausbot setup`, the New Bot defaults) or a hosted workspace's is never tested here and never moves.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { aiSignInKey, rankAis, type AiTestState } from "../shared/ai-ranking.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { readyToRun, signedOut, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import { checkEngine, type CheckableEngine, type EngineCheck } from "./engine-check.ts";
import type { Store } from "./store.ts";

export interface TestedAiDeps {
  /** The live engine a test message goes through. */
  engine(instanceId: string): CheckableEngine | null;
  /** The defaults the person saved: the default model and the New Bot defaults' model. */
  saved(): ReadonlyArray<ModelSelection | undefined>;
  /** A hosted workspace's models: its default is not the app's to choose either. */
  hosted?(): boolean;
  context: DefaultSelectionContext;
  store(): Pick<Store, "bots" | "bot" | "tasks" | "messagesFor" | "applyModelDefault" | "needsSeed" | "seedIfEmpty" | "onChange">;
  threadBusy(botId: string, threadId: string): boolean;
  /** The selection the first bot gets when it follows the default: the new-bot effort added. */
  forBot(selection: ModelSelection): ModelSelection;
  /** A test finished or a retry is due: the server reads the engines and the default again, which settles here. */
  changed(): Promise<unknown> | void;
  /** The engine's own settings (configIdentity): a changed key is a new sign-in. */
  identity?(instanceId: string): string;
  /** Where the results and the follower are kept; none keeps them in memory. */
  file?: string;
  /** Whether tests start on their own (backgroundAiChecks); a check asked for always runs. */
  background?: boolean;
  timeoutMs?: number;
  now?(): number;
  after?(ms: number, run: () => void): { cancel(): void };
}

/** A status read that drops the account now and then looks like a new sign-in each time: a new sign-in is tested in the
 * background at most this often per AI, so it never sends a stream of test messages. A check asked for is not held back. */
const BACKGROUND_SPACING_MS = 5 * 60_000;
/** After the first miss, then after the second; then once an hour, so a used-up limit or an outage doesn't hold an AI back
 * for a day. */
const RETRY_AFTER_MS = [2 * 60_000, 10 * 60_000] as const;
const SLOW_RETRY_MS = 60 * 60_000;
/** Two misses in a row: the AI didn't answer. */
const MISSES_TO_FAIL = 2;
const RESULT_TTL_MS = 24 * 60 * 60_000;

/** On unless OMB_AI_CHECKS=0. Under vitest or a sealed test fixture (env-path.ts) only with OMB_AI_CHECKS=1, as
 * local-inject's probe: a fake engine's turn log then holds only the turns a test sends. */
export function backgroundAiChecks(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OMB_AI_CHECKS?.trim();
  if (flag === "0") return false;
  return (env.VITEST !== "true" && env.OMB_TEST_SEALED_PATH !== "1") || flag === "1";
}

/** What makes an engine sign in: its driver, settings and environment (keys among them), never its name or icon. Kept as a
 * short hash next to config.json, which holds the same keys in full. */
export function configIdentity(entry: { driver?: unknown; config?: unknown; environment?: unknown } | undefined): string {
  return createHash("sha256").update(JSON.stringify([entry?.driver ?? null, entry?.config ?? null, entry?.environment ?? null]))
    .digest("hex").slice(0, 16);
}

type Subject = { instanceId: string; snapshot: ProviderSnapshot };
type Result = { key: string; state: "passed" | "failed" | "untestable"; misses: number; at: number; error?: string; retryAt?: number };
type Follower = { botId: string; selection: ModelSelection };
type Saved = { results: Record<string, Result>; follower?: Follower };

const same = (a: ModelSelection, b: ModelSelection) => a.instanceId === b.instanceId && a.model === b.model;
const exactly = (a: ModelSelection, b: ModelSelection) => same(a, b) && a.effort === b.effort && a.variant === b.variant;
const empty = (selection: ModelSelection | undefined) => !selection?.instanceId && !selection?.model;
const hasModel = (instance: SelectableInstance) =>
  Boolean(instance.models.default.trim() || instance.models.options.some((option) => option.id.trim()));

function load(file: string | undefined, now: number): Saved {
  if (!file) return { results: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
    const results: Record<string, Result> = {};
    for (const [id, result] of Object.entries(raw.results && typeof raw.results === "object" ? raw.results : {})) {
      if (result && typeof result.key === "string" && ["passed", "failed", "untestable"].includes(result.state)
        && typeof result.at === "number" && now - result.at < RESULT_TTL_MS) results[id] = result;
    }
    const follower = raw.follower && typeof raw.follower.botId === "string" && raw.follower.selection
      && typeof raw.follower.selection.instanceId === "string" && typeof raw.follower.selection.model === "string" ? raw.follower : undefined;
    return { results, ...(follower ? { follower } : {}) };
  } catch {
    return { results: {} };
  }
}

export function createTestedAi(deps: TestedAiDeps) {
  const background = deps.background ?? backgroundAiChecks();
  const now = deps.now ?? Date.now;
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const saved = load(deps.file, now());
  const running = new Map<string, { key: string; run: Promise<EngineCheck> }>();
  const startedAt = new Map<string, number>();
  const retries = new Map<string, { cancel(): void }>();
  let pending = 0;
  let issued = 0;
  let settledRead = 0;
  let lastSelection: ModelSelection | null = null;
  let lastInstances: readonly SelectableInstance[] = [];
  /** A result landed before any read of the engines settled (a later start reads them one at a time): the first bot
   * moves on it once one does, never on the last run's status. */
  let followOwed = false;
  let unsubscribe: (() => void) | null = null;

  const fixed = () => deps.hosted?.() === true || deps.saved().some((selection) => !empty(selection));
  const warn = (what: string, error: unknown) => console.warn(`[engines] ${what}: ${error instanceof Error ? error.message : String(error)}`);
  const keyOf = (subject: Subject) => `${aiSignInKey(subject.snapshot)}|${deps.identity?.(subject.instanceId) ?? ""}`;

  const save = () => {
    if (!deps.file) return;
    try {
      mkdirSync(dirname(deps.file), { recursive: true });
      writeFileAtomic(deps.file, JSON.stringify(saved), { mode: 0o600 });
    } catch (error) {
      warn("could not keep the AI test results", error);
    }
  };

  /** This AI's result as it is signed in now, if it is less than a day old. */
  const resultOf = (subject: Subject): Result | undefined => {
    const result = saved.results[subject.instanceId];
    return result && result.key === keyOf(subject) && now() - result.at < RESULT_TTL_MS ? result : undefined;
  };
  const state = (subject: Subject): AiTestState | undefined =>
    running.get(subject.instanceId)?.key === keyOf(subject) ? "testing" : resultOf(subject)?.state;
  /** For selectDefaultModelSelection: true it answered, false it missed twice in a row, undefined not known yet. A test
   * under way changes nothing until it ends, so the default never bounces back to an AI while it is tried again. */
  const answered = (subject: Subject): boolean | undefined => {
    const result = resultOf(subject);
    return result?.state === "passed" ? true : result?.state === "failed" && result.misses >= MISSES_TO_FAIL ? false : undefined;
  };

  const notify = () => {
    pending++;
    void Promise.resolve().then(deps.changed)
      .catch((error: unknown) => warn("reading the new-bot default again after a test message", error))
      .finally(() => { pending--; });
  };
  const arm = (instanceId: string, at: number) => {
    retries.get(instanceId)?.cancel();
    retries.set(instanceId, after(Math.max(0, at - now()), () => {
      retries.delete(instanceId);
      notify();
    }));
  };

  const record = (instanceId: string, key: string, check: EngineCheck) => {
    const previous = saved.results[instanceId]?.key === key ? saved.results[instanceId] : undefined;
    if (check.ok === false) {
      const misses = (previous?.state === "failed" ? previous.misses : 0) + 1;
      const delay = RETRY_AFTER_MS[misses - 1] ?? SLOW_RETRY_MS;
      saved.results[instanceId] = { key, state: "failed", misses, at: now(), error: check.error, retryAt: now() + delay };
      if (background) arm(instanceId, now() + delay);
    } else {
      retries.get(instanceId)?.cancel();
      saved.results[instanceId] = { key, state: check.ok ? "passed" : "untestable", misses: 0, at: now() };
    }
    save();
  };

  const clearFollower = () => {
    if (!saved.follower) return;
    delete saved.follower;
    save();
  };

  /** Only after a test result: to the default when that AI answered, away from one whose latest test missed or that is signed
   * out or turned off, or up to a better one. */
  const follow = () => {
    const follower = saved.follower;
    const target = lastSelection;
    if (follower && !target) followOwed = true;
    if (!follower || !target || empty(target) || fixed()) return;
    const store = deps.store();
    const bot = store.bot(follower.botId);
    if (!bot || !exactly(bot.modelSelection, follower.selection)) return clearFollower();
    if (same(bot.modelSelection, target)) return;
    const to = lastInstances.find((instance) => instance.instanceId === target.instanceId);
    const from = lastInstances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
    if (!to || state(to) !== "passed" || !from) return;
    // Only a plain "signed out" or "turned off" counts as can't run: a status read that timed out says neither, and moves nothing.
    const leave = resultOf(from)?.state === "failed" || signedOut(from) || from.enabled === false;
    if (!leave && rankAis([from, to])[0] !== to) return;
    const tasks = store.tasks(bot.id);
    if (tasks.some((task) => task.modelSelection !== undefined)
      || tasks.some((task) => store.messagesFor(task.threadId).some((message) => message.role === "user"))) return clearFollower();
    if (tasks.some((task) => deps.threadBusy(bot.id, task.threadId))) return;
    saved.follower = { botId: bot.id, selection: structuredClone(deps.forBot(target)) };
    save();
    store.applyModelDefault(bot.id, saved.follower.selection);
  };

  /** A fresh test, or the one already under way for this sign-in. Every result reads the default again, then may move the
   * first bot. */
  const test = (subject: Subject): Promise<EngineCheck> => {
    const engine = deps.engine(subject.instanceId);
    if (!engine) return Promise.resolve({ ok: null });
    const key = keyOf(subject);
    const current = running.get(subject.instanceId);
    if (current?.key === key) return current.run;
    const run = checkEngine(engine, deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs });
    const entry = { key, run };
    running.set(subject.instanceId, entry);
    pending++;
    void run.then(async (check) => {
      if (running.get(subject.instanceId) === entry) running.delete(subject.instanceId);
      record(subject.instanceId, key, check);
      try {
        await deps.changed();
        follow();
      } catch (error) {
        warn("reading the new-bot default again after a test message", error);
      } finally {
        pending--;
      }
    });
    return run;
  };

  /** The person's own AIs, in the default's order, one at a time; an organization's models and the trial credit are theirs
   * to look after. One miss waits for its retry; two hand over to the next AI. */
  const sweep = () => {
    if (!background || fixed()) return;
    const own = lastInstances.filter((instance) => readyToRun(instance, deps.context) && hasModel(instance)
      && deps.context.company?.(instance.instanceId) !== true);
    for (const instance of rankAis(own)) {
      if (running.has(instance.instanceId)) return;
      const result = resultOf(instance);
      if (!result) {
        if (now() - (startedAt.get(instance.instanceId) ?? -Infinity) >= BACKGROUND_SPACING_MS) {
          startedAt.set(instance.instanceId, now());
          void test(instance);
        }
        return;
      }
      if (result.state !== "failed") return;
      if (result.retryAt !== undefined && result.retryAt <= now()) {
        void test(instance);
        return;
      }
      if (result.misses < MISSES_TO_FAIL) return;
    }
  };

  /** The person writing to the first bot, or choosing its model or a conversation's, ends its following for good. */
  const listen = () => {
    if (unsubscribe) return;
    const store = deps.store();
    unsubscribe = store.onChange((change) => {
      const follower = saved.follower;
      if (!follower) return;
      if (change.type === "bot.deleted" && change.botId === follower.botId) return clearFollower();
      if (change.type === "message") {
        if (change.message.role === "user" && store.tasks(follower.botId).some((task) => task.threadId === change.threadId)) clearFollower();
        return;
      }
      if (change.type !== "bot" || change.botId !== follower.botId) return;
      const bot = store.bot(follower.botId);
      if (!bot) return;
      if (store.tasks(bot.id).some((task) => task.modelSelection !== undefined)) return clearFollower();
      if (exactly(bot.modelSelection, follower.selection)) return;
      // A first bot made before any AI could run gets the default from the app once one can: that is still the app's pick.
      if (empty(follower.selection) && lastSelection && same(bot.modelSelection, lastSelection)) {
        saved.follower = { botId: bot.id, selection: structuredClone(bot.modelSelection) };
        save();
        return;
      }
      clearFollower();
    });
  };

  if (background) {
    for (const [instanceId, result] of Object.entries(saved.results)) if (result.retryAt !== undefined && result.retryAt > now()) arm(instanceId, result.retryAt);
  }

  return {
    /** Taken before the engines are read: only the latest read may settle anything (settle's `read`). */
    read(): number {
      return ++issued;
    },
    /** The default the server just chose for new bots: tests start from it. A read older than one already settled changes
     * nothing and gets the newer default back. */
    settle(selection: ModelSelection, instances: readonly SelectableInstance[], read = ++issued): ModelSelection {
      if (read < settledRead) return lastSelection ?? selection;
      settledRead = read;
      lastSelection = selection;
      lastInstances = instances;
      sweep();
      if (followOwed) {
        followOwed = false;
        follow();
      }
      return selection;
    },
    /** Replaces store.seedIfEmpty at start: the bot it makes follows the default. */
    seed(options?: Parameters<Store["seedIfEmpty"]>[0]): void {
      const store = deps.store();
      const first = store.needsSeed();
      store.seedIfEmpty(options);
      listen();
      const bot = first ? store.bots.find((candidate) => candidate.chiefOfStaff) ?? store.bots[0] : undefined;
      if (!bot) return;
      saved.follower = { botId: bot.id, selection: structuredClone(bot.modelSelection) };
      save();
    },
    answered,
    state,
    /** The instance info's fields the welcome reads. */
    info(instance: Subject): { aiTest?: AiTestState; aiTestError?: string } {
      const result = state(instance);
      const error = result === "failed" ? resultOf(instance)?.error : undefined;
      return result ? { aiTest: result, ...(error ? { aiTestError: error } : {}) } : {};
    },
    /** POST /api/instances/:id/check: live, as setup's check always was, sharing only a test already under way. */
    async check(instance: CheckableEngine & { snapshot(): Promise<ProviderSnapshot> }): Promise<EngineCheck> {
      return test({ instanceId: instance.instanceId, snapshot: await instance.snapshot() });
    },
    /** A test or what follows from its result is still under way. */
    testing(): boolean {
      return pending > 0;
    },
  };
}

export type TestedAi = ReturnType<typeof createTestedAi>;
