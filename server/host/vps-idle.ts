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

const RECOVER_RETRY_BASE_MS = 30_000;
const MAX_RECOVER_RETRIES = 5;

export function createVpsIdleHost(deps: VpsIdleHostDeps) {
  const activeVpsThreads = new Map<string, Set<string>>();
  const vpsIdles = new Map<string, ComputerIdleTimer>();
  const vpsIdleGenerations = new Map<string, number>();
  const vpsIdleMs = () => vpsIdleTimeoutMinutes(deps.cfg) * 60_000;
  let recoverTimer: ReturnType<typeof setTimeout> | null = null;
  let recoverGeneration = 0;
  const shuttingDown = () => {
    try { return deps.isShuttingDown(); }
    catch (error) { if (error instanceof ReferenceError) return false; throw error; }
  };

  function clearRecoverRetry(): void {
    recoverGeneration += 1;
    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = null;
  }

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
    const timer: ComputerIdleTimer = new ComputerIdleTimer(
      vpsIdleMs(),
      () => inUse() || deps.isLifecycleBusy(id),
      async () => {
        if (!current()) return;
        const release = deps.claimBotComputerLifecycle(id);
        try {
          const status = await vps.vpsComputerAction("stop", { vps: { sshAlias: alias } }, id, undefined, () => Boolean(current()) && !inUse());
          if (status.container === "running") return "busy";
          if (vpsIdles.get(id) === timer) vpsIdles.delete(id);
        } finally {
          release();
        }
      },
      (error, retryInMs) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`Could not stop idle VPS desktop for ${bot.name} (${id}) on ${alias}; retrying in ${Math.round(retryInMs / 1000)}s: ${detail}`);
      },
    );
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
      if (!running || shuttingDown() || vpsIdleGenerations.get(id) !== generation) return;
      const current = deps.store.bot(id);
      if (current && current.cloudBackend === "vps" && vpsSshAliasForBot(deps.cfg, current) === alias && !vpsIdles.has(id)) {
        touchVpsIdle(current);
      }
    });
  }

  function runRecover(attempt: number, generation: number): void {
    if (shuttingDown() || generation !== recoverGeneration) return;
    void vps.listManagedVpsComputers(
      deps.cfg,
      deps.store.bots.map((bot) => ({ botId: bot.id, name: bot.name, inUse: false })),
      undefined,
      vpsAliasesInPlay(deps.cfg, deps.store.bots),
    ).then((inventory) => {
      if (shuttingDown() || generation !== recoverGeneration) return;
      for (const instance of inventory.instances) {
        const bot = instance.ownerBotId && deps.store.bot(instance.ownerBotId);
        if (bot && instance.state === "running" && instance.vpsAlias === vpsSshAliasForBot(deps.cfg, bot) && !vpsIdles.has(bot.id)) {
          touchVpsIdle(bot);
        }
      }
      if (inventory.configured && !inventory.available) {
        const reason = inventory.problem ?? "VPS inventory unavailable";
        if (inventory.unreachable && attempt < MAX_RECOVER_RETRIES) {
          const delayMs = RECOVER_RETRY_BASE_MS * 2 ** attempt;
          console.warn(`Could not recover VPS idle timers (${reason}); retrying in ${Math.round(delayMs / 1000)}s`);
          recoverTimer = setTimeout(() => {
            recoverTimer = null;
            runRecover(attempt + 1, generation);
          }, delayMs);
          recoverTimer.unref?.();
        } else {
          console.warn(`Could not recover VPS idle timers: ${reason}`);
        }
      }
    }).catch((error) => {
      if (!shuttingDown() && generation === recoverGeneration) {
        console.warn("Could not recover VPS idle timers", error);
      }
    });
  }

  function recover(): void {
    clearRecoverRetry();
    runRecover(0, recoverGeneration);
  }

  function cancelAll(): void {
    clearRecoverRetry();
    for (const botId of new Set([...vpsIdles.keys(), ...vpsIdleGenerations.keys()])) cancelVpsIdle(botId);
  }

  return { activeVpsThreads, vpsThreadStarted, vpsThreadEnded, vpsIdles, vpsIdleMs, cancelVpsIdle, touchVpsIdle, vpsServerSwitched, recover, cancelAll };
}
