// Hand-kept facts about model providers that models.dev does not carry:
// - which providers we recommend, in what order, and under what name;
// - a pinned OpenAI-compatible base URL for each (models.dev lists some
//   providers without one, and a pinned URL means a catalog refresh can never
//   change where a newly pasted key for a recommended provider is sent);
// - the Anthropic-compatible endpoint Claude Code can use, where one exists;
// - whether the provider documents Codex support, and its exceptions;
// - how to prove a key when the provider's model list is public.
// Every row was checked by hand on its `checkedAt` date.
//
// Codex rules (see codexVerdict): Codex is offered only when the provider's
// /responses route passed the check AND either the provider documents Codex
// or the person turned on the experimental switch. Documented exceptions
// (Fireworks: no MiniMax models, no Fire Pass keys) always apply.

export type AnthropicAuth = "bearer" | "x-api-key";

export interface AnthropicEndpoint {
  /** Claude Code's ANTHROPIC_BASE_URL; Claude Code adds /v1/messages. */
  baseUrl: string;
  /** A fixed auth style. Absent: the check decides, preferring Bearer. */
  auth?: AnthropicAuth;
  doc?: string;
}

/** Why a provider can never be used with Codex. */
export type CodexUnsupportedReason = "no-responses-api" | "not-supported";

export type CodexSupport =
  | {
    kind: "documented";
    doc: string;
    /** Models the provider says do not work with Codex. */
    denyModels?: RegExp;
    /** Key kinds (by prefix) the provider says do not work with Codex. */
    denyKeyPrefixes?: readonly string[];
  }
  | { kind: "unsupported"; reason: CodexUnsupportedReason };

export interface ProviderPreset {
  /** models.dev id, or an OpenMausBot-only id when models.dev has no entry. */
  id: string;
  /** The models.dev provider this row describes; absent for OpenMausBot-only rows. */
  catalogId?: string;
  label: string;
  /** Position in the Recommended group, from 1. */
  recommended?: number;
  /** OpenAI-compatible base URL. Wins over models.dev's `api`. */
  api: string;
  /** The AI SDK package OpenCode must load to reach `api`, when models.dev's
   * `npm` is for a different endpoint (MiniMax: its Anthropic one). */
  npm?: string;
  /** Key variable name, for rows models.dev does not list. */
  env?: string;
  /** "Get a key" link, for rows models.dev does not list. */
  doc?: string;
  /** Claude Code can use this provider through this endpoint. */
  anthropic?: AnthropicEndpoint;
  /** Absent: Codex only as an experiment, and only if the check passes. */
  codex?: CodexSupport;
  /** Path added to `api` for a GET that proves the key (a 2xx means it works). */
  keyCheck?: string;
  /** GET {api}/models answers without a key, so it proves nothing about one. */
  publicModels?: true;
  /** The chat engine is enabled only after the check passes. */
  chat?: "after-check";
  /** Date this row was last checked by hand (YYYY-MM-DD). */
  checkedAt: string;
}

const CHECKED = "2026-09-30";

