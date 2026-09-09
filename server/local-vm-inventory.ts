import {
  containerComputerExists,
  perBotLocalVmTarget,
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

/** Idle cleanup is destructive. An exact derived name alone is not ownership:
 * a pre-existing container must also carry OpenMausBot's verified labels. */
export function shouldArmLocalVmIdle(
  status: Pick<ContainerComputerStatus, "container" | "managed"> | null,
): boolean {
  return status?.container === "running" && status.managed;
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

/** The public inventory is an explicit allow-list. In particular, it cannot
 * leak viewer passwords/URLs, host workspace paths, runtime commands, or
 * target hashes from the full Local VM status object. */
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
