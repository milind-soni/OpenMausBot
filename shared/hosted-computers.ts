import { z } from "zod";

export const HOSTED_PROVIDERS = ["box", "orgo", "daytona"] as const;
export type HostedProvider = typeof HOSTED_PROVIDERS[number];
export type AddedProvider = Exclude<HostedProvider, "box">;
export const isAddedProvider = (value: unknown): value is AddedProvider => value === "orgo" || value === "daytona";
const key = z.string().trim().max(4096).optional();
export const hostedComputersSchema = z.object({
  defaultProvider: z.enum(HOSTED_PROVIDERS).optional(),
  orgo: z.object({ enabled: z.boolean().optional(), apiKey: key,
    workspaceId: z.string().trim().max(128).regex(/^[A-Za-z0-9_-]*$/).optional() }).optional(),
  daytona: z.object({ enabled: z.boolean().optional(), apiKey: key,
    snapshot: z.string().trim().max(256).optional() }).optional(),
}).strict();
export type HostedComputersConfig = z.infer<typeof hostedComputersSchema>;
export type HostedComputersStatus = {
  defaultProvider: HostedProvider;
  orgo: { enabled: boolean; configured: boolean; workspaceId: string };
  daytona: { enabled: boolean; configured: boolean; snapshot: string };
};

export function hostedComputersStatus(config?: HostedComputersConfig): HostedComputersStatus {
  return {
    defaultProvider: config?.defaultProvider ?? "box",
    orgo: { enabled: config?.orgo?.enabled === true,
      configured: Boolean(config?.orgo?.apiKey && config.orgo.workspaceId), workspaceId: config?.orgo?.workspaceId ?? "" },
    daytona: { enabled: config?.daytona?.enabled === true,
      configured: Boolean(config?.daytona?.apiKey && config.daytona.snapshot), snapshot: config?.daytona?.snapshot ?? "" },
  };
}
export function addedProviderConfigured(config: HostedComputersConfig | undefined, provider: AddedProvider): boolean {
  const status = hostedComputersStatus(config)[provider];
  return status.enabled && status.configured;
}
