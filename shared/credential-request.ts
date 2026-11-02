/**
 * Credentials an agent may ask the person to provide through an inline
 * card. The id is the entire authority surface: agents never choose a
 * config path, label, URL, or arbitrary field name.
 */
export const CREDENTIAL_TARGETS = {
  xaiApiKey: {
    label: "xAI API key",
    description: "Used by the built-in Grok provider.",
    placeholder: "xai-…",
    helpUrl: "https://console.x.ai/",
  },
  boxToken: {
    label: "Boat API key",
    description: "Gives bots an isolated cloud computer when Boat is selected.",
    placeholder: "Paste your Boat API key",
    helpUrl: "https://docs.boat.dev/api-keys",
  },
  opencodeGoApiKey: {
    label: "OpenCode API key",
    description: "Used for OpenCode Zen and Go.",
    placeholder: "Paste your OpenCode API key",
    helpUrl: "https://opencode.ai/docs/providers/",
  },
  ttsKey: {
    label: "ElevenLabs API key",
    description: "Enables text-to-speech voices in calls.",
    placeholder: "Paste your ElevenLabs API key",
    helpUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  fishAudioKey: {
    label: "Fish Audio API key",
    description: "Enables Fish Audio voices in calls.",
    placeholder: "Paste your Fish Audio API key",
    helpUrl: "https://fish.audio/app/api-keys/",
  },
  openaiImageApiKey: {
    label: "OpenAI API key",
    description: "Used only to generate custom bot avatar images.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  onePasswordToken: {
    label: "1Password service account token",
    description: "Lets bots sign in with the website logins in the 1Password vault this token can read, the way Settings → Logins does.",
    placeholder: "ops_…",
    helpUrl: "https://developer.1password.com/docs/service-accounts/get-started/",
  },
  composioApiKey: {
    label: "Composio API key",
    description: "Connects apps such as Gmail, Slack and GitHub through your own Composio project.",
    placeholder: "ak_…",
    helpUrl: "https://dashboard.composio.dev",
  },
  openaiApiKey: {
    label: "OpenAI API key",
    description: "Runs OpenAI models with your own key.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  anthropicApiKey: {
    label: "Anthropic API key",
    description: "Runs Claude models with your own key. Bots signed in to Claude keep using their sign-in.",
    placeholder: "sk-ant-…",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  openrouterApiKey: {
    label: "OpenRouter API key",
    description: "Runs models from many providers through OpenRouter.",
    placeholder: "sk-or-v1-…",
    helpUrl: "https://openrouter.ai/keys",
  },
  mistralApiKey: {
    label: "Mistral API key",
    description: "Runs Mistral models with your own key.",
    placeholder: "Paste your Mistral API key",
    helpUrl: "https://console.mistral.ai/api-keys",
  },
  cerebrasApiKey: {
    label: "Cerebras API key",
    description: "Runs Cerebras models with your own key.",
    placeholder: "csk-…",
    helpUrl: "https://cloud.cerebras.ai/",
  },
  groqApiKey: {
    label: "Groq API key",
    description: "Runs Groq models with your own key.",
    placeholder: "gsk_…",
    helpUrl: "https://console.groq.com/keys",
  },
  greenferenceApiKey: {
    label: "Greenference API key",
    description: "Runs Greenference models with your own key.",
    placeholder: "Paste your Greenference API key",
    helpUrl: "https://greenference.com/dashboard/tokens",
  },
  metaApiKey: {
    label: "Meta API key",
    description: "Runs Meta's models with your own key.",
    placeholder: "LLM|…",
    helpUrl: "https://dev.meta.ai/docs/authentication",
  },
  deepseekApiKey: {
    label: "DeepSeek API key",
    description: "Runs DeepSeek models with your own key.",
    placeholder: "sk-…",
    helpUrl: "https://platform.deepseek.com/api_keys",
  },
} as const;

export type CredentialTargetId = keyof typeof CREDENTIAL_TARGETS;
/** Saved in the sealed login store, not the settings file. */
export type LoginCredentialTargetId = "onePasswordToken";
export type ConfigCredentialTargetId = Exclude<CredentialTargetId, LoginCredentialTargetId>;
/** AI provider keys: the server's config only, like Settings → Keys, and refused where Admin manages the models. */
export const PROVIDER_CREDENTIAL_TARGETS = [
  "openaiApiKey", "anthropicApiKey", "openrouterApiKey", "mistralApiKey", "cerebrasApiKey", "groqApiKey", "greenferenceApiKey", "metaApiKey", "deepseekApiKey",
] as const satisfies readonly ConfigCredentialTargetId[];
export type DesktopCredentialSlot = Exclude<ConfigCredentialTargetId, (typeof PROVIDER_CREDENTIAL_TARGETS)[number]>;
export type CredentialConfig = {
  xai?: { key?: string };
  box?: { token?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; fishKey?: string };
  imageGen?: { key?: string };
  composio?: { apiKey?: string };
  openai?: { key?: string };
  anthropic?: { key?: string; everyClaudeBot?: boolean };
  openrouter?: { key?: string };
  mistral?: { key?: string };
  cerebras?: { key?: string };
  groq?: { key?: string };
  greenference?: { key?: string };
  meta?: { key?: string };
  deepseek?: { key?: string };
  /** Not in the settings file: the server fills it from its login store. */
  onePassword?: { connected?: boolean };
};

/** A secret OpenMausBot does not keep itself: the bot names it, and gets a one-use reference or a private file. */
export const CUSTOM_SECRET_TARGET = "customSecret";
export type SecretDelivery = "ref" | "file";
export const SECRET_DELIVERIES: readonly SecretDelivery[] = ["ref", "file"];
export const CUSTOM_SECRET_LABEL_MAX = 80;
export const CUSTOM_SECRET_REASON_MAX = 240;

export function isCredentialTargetId(value: unknown): value is CredentialTargetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREDENTIAL_TARGETS, value);
}

