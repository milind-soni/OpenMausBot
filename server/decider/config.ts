// The decision model's settings in config.json (server/decider): schema and type, kept out of server/config.ts.
import { z } from "zod";

/** What a saved `decider.openrouterModel` must look like; the model picker
 * offers only ids that match it. */
export const OPENROUTER_MODEL_ID = /^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/;
export const OPENROUTER_MODEL_ID_MAX = 128;
/** A Cloudflare account ID: 32 hex characters. Not a secret, so it is shown back to Settings. */
export const WORKERS_AI_ACCOUNT_ID = /^[0-9a-f]{32}$/i;

const optionalText = z.string().optional();
export const CUSTOM_MODEL_ID_MAX = 128;

/** The decision and extraction models (server/decider, server/extractor):
 * fast classifiers and extractors that pick and read things for bots, starting
 * with who answers a room message. `key` is the Jev key, `workersAiToken` a
 * Cloudflare Workers AI token for `workersAiAccountId` (Clef and Clairic), and
 * `openrouterKey` the OpenRouter one, `customKey` a custom gateway's at
 * `customBaseUrl` (model `customModel`, protocol `customApi`): write-only like every credential, and
 * kept apart from each other and from the engine's OpenRouter key. `baseUrl` / `openrouterBaseUrl` point at a compatible
 * server instead of the vendor's (operator settings with no UI);
 * `openrouterModel` is an OpenRouter model id and `openrouterApi` says
 * whether it is a chat model or one of OpenRouter's decisions models
 * (`chat` when absent); `jobs` switches each
 * decision on or off. Not `decisions`: that section is the authorization
 * log's retention. */
export const deciderConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(["jev", "gemini", "openrouter", "custom", "off"]).optional(),
  key: optionalText,
  geminiKey: optionalText,
  geminiKeySource: z.enum(["own", "speech", "images"]).optional(),
  openrouterKey: optionalText,
  customKey: optionalText,
  customBaseUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "the custom endpoint address must start with http:// or https://")
    .optional(),
  customModel: z.string().trim().max(CUSTOM_MODEL_ID_MAX).optional(),
  customApi: z.enum(["systemone", "decisions"]).optional(),
  workersAiToken: optionalText,
  workersAiAccountId: z.string().trim().refine((value) => !value || WORKERS_AI_ACCOUNT_ID.test(value), "a Cloudflare account ID is 32 letters and digits").optional(),
  workersAiBaseUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "the Workers AI address must start with http:// or https://")
    .optional(),
  openrouterModel: z
    .string()
    .trim()
    .max(OPENROUTER_MODEL_ID_MAX)
    .regex(OPENROUTER_MODEL_ID, "an OpenRouter model id looks like vendor/model")
    .optional(),
  openrouterApi: z.enum(["chat", "decisions"]).optional(),
  baseUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "the decision model address must start with http:// or https://")
    .optional(),
  openrouterBaseUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "the OpenRouter address must start with http:// or https://")
    .optional(),
  jobs: z.object({ roomRouting: z.boolean().optional(), inboxTriage: z.boolean().optional() }).optional(),
});

/** The decision model; see `deciderConfigSchema`. */
export interface DeciderConfig {
  enabled?: boolean;
  provider?: "jev" | "gemini" | "openrouter" | "custom" | "off";
  key?: string;
  /** Write-only Google AI Studio key for Gemini Decision 1. */
  geminiKey?: string;
  /** Defaults to `own`; speech and image sources reference their saved key without copying it. */
  geminiKeySource?: "own" | "speech" | "images";
  customKey?: string;
  /** The gateway's root, e.g. `https://gateway.example.com/v1`: requests go to `{customBaseUrl}/systemone` or `/decisions`. */
  customBaseUrl?: string;
  customModel?: string;
  /** Absent is `systemone`. */
  customApi?: "systemone" | "decisions";
  baseUrl?: string;
  openrouterKey?: string;
  openrouterModel?: string;
  /** Which OpenRouter API `openrouterModel` is served by: absent is `chat`. */
  openrouterApi?: "chat" | "decisions";
  openrouterBaseUrl?: string;
  workersAiToken?: string;
  workersAiAccountId?: string;
  /** An operator setting with no UI, like `baseUrl`: Workers AI's REST root, `/client/v4` included. */
  workersAiBaseUrl?: string;
  jobs?: { roomRouting?: boolean; inboxTriage?: boolean };
}

const CREDENTIAL_ENV = [
  ["key", "OMB_JEV_API_KEY"],
  ["geminiKey", "OMB_GEMINI_DECIDER_KEY"],
  ["customKey", "OMB_CUSTOM_DECIDER_KEY"],
  ["openrouterKey", "OMB_OPENROUTER_DECIDER_KEY"],
  ["workersAiToken", "OMB_WORKERS_AI_TOKEN"],
] as const;

export function deciderConfigWithEnv(config: DeciderConfig | undefined, env: NodeJS.ProcessEnv = process.env): DeciderConfig {
  const next = { ...config };
  for (const [field, name] of CREDENTIAL_ENV) if (env[name] !== undefined) next[field] = env[name];
  return next;
}

export function deciderCredentialEnv(config: DeciderConfig | undefined): Array<[string | undefined, string]> {
  return CREDENTIAL_ENV.map(([field, name]) => [config?.[field], name]);
}
