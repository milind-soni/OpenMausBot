// Live calls' settings in config.json: schema, type and environment overrides, kept out of server/config.ts.
import { z } from "zod";

export const LIVE_KEY_NEEDS_ENDPOINT = "Save the Azure endpoint first: a Live key works only with the endpoint it was saved for.";
const NOWHERE = "nowhere";

/** Live calls: `key` is a key for Live calls only; with `provider` "openai" (the default) a call without one uses `openai.key`, with "azure" it is the Azure resource's key and is required, with "fish", "gemini" or "elevenlabs" it is not used: Fish Audio calls use the Fish Audio key (`tts.fishKey`), Gemini calls the Gemini key (`tts.geminiKey`) and ElevenLabs calls the ElevenLabs key (`tts.key`). `keyFor` says where `key` may go (`liveKeyTarget`): the server sets it when the key is saved and never takes it from a request; absent, the key is from before Azure was offered, so OpenAI's. `azureEndpoint` is the resource URL and `azureDeployment` the gpt-live-1 deployment name. `fishAgentId` is the Fish Audio agent a "fish" call starts, which the harness sets up on the account of the key whose `fishKeyPrint` is `fishAgentFor`; without `fishAgentFor` (an operator's OMB_FISH_LIVE_AGENT_ID) it is used with any key. `elevenlabsAgentId` and `elevenlabsAgentFor` are the same for an "elevenlabs" call's ElevenLabs agent. `voice` is a GPT-Live voice, `geminiVoice` a Gemini Live voice. */
export const liveConfigSchema = z.object({
  key: z.string().optional(),
  keyFor: z.string().max(300).optional(),
  provider: z.enum(["openai", "azure", "fish", "gemini", "elevenlabs"]).optional(),
  azureEndpoint: z.string().trim().max(300).optional(),
  azureDeployment: z.string().trim().max(64).optional(),
  fishAgentId: z.string().trim().max(128).optional(),
  fishAgentFor: z.string().max(64).optional(),
  elevenlabsAgentId: z.string().trim().max(128).optional(),
  elevenlabsAgentFor: z.string().max(64).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/, "a Live voice is a lowercase built-in voice name").optional(),
  geminiVoice: z.string().trim().max(40).regex(/^[A-Za-z]*$/, "a Gemini Live voice is a built-in voice name").optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
});

export interface LiveConfig {
  key?: string;
  keyFor?: string;
  provider?: "openai" | "azure" | "fish" | "gemini" | "elevenlabs";
  azureEndpoint?: string;
  azureDeployment?: string;
  fishAgentId?: string;
  fishAgentFor?: string;
  elevenlabsAgentId?: string;
  elevenlabsAgentFor?: string;
  voice?: string;
  geminiVoice?: string;
  readTypedReplies?: boolean;
  idleMinutes?: number;
}

/** Where a key saved now may go: "openai", or "azure:<host>"; null while Azure is chosen with no endpoint to tie it to.
 * Fish Audio, Gemini and ElevenLabs calls never use this key, so with any of them chosen it stays OpenAI's. */
export function liveKeyTarget(live: LiveConfig | undefined): string | null {
  if (live?.provider !== "azure") return "openai";
  try {
    const host = new URL(live.azureEndpoint?.trim() ?? "").host.toLowerCase();
    return host ? `azure:${host}` : null;
  } catch {
    return null;
  }
}

/** The saved key, only while calls go where it was saved for. */
export function usableLiveKey(live: LiveConfig | undefined): string | undefined {
  const key = live?.key?.trim();
  const target = liveKeyTarget(live);
  return key && target && (live?.keyFor ?? "openai") === target ? key : undefined;
}

/** What to save for a change to `live`: a new key is tied to where calls now go, and any other change of where they go
 * forgets the old one. On the desktop the OS store keeps a copy the server cannot delete, which comes back as
 * OMB_OPENAI_LIVE_KEY at the next launch: "nowhere" keeps that copy unusable until a key is saved again. */
export function liveSavePatch(current: LiveConfig | undefined, patch: LiveConfig): LiveConfig {
  const { keyFor: _fromRequest, ...asked } = patch;
  const target = liveKeyTarget({ ...current, ...asked });
  if (asked.key?.trim()) {
    if (!target) throw Object.assign(new Error(LIVE_KEY_NEEDS_ENDPOINT), { status: 400 });
    return { ...asked, keyFor: target };
  }
  return asked.key !== undefined || target !== liveKeyTarget(current) ? { ...asked, key: "", keyFor: NOWHERE } : asked;
}

export function liveConfigWithEnv(live: LiveConfig | undefined, env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const next = { ...live };
  const envKey = env.OMB_OPENAI_LIVE_KEY;
  if (envKey !== undefined) {
    // A different key from the environment is not the one `keyFor` was saved for.
    if (next.key?.trim() && next.key.trim() !== envKey.trim()) delete next.keyFor;
    next.key = envKey;
  }
  const provider = env.OMB_LIVE_PROVIDER?.trim().toLowerCase();
  if (provider === "openai" || provider === "azure" || provider === "fish" || provider === "gemini" || provider === "elevenlabs") next.provider = provider;
  if (env.OMB_AZURE_OPENAI_LIVE_ENDPOINT !== undefined) next.azureEndpoint = env.OMB_AZURE_OPENAI_LIVE_ENDPOINT.trim();
  if (env.OMB_AZURE_OPENAI_LIVE_DEPLOYMENT !== undefined) next.azureDeployment = env.OMB_AZURE_OPENAI_LIVE_DEPLOYMENT.trim();
  if (env.OMB_FISH_LIVE_AGENT_ID?.trim()) {
    next.fishAgentId = env.OMB_FISH_LIVE_AGENT_ID.trim();
    delete next.fishAgentFor;
  }
  // Set together in the environment, the key and the Azure endpoint are the operator's own pairing. A `keyFor` from the
  // file stands: saves mirror settings into the environment, so they must not be able to pair a forgotten key.
  if (envKey?.trim() && provider === "azure" && env.OMB_AZURE_OPENAI_LIVE_ENDPOINT?.trim() && next.keyFor === undefined) next.keyFor = liveKeyTarget(next) ?? NOWHERE;
  return next;
}

/** The non-secret Live settings a settings patch mirrors into the environment. */
export function liveSettingEnv(live: LiveConfig | undefined): Array<[value: string | undefined, name: string]> {
  return [
    [live?.provider, "OMB_LIVE_PROVIDER"],
    [live?.azureEndpoint, "OMB_AZURE_OPENAI_LIVE_ENDPOINT"],
    [live?.azureDeployment, "OMB_AZURE_OPENAI_LIVE_DEPLOYMENT"],
  ];
}

/** A Fish Audio key saved as the Live key (`keyFor: "fish"`) is the Fish Audio key while none is saved; it is never used as a Live key. */
export function fishKeyFromLiveKey(cfg: { live?: LiveConfig; tts?: { fishKey?: string } }): void {
  const saved = cfg.live?.keyFor === "fish" ? cfg.live.key?.trim() : undefined;
  if (saved && !cfg.tts?.fishKey?.trim()) cfg.tts = { ...cfg.tts, fishKey: saved };
}
