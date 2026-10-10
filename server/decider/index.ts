// The decision model: a fast classifier that picks among options OpenMausBot
// already knows (which bot answers a room message, and later which element
// to click or which tools to mount) in a few hundred milliseconds, before
// any engine turn starts. It never does the work itself.
//
// Modelled on server/tts/index.ts: a key-free status for Settings, a key
// check, and one module per vendor behind a common shape, so another backend
// (a local Jev-compatible server through `baseUrl`, an LLM) plugs in here
// without touching a caller.
//
// The contract every caller relies on: it NEVER throws into a turn. No key,
// the switch off, the job off, a timeout, an HTTP error, an overloaded
// vendor, a malformed answer: each comes back as { ok: false, reason } and
// the caller does exactly what it did before this module existed.
//
// On a Cloud Pro home, decisions are included: with no Jev key of the
// person's own, the Admin's relay token (included-services.ts) is used, only
// ever with the relay's URL and only for the requests the relay accepts
// (relay.ts), and the switch counts as on until turned off.
import type { AppConfig } from "../config.ts";
import { deciderCredential, type ServiceCredential } from "../included-services.ts";
import { jevBackend } from "./jev.ts";
import { appendDeciderLog, stateHash } from "./log.ts";
import { KEY_CHECK_QUESTION, KEY_CHECK_STATE, relayAccepts, relaySeam } from "./relay.ts";
import type {
  Answers, AskOptions, BackendResult, ChoiceAnswer, ChoiceQuestion, DeciderBackend, DeciderFailure, DeciderJob,
  DeciderProvider, DeciderQuestion, DeciderResult, DeciderSeam, ScoreAnswer, YesNoAnswer,
} from "./types.ts";

export { DECIDER_JOBS } from "./types.ts";

/** Used when a caller passes no timeout. Room routing passes its own. */
export const DEFAULT_DECIDER_TIMEOUT_MS = 1_500;
/** The Settings key check is one tiny call a person is waiting on. */
export const KEY_CHECK_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;

/** A request the switches never let through. */
const offBackend: { id: "off"; decide(): Promise<BackendResult> } = {
  id: "off",
  decide: async () => ({ ok: false, reason: "disabled" }),
};
const BACKENDS: Record<DeciderProvider, DeciderBackend> = { jev: jevBackend };

type DeciderConfig = NonNullable<AppConfig["decider"]>;

export function deciderProvider(cfg: AppConfig): DeciderProvider | "off" {
  const provider = cfg.decider?.provider ?? "jev";
  return provider in BACKENDS ? (provider as DeciderProvider) : "off";
}

/** The key a call uses and the one base URL it goes to: the person's own
 * (a draft being tested, else the config value or the desktop's encrypted
 * store handed over as env) with `decider.baseUrl` or Jev's own, else Cloud
 * Pro's included token with the Admin's relay, but only where the relay
 * accepts that seam: any other job has only an own key. Resolved on every
 * call. */
function deciderAccount(cfg: AppConfig, seam?: DeciderSeam, draft?: string): ServiceCredential | null {
  const account = deciderCredential(draft?.trim() || cfg.decider?.key, cfg.decider?.baseUrl);
  return account?.included && seam && !relaySeam(seam) ? null : account;
}

/** A key is on file, or Cloud Pro includes decisions here. */
export function deciderConfigured(cfg: AppConfig): boolean {
  return Boolean(deciderAccount(cfg));
}

/** Cloud Pro includes decisions on this machine, whatever key is saved:
 * what clearing an own key falls back to. */
export function deciderIncludedHere(): boolean {
  return deciderCredential(undefined, undefined)?.included === true;
}

/** The master switch as it takes effect: off while there is no key. With an
 * own key it is on once switched on (saving the key does that); with Cloud
 * Pro's included decisions it is on until someone switches it off. */
export function deciderEnabled(cfg: AppConfig): boolean {
  const account = deciderAccount(cfg);
  if (!account || deciderProvider(cfg) === "off") return false;
  return account.included ? cfg.decider?.enabled !== false : cfg.decider?.enabled === true;
}

/** One job's own switch. Absent means on: turning the decider on turns on
 * what it decides unless a job was switched off by hand. */
export function deciderJobOn(cfg: AppConfig, job: DeciderJob): boolean {
  return cfg.decider?.jobs?.[job] !== false;
}

/** Whether a job would be asked right now. Callers check this before they
 * spend any effort building a request. */
