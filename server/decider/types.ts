/** workersai: Cloudflare's Clef on Workers AI, Jev-compatible. */
export type DeciderProvider = "jev" | "workersai" | "openrouter";

/** chat: a chat model asked for strict JSON; decisions: OpenRouter's Decisions API (output modality `decisions`). */
export type OpenRouterApi = "chat" | "decisions";

export type DeciderJob = "roomRouting" | "inboxTriage";
export const DECIDER_JOBS: readonly DeciderJob[] = ["roomRouting", "inboxTriage"];

/** botDecide: a bot's own `decide` tool call. */
export type DeciderSeam = DeciderJob | "keyCheck" | "botDecide";

/** Every failure means "use today's rule". */
export type DeciderFailure =
  | "disabled"
  | "no_key"
  | "job_off"
  /** A base URL neither https nor loopback http, a question beyond the backend's limits, or a request the relay does not take. */
  | "misconfigured"
  | "timeout"
  | "cancelled"
  | "unreachable"
  /** 401 or 403: the key was refused. */
  | "rejected"
  /** 429 */
  | "rate_limited"
  /** 529 or 503 */
  | "overloaded"
  /** 413: the request is over what the relay or the model takes. Never retried: it would be refused again. */
  | "too_large"
  | "http_error"
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
  /** Lowest first. */
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
  /** Thresholds go on this, never on a vendor "confidence" field, whose scale depends on the option count. */
  pTop: number;
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
  signal?: AbortSignal;
  /** A hard case: Workers AI answers with Clef rather than Clef-flash. */
  careful?: boolean;
}

/** One call to a backend. The key is passed in and never kept. */
export interface BackendRequest {
  key: string;
  baseUrl?: string;
  model?: string;
  /** Which OpenRouter API that model is served by; absent is `chat`. */
  api?: OpenRouterApi;
  /** Workers AI only: the Cloudflare account the token belongs to. */
  accountId?: string;
  careful?: boolean;
  /** Set only for the included relay, which is told the seam in a header. */
  relaySeam?: DeciderSeam;
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
