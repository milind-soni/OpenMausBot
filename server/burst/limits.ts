// How much of a burst runs, by where it runs. One row per plan: enforced here, on the server, whatever a card or a bot asks.
export interface BurstLimits {
  /** Burst threads running at once across this server. */
  parallel: number;
  /** Tasks in one burst; a longer list is cut to this. */
  maxTasks: number;
  /** A plan where a higher one runs more at once. */
  smallPlan: boolean;
}

/** Starter and Personal share one machine size (2 GB, shared CPU), so past a few turns at once it slows until nothing answers. */
const SMALL_PLAN = { parallel: 2, maxTasks: 10, smallPlan: true } as const;
const MAX_TASKS = 200;

export const BURST_PLAN_LIMITS: Readonly<Record<string, BurstLimits>> = {
  starter: SMALL_PLAN,
  personal: SMALL_PLAN,
  pro: { parallel: 10, maxTasks: MAX_TASKS, smallPlan: false },
  max: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
  team: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
  business: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
  enterprise: { parallel: 25, maxTasks: MAX_TASKS, smallPlan: false },
};

/** Open-source installs (desktop, self-hosted) run on their own compute, with no plan. `config.json` `burst.maxParallel` changes it. */
export const OPEN_SOURCE_PARALLEL = 10;

export interface BurstHost {
  /** Whether this server is a My Cloud home. */
  cloudHome: boolean;
  /** The Cloud's plan, as the Admin last said. */
  tier: string | undefined;
  /** config.json's `burst.maxParallel`, on an open-source install. */
  maxParallel: number | undefined;
}

export function burstLimits(host: BurstHost): BurstLimits {
  if (!host.cloudHome) return { parallel: host.maxParallel ?? OPEN_SOURCE_PARALLEL, maxTasks: MAX_TASKS, smallPlan: false };
  // A tier this build doesn't know, or none yet, gets the smallest row: the machine may be small, and a burst only queues longer.
  return (host.tier !== undefined && Object.hasOwn(BURST_PLAN_LIMITS, host.tier) ? BURST_PLAN_LIMITS[host.tier] : undefined) ?? SMALL_PLAN;
}