export function deciderReady(cfg: AppConfig, job: DeciderJob): boolean {
  return deciderEnabled(cfg) && deciderJobOn(cfg, job) && Boolean(deciderAccount(cfg, job));
}

/** What Settings needs. Never the key, and not the base URL either: that is
 * an operator setting with no UI. `included`: the decisions are Cloud Pro's,
 * not a saved key. */
export function describeDecider(cfg: AppConfig) {
  const account = deciderAccount(cfg);
  return {
    provider: "jev" as const,
    configured: Boolean(account),
    ...(account?.included ? { included: true as const } : {}),
    enabled: deciderEnabled(cfg),
    jobs: { roomRouting: deciderJobOn(cfg, "roomRouting") },
  };
}

/** The config write a Settings save becomes.
 *
 * Owner rule: the switch is off while no key is saved, and saving a key is
 * the "turn it on" — it switches the decider and its room job on, with no
 * extra step. Clearing the key switches it off, unless Cloud Pro includes
 * decisions here (`included`): then it falls back to them as it stands.
 * Explicit values in the same patch win. Jobs merge per job, because
 * saveConfig replaces a section's nested objects whole. Returns an error for
 * a switch-on with no key and nothing included. */
export function deciderSavePatch(
  patch: Partial<DeciderConfig>,
  current: DeciderConfig | undefined,
  included = false,
): { ok: true; patch: Partial<DeciderConfig> } | { ok: false; error: string } {
  const next: Partial<DeciderConfig> = { ...patch };
  const savingKey = typeof patch.key === "string" && Boolean(patch.key.trim());
  const clearingKey = typeof patch.key === "string" && !patch.key.trim();
  if (typeof patch.key === "string") next.key = patch.key.trim();
  if (savingKey) {
    next.enabled = patch.enabled ?? true;
    next.jobs = { ...current?.jobs, roomRouting: true, ...patch.jobs };
  } else if (clearingKey) {
    if (!included) next.enabled = false;
  } else if (patch.jobs) {
    next.jobs = { ...current?.jobs, ...patch.jobs };
  }
  if (next.enabled === true && !savingKey && !current?.key?.trim() && !included) {
    return { ok: false, error: "Save a Jev API key before turning on fast decisions." };
  }
  return { ok: true, patch: next };
}

export interface DeciderDeps {
  /** Read on every call, so a Settings change applies to the next decision. */
  config(): AppConfig;
  /** Tests pass a mock; production uses the global fetch. */
  fetch?: typeof fetch;
  /** Where the decision log goes. Omitted: nothing is logged. */
  dataDir?: string;
  now?: () => number;
}

export interface Decider {
  ask<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    state: unknown,
    questions: Qs,
    options?: AskOptions,
  ): Promise<DeciderResult<Answers<Qs>>>;
  choose<K extends string>(
    seam: DeciderSeam,
    state: unknown,
    question: { instructions: string; options: Record<K, string> },
    options?: AskOptions,
  ): Promise<DeciderResult<ChoiceAnswer<K>>>;
  score(
    seam: DeciderSeam,
    state: unknown,
    question: { instructions: string; levels: string[] },
    options?: AskOptions,
  ): Promise<DeciderResult<ScoreAnswer>>;
  yesNo(seam: DeciderSeam, state: unknown, instructions: string, options?: AskOptions): Promise<DeciderResult<YesNoAnswer>>;
  /** One tiny yes/no call with a draft key or the saved one (with neither,
   * Cloud Pro's included decisions through the relay), whatever the switches
   * say: the Settings Test button, and the check on save. */
  testKey(input?: { key?: string }, options?: AskOptions): Promise<DeciderResult<YesNoAnswer>>;
}

