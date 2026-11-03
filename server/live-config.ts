// Live calls' settings in config.json: schema, type and environment overrides, kept out of server/config.ts.
import { z } from "zod";

/** Live calls: `key` is a key for Live calls only; with `provider` "openai" (the default) a call without one uses `openai.key`, with "azure" it is the Azure resource's key and is required. `azureEndpoint` is the resource URL and `azureDeployment` the gpt-live-1 deployment name. `voice` is a GPT-Live voice. */
export const liveConfigSchema = z.object({
  key: z.string().optional(),
  provider: z.enum(["openai", "azure"]).optional(),
  azureEndpoint: z.string().trim().max(300).optional(),
  azureDeployment: z.string().trim().max(64).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/, "a Live voice is a lowercase built-in voice name").optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
});

export interface LiveConfig {
  key?: string;
  provider?: "openai" | "azure";
  azureEndpoint?: string;
  azureDeployment?: string;
  voice?: string;
  readTypedReplies?: boolean;
  idleMinutes?: number;
}

export function liveConfigWithEnv(live: LiveConfig | undefined, env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const next = { ...live };
  if (env.OMB_OPENAI_LIVE_KEY !== undefined) next.key = env.OMB_OPENAI_LIVE_KEY;
  const provider = env.OMB_LIVE_PROVIDER?.trim().toLowerCase();
  if (provider === "openai" || provider === "azure") next.provider = provider;
  if (env.OMB_AZURE_OPENAI_LIVE_ENDPOINT !== undefined) next.azureEndpoint = env.OMB_AZURE_OPENAI_LIVE_ENDPOINT.trim();
  if (env.OMB_AZURE_OPENAI_LIVE_DEPLOYMENT !== undefined) next.azureDeployment = env.OMB_AZURE_OPENAI_LIVE_DEPLOYMENT.trim();
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