/** The AI SDK package for any OpenAI-compatible base URL. */
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "greenference", label: "Greenference", api: "https://llm.eu.greenference.com/v1",
    env: "GREENFERENCE_TOKEN", npm: OPENAI_COMPATIBLE_NPM,
    doc: "https://greenference.com/dashboard/tokens", publicModels: true,
    checkedAt: "2026-10-08",
  },
  {
    id: "openrouter",
    catalogId: "openrouter",
    label: "OpenRouter",
    recommended: 1,
    api: "https://openrouter.ai/api/v1",
    anthropic: {
      baseUrl: "https://openrouter.ai/api",
      auth: "bearer",
      doc: "https://openrouter.ai/docs/guides/guides/claude-code-integration",
    },
    codex: { kind: "documented", doc: "https://openrouter.ai/docs/cookbook/coding-agents/codex-cli" },
    // /models is public; /key answers only with a valid key.
    keyCheck: "/key",
    publicModels: true,
    checkedAt: CHECKED,
  },
  {
    id: "fireworks-ai",
    catalogId: "fireworks-ai",
    label: "Fireworks AI",
    recommended: 2,
    api: "https://api.fireworks.ai/inference/v1",
    anthropic: {
      baseUrl: "https://api.fireworks.ai/inference",
      auth: "bearer",
      doc: "https://docs.fireworks.ai/tools-sdks/anthropic-compatibility",
    },
    codex: {
      kind: "documented",
      doc: "https://docs.fireworks.ai/ecosystem/fireconnect/codex",
      // Fireworks: MiniMax models and Fire Pass keys do not work with Codex.
      denyModels: /minimax/i,
      denyKeyPrefixes: ["fpk_"],
    },
    checkedAt: CHECKED,
  },
  {
    id: "deepseek",
    catalogId: "deepseek",
    label: "DeepSeek",
    recommended: 3,
    api: "https://api.deepseek.com",
    anthropic: { baseUrl: "https://api.deepseek.com/anthropic", doc: "https://api-docs.deepseek.com/guides/anthropic_api" },
    codex: { kind: "unsupported", reason: "no-responses-api" },
    checkedAt: CHECKED,
  },
  {
    id: "cline-pass",
    catalogId: "cline-pass",
    label: "Cline (ClinePass)",
    recommended: 4,
    api: "https://api.cline.bot/api/v1",
    codex: { kind: "unsupported", reason: "not-supported" },
    publicModels: true,
    checkedAt: CHECKED,
  },
  {
    // Cline's pay-as-you-go credits: the same API as ClinePass with a larger,
    // OpenRouter-style model list. Not in models.dev.
    id: "cline-credits",
    label: "Cline (credits)",
    recommended: 5,
    api: "https://api.cline.bot/api/v1",
    env: "CLINE_API_KEY",
    doc: "https://docs.cline.bot/api/overview",
    codex: { kind: "unsupported", reason: "not-supported" },
    publicModels: true,
    checkedAt: CHECKED,
  },
  { id: "groq", catalogId: "groq", label: "Groq", recommended: 6, api: "https://api.groq.com/openai/v1", checkedAt: CHECKED },
  { id: "togetherai", catalogId: "togetherai", label: "Together AI", recommended: 7, api: "https://api.together.xyz/v1", checkedAt: CHECKED },
  { id: "mistral", catalogId: "mistral", label: "Mistral", recommended: 8, api: "https://api.mistral.ai/v1", checkedAt: CHECKED },
  { id: "xai", catalogId: "xai", label: "xAI", recommended: 9, api: "https://api.x.ai/v1", checkedAt: CHECKED },
  {
    id: "moonshotai",
    catalogId: "moonshotai",
    label: "Moonshot (Kimi)",
    recommended: 10,
    api: "https://api.moonshot.ai/v1",
    anthropic: { baseUrl: "https://api.moonshot.ai/anthropic" },
    checkedAt: CHECKED,
  },
  {
    id: "zai",
    catalogId: "zai",
    label: "Z.ai",
    recommended: 11,
    api: "https://api.z.ai/api/paas/v4",
    anthropic: { baseUrl: "https://api.z.ai/api/anthropic" },
    checkedAt: CHECKED,
  },
  {
    // models.dev lists MiniMax's Anthropic endpoint as its `api` (with
    // @ai-sdk/anthropic); the chat engine and OpenCode need the OpenAI one,
    // and OpenCode needs the matching SDK with it.
    id: "minimax",
    catalogId: "minimax",
    label: "MiniMax",
    recommended: 12,
    api: "https://api.minimax.io/v1",
    npm: OPENAI_COMPATIBLE_NPM,
    anthropic: { baseUrl: "https://api.minimax.io/anthropic" },
    chat: "after-check",
    checkedAt: CHECKED,
  },
  { id: "cerebras", catalogId: "cerebras", label: "Cerebras", recommended: 13, api: "https://api.cerebras.ai/v1", checkedAt: CHECKED },
  {
    id: "openai",
    catalogId: "openai",
    label: "OpenAI",
    api: "https://api.openai.com/v1",
    codex: { kind: "documented", doc: "https://github.com/openai/codex" },
    checkedAt: CHECKED,
  },
  {
    id: "opencode",
    catalogId: "opencode",
    label: "OpenCode Zen",
    api: "https://opencode.ai/zen/v1",
    anthropic: { baseUrl: "https://opencode.ai/zen" },
    checkedAt: CHECKED,
  },
  {
    id: "wallaby",
    catalogId: "wallaby",
    label: "Wallaby",
    api: "https://api.wallabytoken.com/v1",
    keyCheck: "/models",
    checkedAt: "2026-10-05",
  },
];

const BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function providerPreset(id: string): ProviderPreset | undefined {
  return BY_ID.get(id);
}

/** Result of the /responses check (section 4.7, step 4). */
export type ResponsesCheck = "works" | "missing" | "key-refused" | "unchecked";

export type CodexNoReason =
  /** The provider has no Responses API (DeepSeek). */
  | "provider-no-responses-api"
  /** The provider does not support Codex (Cline). */
  | "provider-unsupported"
  /** This kind of key is documented not to work (Fireworks Fire Pass). */
  | "key-type"
  /** /responses answered a plain 404 or 405. */
  | "route-missing"
  /** /responses refused a key that /models accepted. */
  | "key-refused"
  /** No check has run yet. */
  | "not-checked"
  /** Not documented; available once the experimental switch is on. */
  | "experimental-off";

export type CodexVerdict =
  | { use: "yes" }
  | { use: "experimental" }
  | { use: "no"; reason: CodexNoReason };

export function codexKeyAllowed(preset: ProviderPreset | undefined, key: string): boolean {
  const codex = preset?.codex;
  return !(codex?.kind === "documented" && codex.denyKeyPrefixes?.some((prefix) => key.startsWith(prefix)));
}

export function codexModelAllowed(preset: ProviderPreset | undefined, model: string): boolean {
  const codex = preset?.codex;
  return !(codex?.kind === "documented" && codex.denyModels?.test(model));
}

/** The models Codex may be offered for this provider. */
export function codexModels(preset: ProviderPreset | undefined, models: readonly string[]): string[] {
  return models.filter((model) => codexModelAllowed(preset, model));
}

/** Whether Codex can use a provider. `preset` is undefined for custom providers. */
export function codexVerdict(input: {
  preset: ProviderPreset | undefined;
  responses: ResponsesCheck;
  experimental: boolean;
  key?: string;
}): CodexVerdict {
  const codex = input.preset?.codex;
  if (codex?.kind === "unsupported") {
    return { use: "no", reason: codex.reason === "no-responses-api" ? "provider-no-responses-api" : "provider-unsupported" };
  }
  if (input.key !== undefined && !codexKeyAllowed(input.preset, input.key)) return { use: "no", reason: "key-type" };
  if (input.responses === "missing") return { use: "no", reason: "route-missing" };
  if (input.responses === "key-refused") return { use: "no", reason: "key-refused" };
  if (input.responses !== "works") return { use: "no", reason: "not-checked" };
  if (codex?.kind === "documented") return { use: "yes" };
  return input.experimental ? { use: "experimental" } : { use: "no", reason: "experimental-off" };
}
