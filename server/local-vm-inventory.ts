import {
  containerComputerExists,
  perBotLocalVmTarget,
  poolLocalVmTarget,
  type ContainerComputerStatus,
  type LocalVmTarget,
  type Runtime,
} from "./container-computer.ts";

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
}

/** Idle cleanup is destructive: a derived name alone is not ownership without OpenMausBot's verified labels. */
export function shouldArmLocalVmIdle(
  status: Pick<ContainerComputerStatus, "container" | "managed"> | null,
): boolean {
  return status?.container === "running" && status.managed;
}

/** Bot destination is deliberately irrelevant: a VM stays visible after its bot moves elsewhere. */
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

/** An explicit allow-list: never viewer passwords or URLs, host paths, runtime commands or target hashes. */
export function localVmInventoryEntry(
  bot: LocalVmInventoryBot,
  status: ContainerComputerStatus,
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
  };
}
