import type { PlanAccount, PlanUsageDeps, PlanWindows } from "../plan-usage.ts";

import { ANTIGRAVITY_USAGE_LIMITS, antigravityNativePlanUsage, antigravityPlanUsage, antigravityRunsNativeCli } from "./antigravity-usage-limits.ts";
import { ensureNativeAccessToken, nativeSignInFilePresent, wakeNativeCliSignIn } from "./antigravity-native-sign-in.ts";

export type AntigravityPlanResult =
  | { windows: PlanWindows }
  | { unreachable: true };

/** Native or pinned Antigravity limits for one account. `{ unreachable: true }` means the native sign-in file is still on disk but the access token could not be used. */
export async function fetchAntigravityPlanUsage(
  account: PlanAccount,
  deps: PlanUsageDeps,
): Promise<AntigravityPlanResult | null> {
  const env = { ...process.env, ...account.environment };
  const native = await antigravityRunsNativeCli(account.antigravityCli, env);
  if (!native) {
    const windows = await antigravityPlanUsage(account.id, deps);
    return windows ? { windows } : null;
  }
  const windows = await antigravityNativePlanUsage(account.id, account.environment, deps, (id, environment, now) =>
    ensureNativeAccessToken(id, environment, now, {
      wake: (instanceId, baseEnv) => wakeNativeCliSignIn(instanceId, baseEnv, account.antigravityCli),
    }),
  );
  if (windows) return { windows };
  // A stale sign-in file is not a sign-out. Returning no row would drop the account from the quota clock.
  if (ANTIGRAVITY_USAGE_LIMITS && await nativeSignInFilePresent(account.id)) return { unreachable: true };
  return null;
}
