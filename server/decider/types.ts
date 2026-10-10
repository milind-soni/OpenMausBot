// The decision model's vocabulary, shared by every backend and caller. A
// question is one of three typed shapes; an answer comes back typed to match.
// Nothing here names a vendor: `jev` is one backend, and another (a local
// Jev-compatible server, an LLM) plugs in behind the same types.

export type DeciderProvider = "jev";

/** Jobs a person can switch on or off one by one in Settings. */
export type DeciderJob = "roomRouting";
export const DECIDER_JOBS: readonly DeciderJob[] = ["roomRouting"];

/** Where a decision is asked from: a job, or the Settings key check (which
 * runs whatever the switches say, because it tests the key itself). */
export type DeciderSeam = DeciderJob | "keyCheck";

/** Why no decision came back. Every one of these means "use today's rule". */
export type DeciderFailure =
  /** The master switch is off, or no backend is selected. */
  | "disabled"
  | "no_key"
  /** The master switch is on but this job is switched off. */
  | "job_off"
  /** The request could not be formed: a base URL that is neither https nor
   * loopback http, a question outside the backend's limits, or, through
   * Cloud Pro's included token, a request its relay does not accept. */
  | "misconfigured"
  | "timeout"
  /** The caller's own signal (a Stop) ended the wait. */
  | "cancelled"
  | "unreachable"
  /** 401 or 403: the key was refused. */
  | "rejected"
  /** 429 */
  | "rate_limited"
  /** 529 or 503 */
  | "overloaded"
  /** Any other non-2xx answer. */
  | "http_error"
  /** A body that is not JSON, a missing answer, a choice that was never
   * offered, a probability that is not a number. */
  | "malformed";

export interface ChoiceQuestion<K extends string = string> {
  type: "choice";
  instructions: string;
  /** Option key → what it means. Keys are what comes back in `choice`. */
  options: Record<K, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered levels, lowest first. */
  levels: string[];
}

export interface YesNoQuestion {
  type: "yesno";
  instructions: string;
  criteria?: { yes?: string; no?: string };
}

export type DeciderQuestion = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  choice: K;
  /** Probability of the chosen option. Thresholds go on this, never on a
   * vendor "confidence" field, whose scale depends on the option count. */
  pTop: number;
  /** pTop minus the runner-up's probability. */
  margin: number;
  probabilities: Partial<Record<K, number>>;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level, 0-based; may land between levels. */
  score: number;
  /** Most likely level, 0-based. */
  level: number;
  probabilities: number[];
}

export interface YesNoAnswer {
  type: "yesno";
  /** Probability of yes. */
  p: number;
}

export type DeciderAnswer = ChoiceAnswer | ScoreAnswer | YesNoAnswer;

export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer K> ? ChoiceAnswer<K>
    : Q extends ScoreQuestion ? ScoreAnswer
      : YesNoAnswer;

export type Answers<Qs extends Record<string, DeciderQuestion>> = { [Id in keyof Qs]: AnswerFor<Qs[Id]> };

export type DeciderResult<T> =
  | { ok: true; provider: DeciderProvider; answers: T; latencyMs: number; inputTokens?: number; model?: string }
  | { ok: false; provider?: DeciderProvider; reason: DeciderFailure; status?: number; latencyMs?: number };

export interface AskOptions {
  /** Hard ceiling for the whole call, body included. */
  timeoutMs?: number;
  /** The caller's own cancellation (a room Stop). */
  signal?: AbortSignal;
}

/** One call to a backend. The key is passed in and never kept. */
export interface BackendRequest {
  key: string;
  baseUrl?: string;
  state: unknown;
  questions: Record<string, DeciderQuestion>;
  signal: AbortSignal;
  fetch: typeof fetch;
}

export type BackendResult =
  | { ok: true; answers: Record<string, DeciderAnswer>; inputTokens?: number; model?: string }
  | { ok: false; reason: DeciderFailure; status?: number };

export interface DeciderBackend {
  id: DeciderProvider;
  decide(request: BackendRequest): Promise<BackendResult>;
}
