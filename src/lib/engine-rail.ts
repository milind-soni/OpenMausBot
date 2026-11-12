import type { InstanceInfo } from "@/state/store";

export { engineDisplayName } from "@/lib/engine-name";

export function configuredModelInstances(instances: readonly InstanceInfo[], selectedInstanceId?: string): InstanceInfo[] {
  return instances.filter((instance) =>
    instance.instanceId === selectedInstanceId
      || (instance.snapshot.state === "available" && (instance.models.options.length > 0 || instance.snapshot.chatgptPlan === true)));
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** A signed-in engine whose list it never gave is worth asking: a signed-out one would only refuse. */
export function modelsAwaitEngine(instance: Pick<InstanceInfo, "modelsUnconfirmed" | "snapshot"> | undefined): boolean {
  return instance?.modelsUnconfirmed === true
    && instance.snapshot.state === "available"
    && instance.snapshot.authenticated !== false;
}

export type SignInFamily = "claude" | "openai";

export function signInFamily(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): SignInFamily | undefined {
  if (!instance || instance.access === "api") return undefined;
  // A custom Anthropic-compatible endpoint or Bedrock is its own provider, not another Claude sign-in.
  if (instance.driverKind === "claudeAgent") return instance.access === "custom" ? undefined : "claude";
  if (instance.driverKind === "codex") return "openai";
  return undefined;
}

export const SIGN_IN_FAMILY_LABEL: Record<SignInFamily, string> = { claude: "Claude", openai: "OpenAI" };

export function isClaudeAccount(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): boolean {
  return signInFamily(instance) === "claude";
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  api: T[];
  custom: T[];
} {
  const subscription: T[] = [];
  const api: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    const access = (instance as { access?: InstanceInfo["access"] }).access;
    if (access === "custom") custom.push(instance);
    else if (access === "api") api.push(instance);
    else subscription.push(instance);
  }
  return { subscription, api, custom };
}