export function createDecider(deps: DeciderDeps): Decider {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());

  function gate(cfg: AppConfig, seam: DeciderSeam): DeciderFailure | null {
    if (deciderProvider(cfg) === "off") return "disabled";
    if (seam === "keyCheck") return null;
    if (!deciderConfigured(cfg)) return cfg.decider?.enabled === true ? "no_key" : "disabled";
    if (!deciderEnabled(cfg)) return "disabled";
    if (!deciderJobOn(cfg, seam)) return "job_off";
    // Only the included token, and the relay does not take this job.
    if (!deciderAccount(cfg, seam)) return "no_key";
    return null;
  }

  async function call<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    backend: DeciderBackend | typeof offBackend,
    request: { key: string; baseUrl?: string; state: unknown; questions: Qs },
    options: AskOptions,
  ): Promise<DeciderResult<Answers<Qs>>> {
    const provider = backend.id === "off" ? undefined : backend.id;
    if (options.signal?.aborted) return { ok: false, ...(provider ? { provider } : {}), reason: "cancelled" };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_DECIDER_TIMEOUT_MS));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race, not only the abort, bounds the call: a body that stalls
    // after its headers must not hold a room turn past the budget.
    const timedOut = new Promise<BackendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
    const started = now();
    let outcome: BackendResult;
    try {
      const decided = Promise.resolve()
        .then(() => backend.decide({ ...request, signal: controller.signal, fetch: fetchImpl }))
        .catch((): BackendResult => ({ ok: false, reason: "malformed" }));
      outcome = await Promise.race([decided, timedOut]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    if (!outcome.ok && outcome.reason !== "timeout" && options.signal?.aborted) outcome = { ok: false, reason: "cancelled" };
    if (provider && deps.dataDir) {
      const first = outcome.ok ? Object.values(outcome.answers).find((answer) => answer.type === "choice") as ChoiceAnswer | undefined : undefined;
      appendDeciderLog(deps.dataDir, {
        at: new Date().toISOString(),
        seam,
        provider,
        ok: outcome.ok,
        ...(!outcome.ok ? { reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}) } : {}),
        ...(first ? { choice: first.choice } : {}),
        pTop: first?.pTop ?? null,
        margin: first?.margin ?? null,
        latencyMs,
        ...(outcome.ok && outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
        stateHash: stateHash(request.state),
      });
    }
    if (!outcome.ok) return { ok: false, ...(provider ? { provider } : {}), reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}), latencyMs };
    return {
      ok: true,
      provider: provider!,
      answers: outcome.answers as Answers<Qs>,
      latencyMs,
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
    };
  }

  async function ask<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    state: unknown,
    questions: Qs,
    options: AskOptions = {},
  ): Promise<DeciderResult<Answers<Qs>>> {
    try {
      const cfg = deps.config();
      const refused = gate(cfg, seam);
      if (refused) return { ok: false, reason: refused };
      const provider = deciderProvider(cfg);
      const backend = provider === "off" ? offBackend : BACKENDS[provider];
      const account = deciderAccount(cfg, seam)!;
      // Through the included token, only the exact requests the relay takes.
      if (account.included && !relayAccepts(seam, state, questions)) return { ok: false, reason: "misconfigured" };
      return await call(seam, backend, { key: account.token, baseUrl: account.api, state, questions }, options);
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }

  const single = <A>(result: DeciderResult<{ answer: A }>): DeciderResult<A> =>
    result.ok ? { ...result, answers: result.answers.answer } : result;

  return {
    ask,
    async choose<K extends string>(
      seam: DeciderSeam,
      state: unknown,
      question: { instructions: string; options: Record<K, string> },
      options?: AskOptions,
    ): Promise<DeciderResult<ChoiceAnswer<K>>> {
      const asked: { answer: ChoiceQuestion<K> } = { answer: { type: "choice", instructions: question.instructions, options: question.options } };
      return single(await ask(seam, state, asked, options)) as DeciderResult<ChoiceAnswer<K>>;
    },
    async score(seam, state, question, options) {
      return single(await ask(seam, state, { answer: { type: "score", instructions: question.instructions, levels: question.levels } }, options));
    },
    async yesNo(seam, state, instructions, options) {
      return single(await ask(seam, state, { answer: { type: "yesno", instructions } }, options));
    },
    async testKey(input = {}, options = {}) {
      try {
        const cfg = deps.config();
        // A draft or saved own key goes to Jev (or decider.baseUrl); with
        // neither, Cloud Pro's included token goes to its relay.
        const account = deciderAccount(cfg, "keyCheck", input.key);
        if (!account) return { ok: false, reason: "no_key" };
        const provider = deciderProvider(cfg);
        const backend = provider === "off" ? offBackend : BACKENDS[provider];
        const questions = { answer: { type: "yesno" as const, instructions: KEY_CHECK_QUESTION } };
        if (account.included && !relayAccepts("keyCheck", KEY_CHECK_STATE, questions)) return { ok: false, reason: "misconfigured" };
        return single(await call("keyCheck", backend, {
          key: account.token,
          baseUrl: account.api,
          state: KEY_CHECK_STATE,
          questions,
        }, { timeoutMs: KEY_CHECK_TIMEOUT_MS, ...options }));
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
  };
}
