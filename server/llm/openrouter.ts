// OpenRouter chat routing across the four service tiers: live voice turns, background
// screening, the orchestrating brain and specialist sub-bots. Each tier names its model
// and the fallback chain tried in order when a model refuses, is rate-limited or is down.

export type OpenRouterTier = "live" | "background" | "brain" | "specialist";

export const OPENROUTER_TIERS: Readonly<
  Record<OpenRouterTier, { model: string; reasoning?: "none" | "low"; fallbacks: readonly string[] }>
> = {
  // Spoken turns: sub-500ms latency, prompt caching, plain text out.
  live: { model: "openai/gpt-6-luna", reasoning: "none", fallbacks: ["qwen/qwen3.8-flash"] },
  // Email, SMS and call screening; long-context thread summaries use the 1M-token fallbacks.
  background: { model: "deepseek/deepseek-v4.1-flash", fallbacks: ["z-ai/glm-5.3-flash", "openai/gpt-6-luna"] },
  // The orchestrating brain and the spawner of new specialist sub-bots.
  brain: { model: "z-ai/glm-5.3", fallbacks: ["moonshotai/kimi-k3.1-pro"] },
  // Specialist sub-bots; escalates to the brain's model for complex diagnostics.
  specialist: { model: "deepseek/deepseek-v4.1-flash", fallbacks: ["minimax/minimax-3.1-flash", "z-ai/glm-5.3"] },
};

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REASONS = ["none", "low", "medium", "high"] as const;
export type Reasoning = (typeof REASONS)[number];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: readonly ChatMessage[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Overrides the tier's default reasoning effort; "low" is for live turns with tool calls. */
  reasoning?: Reasoning;
  /** Response format for structured extraction work. */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
}

export class OpenRouterError extends Error {
  readonly tier: OpenRouterTier;
  readonly tried: readonly string[];
  readonly status?: number;

  constructor(message: string, tier: OpenRouterTier, tried: readonly string[], status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.tier = tier;
    this.tried = tried;
    this.status = status;
  }
}

/** The model that answers spoken phone turns: the live tier's default, or
 * VOICE_LIVE_MODEL in the environment when the owner has picked a different one. */
export function liveVoiceModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.VOICE_LIVE_MODEL?.trim() || OPENROUTER_TIERS.live.model;
}

export function openRouterKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.OMB_OPENROUTER_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  return key ? key : undefined;
}

export function openRouterBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OMB_OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE).replace(/\/+$/, "");
}

/** True when the failure is worth spending the next fallback model on. */
function worthFallback(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

interface ChatDeps {
  key: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export async function chatCompletion(
  tier: OpenRouterTier,
  request: ChatRequest,
  deps: ChatDeps,
): Promise<ChatResult> {
  const { reasoning } = OPENROUTER_TIERS[tier];
  const model = tier === "live" ? liveVoiceModel() : OPENROUTER_TIERS[tier].model;
  const chain = [model, ...OPENROUTER_TIERS[tier].fallbacks.filter((fallback) => fallback !== model)];
  // The curated reasoning preset belongs to the curated model: a VOICE_LIVE_MODEL
  // override may name a model whose provider refuses reasoning:"none" (xAI answers
  // HTTP 400 "Reasoning is mandatory"), and a 400 must not burn the fallback chain.
  const effort = request.reasoning ?? (tier === "live" && model !== OPENROUTER_TIERS.live.model ? undefined : reasoning);
  const body = {
    model,
    messages: request.messages,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
  };
  const fetcher = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? openRouterBase()).replace(/\/+$/, "");
  const tried: string[] = [];
  let lastMessage = "OpenRouter is not reachable.";
  let lastStatus: number | undefined;

  for (const candidate of chain) {
    tried.push(candidate);
    let response: Response;
    try {
      response = await fetcher(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.key}`,
          "content-type": "application/json",
          ...deps.headers,
        },
        body: JSON.stringify({ ...body, model: candidate }),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
      lastMessage = `Could not reach OpenRouter for ${candidate}.`;
      continue;
    }
    if (response.ok) {
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      };
      const raw = response.ok ? json.choices?.[0]?.message?.content : undefined;
      const text = (Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : raw ?? "").trim();
      if (!text) {
        lastMessage = `${candidate} returned an empty reply.`;
        lastStatus = 502;
        continue;
      }
      return { text, model: candidate };
    }
    lastStatus = response.status;
    lastMessage = `${candidate} failed with HTTP ${response.status}.`;
    if (!worthFallback(response.status)) break;
  }
  throw new OpenRouterError(
    lastMessage,
    tier,
    tried,
    lastStatus,
  );
}