export function isConfigCredentialTarget(id: CredentialTargetId): id is ConfigCredentialTargetId {
  return id !== "onePasswordToken";
}

export function isProviderCredentialTarget(id: CredentialTargetId): boolean {
  return (PROVIDER_CREDENTIAL_TARGETS as readonly string[]).includes(id);
}

/** The desktop's encrypted-store slot that holds this key, where Settings saves it; null for a key Settings keeps in the
 * server's config. A paired phone can save only a key with a slot. */
export function desktopCredentialSlot(id: CredentialTargetId): DesktopCredentialSlot | null {
  return isConfigCredentialTarget(id) && !isProviderCredentialTarget(id) ? id as DesktopCredentialSlot : null;
}

/** Where a card saves what the person typed: the 1Password token goes to Logins, which checks it reaches 1Password. */
export function credentialSaveRequest(id: CredentialTargetId, value: string): { path: string; method: "PUT" | "POST"; body: object } {
  return isConfigCredentialTarget(id)
    ? { path: "/api/config", method: "PUT", body: credentialConfigPatch(id, value) }
    : { path: "/api/logins/1password", method: "POST", body: { token: value } };
}

export function credentialConfigPatch(id: ConfigCredentialTargetId, value: string): CredentialConfig {
  switch (id) {
    case "xaiApiKey":
      return { xai: { key: value } };
    case "boxToken":
      return { box: { token: value } };
    case "opencodeGoApiKey":
      return { opencodeGo: { apiKey: value } };
    case "ttsKey":
      return { tts: { key: value } };
    case "fishAudioKey":
      return { tts: { fishKey: value } };
    case "openaiImageApiKey":
      return { imageGen: { key: value } };
    case "composioApiKey":
      return { composio: { apiKey: value } };
    case "openaiApiKey":
      return { openai: { key: value } };
    // Settings' first Anthropic key leaves every bot signed in to Claude on its sign-in; a card appears only while none is set.
    case "anthropicApiKey":
      return { anthropic: { key: value, everyClaudeBot: false } };
    case "openrouterApiKey":
      return { openrouter: { key: value } };
    case "mistralApiKey":
      return { mistral: { key: value } };
    case "cerebrasApiKey":
      return { cerebras: { key: value } };
    case "groqApiKey":
      return { groq: { key: value } };
    case "greenferenceApiKey":
      return { greenference: { key: value } };
    case "metaApiKey":
      return { meta: { key: value } };
    case "deepseekApiKey":
      return { deepseek: { key: value } };
  }
}

export function credentialIsConfigured(config: CredentialConfig, id: CredentialTargetId): boolean {
  switch (id) {
    case "xaiApiKey":
      return Boolean(config.xai?.key);
    case "boxToken":
      return Boolean(config.box?.token);
    case "opencodeGoApiKey":
      return Boolean(config.opencodeGo?.apiKey);
    case "ttsKey":
      return Boolean(config.tts?.key);
    case "fishAudioKey":
      return Boolean(config.tts?.fishKey);
    case "openaiImageApiKey":
      return Boolean(config.imageGen?.key);
    case "onePasswordToken":
      return Boolean(config.onePassword?.connected);
    case "composioApiKey":
      return Boolean(config.composio?.apiKey);
    case "openaiApiKey":
      return Boolean(config.openai?.key);
    case "anthropicApiKey":
      return Boolean(config.anthropic?.key);
    case "openrouterApiKey":
      return Boolean(config.openrouter?.key);
    case "mistralApiKey":
      return Boolean(config.mistral?.key);
    case "cerebrasApiKey":
      return Boolean(config.cerebras?.key);
    case "groqApiKey":
      return Boolean(config.groq?.key);
    case "greenferenceApiKey":
      return Boolean(config.greenference?.key);
    case "metaApiKey":
      return Boolean(config.meta?.key);
    case "deepseekApiKey":
      return Boolean(config.deepseek?.key);
  }
}

/** A still-pending credential card for this target — the set a newer
 * request supersedes. Provided, dismissed, and already-superseded cards
 * keep their settled state untouched. */
export function isPendingCredentialRequest(
  message: {
    kind?: unknown;
    secret?: { target?: unknown; provided?: unknown; dismissed?: unknown; superseded?: unknown };
    from?: { botId?: unknown };
  },
  target: CredentialTargetId,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "secret" &&
    message.secret?.target === target &&
    message.secret.provided !== true &&
    message.secret.dismissed !== true &&
    message.secret.superseded !== true &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}

/** A still-pending card from this bot for a custom secret with the same name, which a newer request supersedes. */
export function isPendingCustomSecretRequest(
  message: {
    kind?: unknown;
    secret?: { target?: unknown; label?: unknown; provided?: unknown; dismissed?: unknown; superseded?: unknown };
    from?: { botId?: unknown };
  },
  label: string,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "secret" &&
    message.secret?.target === CUSTOM_SECRET_TARGET &&
    typeof message.secret.label === "string" &&
    message.secret.label.toLowerCase() === label.toLowerCase() &&
    message.secret.provided !== true &&
    message.secret.dismissed !== true &&
    message.secret.superseded !== true &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}

export function credentialResumeOutcome(state: {
  provided?: unknown;
  dismissed?: unknown;
}): "provided" | "dismissed" | null {
  const provided = state.provided === true;
  const dismissed = state.dismissed === true;
  if (provided === dismissed) return null;
  return provided ? "provided" : "dismissed";
}
