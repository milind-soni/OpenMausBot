// Split engines into Cloud (sign-in plans), API keys (a provider's own key)
// and Local (no catalog — inject a model). A missing `access` is Cloud so
// older payloads stay in the top group.
import type { InstanceInfo } from "@/state/store";

/** The picker lists engines someone can use or finish setting up; the full
 * catalog stays in Settings. Each instance (so each Claude account) is judged
 * on its own:
 * - an installed engine stays with its whole catalog, signed in or not. A
 *   signed-out one shows its sign-in card instead of cloud models, and its
 *   local models stay pickable;
 * - the engine the bot runs on now always stays, even when its CLI is
 *   missing, so its setup card explains why instead of the model vanishing;
 * - an engine that is not installed and not in use stays in Settings, as does
 *   an installed engine with nothing to list. */
export function configuredModelInstances(instances: readonly InstanceInfo[], selectedInstanceId?: string): InstanceInfo[] {
  return instances.filter((instance) =>
    instance.instanceId === selectedInstanceId
      || (instance.snapshot.state === "available" && (instance.models.options.length > 0 || instance.snapshot.chatgptPlan === true)));
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** Sign-ins the picker folds into one rail button with an account choice:
 * every Claude account under "Claude", and Codex and the ChatGPT plan (both
 * the Codex CLI) under "OpenAI". An engine on a pasted API key is never
 * folded; it sits in its own group. */
export type SignInFamily = "claude" | "openai";

export function signInFamily(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): SignInFamily | undefined {
  if (!instance || instance.access === "api") return undefined;
  if (instance.driverKind === "claudeAgent") return "claude";
  if (instance.driverKind === "codex") return "openai";
  return undefined;
}

export const SIGN_IN_FAMILY_LABEL: Record<SignInFamily, string> = { claude: "Claude", openai: "OpenAI" };

/** A Claude sign-in (one of possibly several accounts). */
export function isClaudeAccount(instance: { driverKind: string; access?: InstanceInfo["access"] } | undefined): boolean {
  return signInFamily(instance) === "claude";
}

/** Rail groups: sign-in plans ("Cloud"), a provider's own pasted key ("API
 * keys"), and engines with no catalog of their own ("Local"). */
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
