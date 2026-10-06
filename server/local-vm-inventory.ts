import {
  containerComputerExists,
  perBotLocalVmTarget,
  poolLocalVmTarget,
  type LocalVmTarget,
  type Runtime,
} from "./container-computer.ts";
import type { LocalVmStatus } from "./local-vm-backend.ts";
import type { VmOs } from "../shared/wire.ts";
import { LocalVmIdleTimer } from "./local-vm-idle.ts";
import { recordLocalVmIdleStop, recordLocalVmSpaceIdleStop } from "./local-vm-stop-reason.ts";

export type LocalVmDestination = "auto" | "cloud" | "vm" | "local" | "browser" | "off";

export interface LocalVmInventoryBot {
  id: string;
  name: string;
  computer?: Exclude<LocalVmDestination, "auto">;
}

export interface ExistingPerBotLocalVm {
  bot: LocalVmInventoryBot;
  target: LocalVmTarget;
}

export interface LocalVmInventoryEntry {
  botId: string;
  name: string;
  destination: LocalVmDestination;
  container: "running" | "stopped";
  managed: boolean;
  ready: boolean;
  problem: string | null;
  inUse: boolean;
  /** Cua Spaces only: a bot can have one Space per OS. */
  os?: VmOs;
}

/** Idle cleanup is destructive. An exact derived name alone is not ownership:
 * a pre-existing container must also carry OpenMausBot's verified labels. */
export function shouldArmLocalVmIdle(
  status: Pick<LocalVmStatus, "container" | "managed"> | null,
): boolean {
  return status?.container === "running" && status.managed;
}

/** Shared by turn/panel activity and startup discovery. The lifecycle claim
 * precedes inspection so deletion, relabeling and idle stop cannot race. */
export function createLocalVmIdleTimer(target: LocalVmTarget, deps: {
  idleMs: number;
  busy: () => boolean;
  claim: () => () => void;
  status: () => Promise<LocalVmStatus>;
  stop: () => Promise<LocalVmStatus>;
  dataDir?: string;
}): LocalVmIdleTimer {
  return new LocalVmIdleTimer(deps.idleMs, deps.busy, async () => {
    const release = deps.claim();
    try {
      const status = await deps.status();
      // A failed Space probe must retry next window, not permanently disarm
      // the timer just because an unreachable daemon looks like "missing".
      if (status.backend === "cua-spaces" && status.container === "missing" && !status.create_supported) {
        throw new Error(status.problem ?? "Cua Spaces cannot be inspected");
      }
      if (status.container === "running" && status.managed) {
        const stopped = await deps.stop();
        if (stopped.backend === "cua-spaces") recordLocalVmSpaceIdleStop(target.key, deps.dataDir);
        else recordLocalVmIdleStop(target.key, stopped.stopped_at, deps.dataDir);
      }
    } finally {
      release();
    }
  });
}

/** An owned running Space survives server restarts. Discovery arms the same
 * renewable timer a turn uses; name-only collisions never arm one. */
export async function restoreLocalVmIdleTargets(targets: LocalVmTarget[], deps: {
  status: (target: LocalVmTarget) => Promise<LocalVmStatus>;
  seen: (target: LocalVmTarget, status: LocalVmStatus | null) => void;
  idle: (target: LocalVmTarget) => LocalVmIdleTimer;
  restored?: (target: LocalVmTarget, status: LocalVmStatus | null) => void;
}): Promise<void> {
  const statuses = await Promise.all(targets.map((target) => deps.status(target).catch(() => null)));
  targets.forEach((target, index) => {
    const status = statuses[index];
    deps.seen(target, status);
    if (shouldArmLocalVmIdle(status)) deps.idle(target).touch();
    deps.restored?.(target, status);
  });
}

/** Discover only exact, bot-derived container identities. Bot destination is
 * deliberately irrelevant: an existing VM must stay visible after its bot is
 * moved to Cloud, Browser, This computer, Auto, or Off. */
export async function discoverExistingPerBotLocalVms(
  bots: LocalVmInventoryBot[],
  runtime: Runtime,
  exists: (
    runtime: Runtime,
    target: LocalVmTarget,
  ) => Promise<boolean> = containerComputerExists,
): Promise<ExistingPerBotLocalVm[]> {
  const candidates = [...new Map(bots.map((bot) => {
    const target = perBotLocalVmTarget(bot.id);
    return [target.key, { bot, target }] as const;
  })).values()];
  const existing = await Promise.all(
    candidates.map(({ target }) => exists(runtime, target)),
  );
  return candidates.filter((_, index) => existing[index]);
}

/** Discover the pool-mode seats that actually have containers (issue #1654).
 * Same exactness rule as the per-bot walk above: a derived name alone is not
 * ownership, so a pre-existing container must also carry this target's
 * verified labels. */
export async function discoverExistingPoolLocalVms(
  seatCount: number,
  runtime: Runtime,
  exists: (
    runtime: Runtime,
    target: LocalVmTarget,
  ) => Promise<boolean> = containerComputerExists,
): Promise<LocalVmTarget[]> {
  const seats = Math.max(1, Math.floor(seatCount));
  const targets = Array.from({ length: seats }, (_, seat) => poolLocalVmTarget(seat));
  const existing = await Promise.all(targets.map((target) => exists(runtime, target)));
  return targets.filter((_, index) => existing[index]);
}

/** The public inventory is an explicit allow-list. In particular, it cannot
 * leak viewer passwords/URLs, host workspace paths, runtime commands, or
 * target hashes from the full Local VM status object. */
export function localVmInventoryEntry(
  bot: LocalVmInventoryBot,
  status: LocalVmStatus,
  inUse: boolean,
): LocalVmInventoryEntry | null {
  if (status.container === "missing") return null;
  return {
    botId: bot.id,
    name: bot.name,
    destination: bot.computer ?? "auto",
    container: status.container,
    managed: status.managed,
    ready: status.ready,
    problem: status.problem,
    inUse,
    ...(status.backend === "cua-spaces" ? { os: status.os } : {}),
  };
}
