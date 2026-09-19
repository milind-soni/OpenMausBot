// Workspace credential env plumbing: syncing process.env after a save, and
// the lists of secret-bearing names spawned children must never inherit.
import type { AppConfig } from "./schema.ts";

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<AppConfig>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.anthropic?.key, "OMB_ANTHROPIC_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.tts?.fishKey, "OMB_FISH_AUDIO_API_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
    [patch.imageGen?.customApiKey, "OMB_CUSTOM_IMAGE_KEY"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  // loadConfig() also prefers env for url/model/provider, so a saved value
  // must follow the same set-when-truthy / delete-when-cleared rule as keys.
  const settings: Array<[value: string | undefined, name: string]> = [
    [patch.openaiCompat?.url, "OPENAI_COMPAT_URL"],
    [patch.anthropic?.url, "OMB_ANTHROPIC_API_URL"],
    [patch.openaiCompat?.model, "OPENAI_COMPAT_MODEL"],
    [patch.openaiCompat?.provider, "OPENAI_COMPAT_PROVIDER"],
  ];
  for (const [value, name] of settings) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
}

/** Env names of every workspace credential this process may be holding —
 * injected at boot by the desktop shell or exported by a developer. Spawned
 * engine CLIs must never inherit them: the one driver that consumes a given
 * secret receives it through instanceConfigs() narrowing, and to every other
 * child these are someone else's keys riding along in `...process.env`. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "OMB_ANTHROPIC_API_KEY",
  "OMB_ANTHROPIC_API_URL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_FISH_AUDIO_API_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "OMB_CUSTOM_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  // Harness-private filesystem hints are not credentials themselves, but
  // exposing them to a shell-capable agent points straight at app-owned
  // state. The built-in browser master is delivered privately in memory.
  "OMB_BROWSER_CONNECTION",
  "OMB_USER_DATA",
] as const;

/** Drop every workspace credential from a child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
}

/** Env names a provider CLI might read as its own billing identity. A spawned
 * engine keeps only what its driver explicitly allows: a foreign key riding
 * along in `...process.env` must not flip a subscription CLI onto
 * pay-as-you-go billing the user never granted. */
export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;
