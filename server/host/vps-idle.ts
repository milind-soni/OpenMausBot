import { ComputerIdleTimer } from "../computer-idle.ts";
import { vpsIdleTimeoutMinutes, type AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import { vpsAliasesInPlay, vpsSshAliasForBot } from "../vps-hosts.ts";

export interface VpsIdleHostDeps {
  cfg: AppConfig;
  store: { bots: BotRecord[]; bot: (id: string) => BotRecord | null | undefined };
  botHasActiveTurn: (botId: string) => boolean;
  hasActiveRoutine: (botId: string) => boolean;
  isSharedVmHeld: (botId: string) => boolean;
  hasComputerPreview: (botId: string) => boolean;
  isVpsConfigTransitioning: () => boolean;
  isLifecycleBusy: (botId: string) => boolean;
  claimBotComputerLifecycle: (botId: string) => () => void;
  isShuttingDown: () => boolean;
}

export function createVpsIdleHost(deps: VpsIdleHostDeps) {
  const activeVpsThreads = new Map<string, Set<string>>();
  const vpsIdles = new Map<string, ComputerIdleTimer>();
  const vpsIdleGenerations = new Map<string, number>();
  const vpsIdleMs = () => vpsIdleTimeoutMinutes(deps.cfg) * 60_000;

  function vpsThreadStarted(botId: string, threadId: string): void {
    const threads = activeVpsThreads.get(botId) ?? new Set<string>();
    threads.add(threadId);
    activeVpsThreads.set(botId, threads);
  }

  function vpsThreadEnded(botId: string, threadId: string): void {
    const threads = activeVpsThreads.get(botId);
    if (!threads) return;
    if (threads.delete(threadId)) vpsIdles.get(botId)?.touch();
    if (!threads.size) activeVpsThreads.delete(botId);
  }

  function cancelVpsIdle(botId: string): number {
    const generation = (vpsIdleGenerations.get(botId) ?? 0) + 1;
    vpsIdleGenerations.set(botId, generation);
    vpsIdles.get(botId)?.cancel();
    vpsIdles.delete(botId);
    return generation;
  }

  function touchVpsIdle(bot: BotRecord): void {
    const alias = vpsSshAliasForBot(deps.cfg, bot);
    if (!alias) return;
    const id = bot.id;
    cancelVpsIdle(id);
    const current = () => {
      const owner = deps.store.bot(id);
      return owner && vpsSshAliasForBot(deps.cfg, owner) === alias && vpsIdles.get(id) === timer;
    };
    const inUse = () => activeVpsThreads.has(id) || deps.botHasActiveTurn(id) || deps.hasActiveRoutine(id)
      || deps.isSharedVmHeld(id) || Boolean(vps.vpsDesktopConnection(id)) || deps.hasComputerPreview(id)
      || deps.isVpsConfigTransitioning();
    const timer: ComputerIdleTimer = new ComputerIdleTimer(vpsIdleMs(), () => inUse() || deps.isLifecycleBusy(id), async () => {
      if (!current()) return;
      const release = deps.claimBotComputerLifecycle(id);
      try {
        const status = await vps.vpsComputerAction("stop", { vps: { sshAlias: alias } }, id, undefined, () => Boolean(current()) && !inUse());
        if (status.container === "running") return "busy";
        if (vpsIdles.get(id) === timer) vpsIdles.delete(id);
      } finally {
        release();
      }
    });
    vpsIdles.set(id, timer);
    timer.touch();
  }

  function vpsServerSwitched(bot: BotRecord): void {
    const id = bot.id;
    vps.stopVpsDesktopTunnel(id);
    const generation = cancelVpsIdle(id);
    if (bot.cloudBackend !== "vps") return;
    const alias = vpsSshAliasForBot(deps.cfg, bot);
    if (!alias) return;
    void vps.vpsComputerRunning({ vps: { sshAlias: alias } }, id).then((running) => {
      if (!running || deps.isShuttingDown() || vpsIdleGenerations.get(id) !== generation) return;
      const current = deps.store.bot(id);
      if (current && current.cloudBackend === "vps" && vpsSshAliasForBot(deps.cfg, current) === alias && !vpsIdles.has(id)) {
        touchVpsIdle(current);
      }
    });
  }

  function recover(): void {
    void vps.listManagedVpsComputers(deps.cfg, deps.store.bots.map(bot => ({ botId: bot.id, name: bot.name, inUse: false })), undefined, vpsAliasesInPlay(deps.cfg, deps.store.bots)).then(inventory => {
      for (const instance of inventory.instances) {
        const bot = instance.ownerBotId && deps.store.bot(instance.ownerBotId);
        if (bot && instance.state === "running" && instance.vpsAlias === vpsSshAliasForBot(deps.cfg, bot) && !vpsIdles.has(bot.id)) touchVpsIdle(bot);
      }
    }).catch(error => console.warn("Could not recover VPS idle timers", error));
  }

  function cancelAll(): void {
    for (const botId of new Set([...vpsIdles.keys(), ...vpsIdleGenerations.keys()])) cancelVpsIdle(botId);
  }

  return { activeVpsThreads, vpsThreadStarted, vpsThreadEnded, vpsIdles, vpsIdleMs, cancelVpsIdle, touchVpsIdle, vpsServerSwitched, recover, cancelAll };
}
