// Which plan this Cloud is on, as the Admin last said in its signed POST /api/cloud/plan. Kept in a file so a restart keeps
// it. An Admin that never said, a damaged file, and anything that is not a Cloud home all read as not Starter: a limit never
// lands on someone by accident of a missing signal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

export const CLOUD_PLAN_TIER_FILE = "cloud-plan-tier.json";
export const CLOUD_TIER = /^[a-z][a-z0-9_-]{0,31}$/;
const fileSchema = z.object({ v: z.literal(1), tier: z.string().regex(CLOUD_TIER) });

export interface CloudPlanTier {
  tier(): string | undefined;
  starter(): boolean;
  set(tier: string): void;
}

export function createCloudPlanTier(deps: { dataDir: string; cloudHome: boolean; changed?: () => void }): CloudPlanTier {
  const file = join(deps.dataDir, CLOUD_PLAN_TIER_FILE);
  let tier: string | undefined;
  if (deps.cloudHome) {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) tier = parsed.data.tier;
    } catch {
      // none yet, or unreadable: not Starter
    }
  }
  return {
    tier: () => tier,
    starter: () => tier === "starter",
    set(next) {
      if (!deps.cloudHome || !CLOUD_TIER.test(next) || next === tier) return;
      tier = next;
      try {
        writeFileAtomic(file, `${JSON.stringify({ v: 1, tier: next })}\n`, { mode: 0o600 });
      } catch (error) {
        console.warn(`cloud plan: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      deps.changed?.();
    },
  };
}
