import type { AppConfig } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { BotActivity } from "../shared/wire.ts";
import type { Message } from "./store/records.ts";
import type { TurnCleanup } from "./turn-cleanup.ts";
import type { TurnOwner } from "./turn-resources.ts";

type ProviderFleetInstances = NonNullable<AppConfig["instances"]>;

/** The store surface the provider-fleet teardown and reload paths touch. */
export interface ProviderFleetStore {
  bots: { id: string; modelSelection: { instanceId: string } }[];
  tasks(botId: string): { threadId: string }[];
  bot(botId: string): { id: string; modelSelection: { instanceId: string } } | null | undefined;
  groupByThread(threadId: string): { id: string } | undefined;
  taskByThread(botId: string, threadId: string): unknown;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): void;
  setTaskActivity(botId: string, threadId: string, activity: BotActivity): void;
  patchGroup(id: string, patch: { busyBotId?: string | null }): void;
  setActivity(botId: string, activity: BotActivity): void;
}

interface SpeakerTable {
  get(threadId: string): { botId: string } | undefined;
  delete(threadId: string): void;
  entries(): IterableIterator<[string, { botId: string }]>;
  [Symbol.iterator](): IterableIterator<[string, { botId: string }]>;
}

export interface ProviderFleetDeps {
  store: ProviderFleetStore;
  cfg: { instances?: ProviderFleetInstances };
  registry: {
    load(configs: InstanceConfigMap): Promise<unknown>;
    get(id: string): { instanceId: string } | null;
    instances(): { instanceId: string }[];
    dispose(id: string): Promise<unknown>;
    disposeAll(): Promise<unknown>;
  };
  bus: {
    attach(instances: { instanceId: string }[]): void;
    detach(id: string): void;
    detachAll(): void;
  };
  sessions: { clear(): void; clearInstance(instanceId: string): void };
  watchdog: { settle(threadId: string): void };
  routines(): { failThread(threadId: string, message: string): void } | null;
  desktop: { restore(): Promise<unknown> };
  turns: TurnCleanup;
  companyShutdown(): boolean;
  admission: {
    threadBusy(botId: string, threadId: string): boolean;
    botForThread(botId: string, threadId: string): { id: string; modelSelection: { instanceId: string } } | null;
    turnResourceOwners: Map<string, TurnOwner>;
    directTurnGenerationByThread: Map<string, string>;
    directTurnBots: { delete(threadId: string): void };
  };
  cleanup: {
    stopScreenPoller(botId: string, threadId?: string): void;
    releaseLocalVmThread(threadId: string): void;
    closeOpenApprovals(threadId: string): void;
    revokeInternalCapabilitiesForThread(threadId: string): void;
    revokeAllInternalCapabilities(): void;
    runningTurnInstance(bot: { modelSelection: { instanceId: string } }, threadId: string): { adapter: { interruptTurn(threadId: string): Promise<unknown> } } | null | undefined;
    settleDirectFollowup(generation?: string): void;
    finalizeDelegationWatch(threadId: string, ok: boolean, reply?: string, failureName?: string): boolean;
    cancelGroupTurnOperations(groupId: string, threadId: string, outcome?: { status: "stopped" | "limit-reached"; detail: string }): void;
    cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
  };
  speakers: { groupSpeakers: SpeakerTable };
  vps: { vpsThreadEnded: (botId: string, threadId: string) => void };
  persistence: {
    saveConfig(patch: Partial<AppConfig>, options?: { replaceInstances?: boolean }): void;
    instanceConfigs(config: { instances?: ProviderFleetInstances }): InstanceConfigMap;
    resetPathCache(): void;
  };
  drains: {
    drainQueuedSends(): void;
    drainConnectorResumes(): void;
    drainSecretResumes(): void;
    drainTeamSetupResumes(): void;
    retryDelegationsWaitingOn(botId: string): void;
  };
}

export function createProviderFleet(deps: ProviderFleetDeps) {
  const {
    store, cfg, registry, bus, sessions: providerAuthSessions, watchdog, routines,
    desktop: managedDesktop, turns, companyShutdown,
    admission: {
      threadBusy, botForThread, turnResourceOwners, directTurnGenerationByThread, directTurnBots,
    },
    cleanup: {
      stopScreenPoller, releaseLocalVmThread, closeOpenApprovals,
      revokeInternalCapabilitiesForThread, revokeAllInternalCapabilities, runningTurnInstance,
      settleDirectFollowup, finalizeDelegationWatch, cancelGroupTurnOperations, cancelDirectTurnDispatch,
    },
    speakers: { groupSpeakers },
    vps: { vpsThreadEnded },
    persistence: { saveConfig, instanceConfigs, resetPathCache },
    drains: {
      drainQueuedSends, drainConnectorResumes, drainSecretResumes, drainTeamSetupResumes, retryDelegationsWaitingOn,
    },
  } = deps;
  const providerInstancesChanging = new Set<string>();
  let providerFleetReloading = false;

  /** End only Company conversations before replacing their native instances. */
  async function stopCompanyInstances(ids: string[]) {
    if (!ids.length) return;
    if (providerFleetReloading || companyShutdown()) {
      for (const id of ids) { providerAuthSessions.clearInstance(id); bus.detach(id); }
      return;
    }
    const selected = new Set(ids);
    for (const id of ids) providerInstancesChanging.add(id);
    const direct = store.bots.flatMap(bot => store.tasks(bot.id)
      .filter(task => threadBusy(bot.id, task.threadId) && selected.has(botForThread(bot.id, task.threadId)!.modelSelection.instanceId))
      .map(task => ({ botId: bot.id, threadId: task.threadId, owner: turnResourceOwners.get(task.threadId), generation: directTurnGenerationByThread.get(task.threadId) })));
    await Promise.all(direct.map(task => turns.interruptDirectThread(task.botId, task.threadId).catch(() => {})));
    for (const { botId, threadId, owner, generation } of direct) {
      turns.releaseTurnResources(owner);
      settleDirectFollowup(owner?.generation);
      // Another member of this cancellation batch can settle slowly while a
      // completed thread starts a personal turn. Never clear that new owner.
      if (directTurnGenerationByThread.get(threadId) !== generation) continue;
      stopScreenPoller(botId, threadId); releaseLocalVmThread(threadId);
      watchdog.settle(threadId); closeOpenApprovals(threadId); directTurnBots.delete(threadId);
      finalizeDelegationWatch(threadId, false, "", "Company connection changed");
      routines()?.failThread(threadId, "Company connection changed while this thread was running");
      if (store.taskByThread(botId, threadId)) {
        store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: "Company connection changed — choose whether to reconnect or use a personal model", ok: false } });
        store.setTaskActivity(botId, threadId, "idle");
      }
    }
    // Freeze this cancellation batch across interruptTurn's asynchronous yield.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [threadId, speaker] of [...groupSpeakers]) {
      if (groupSpeakers.get(threadId) !== speaker) continue;
      const bot = store.bot(speaker.botId);
      if (!bot || !selected.has(bot.modelSelection.instanceId)) continue;
      const group = store.groupByThread(threadId);
      const owner = turnResourceOwners.get(threadId);
      if (group) cancelGroupTurnOperations(group.id, threadId);
      revokeInternalCapabilitiesForThread(threadId);
      try {
        await runningTurnInstance(bot, threadId)?.adapter.interruptTurn(threadId);
      } catch {
        // a dying engine must not abort teardown for the rest of the batch
      }
      const stillOwned = groupSpeakers.get(threadId) === speaker &&
        turnResourceOwners.get(threadId)?.generation === owner?.generation;
      turns.releaseTurnResources(owner);
      if (!stillOwned) continue;
      releaseLocalVmThread(threadId);
      watchdog.settle(threadId); closeOpenApprovals(threadId);
      groupSpeakers.delete(threadId);
      if (group) store.patchGroup(group.id, { busyBotId: null });
      store.setActivity(bot.id, "idle");
    }
    for (const id of ids) { providerAuthSessions.clearInstance(id); bus.detach(id); }
  }

  async function persistProviderInstance(instanceId: string, instances: ProviderFleetInstances) {
    saveConfig({ instances }, { replaceInstances: true });
    cfg.instances = instances;
    providerAuthSessions.clearInstance(instanceId);
    bus.detach(instanceId);
    // No whole-fleet reload: other bots keep their live CLI processes, event
    // subscriptions and approval capabilities while this one is replaced.
    if (Object.hasOwn(instances, instanceId)) {
      await registry.load({ [instanceId]: instanceConfigs(cfg)[instanceId] });
      const live = registry.get(instanceId);
      if (live) bus.attach([live]);
    } else {
      await registry.dispose(instanceId);
    }
    resetPathCache();
  }

  /** Rebuild the provider fleet after a config change so new keys take
   * effect without a server restart (kills any in-flight turns). */
  async function reloadProviders() {
    providerFleetReloading = true;
    providerAuthSessions.clear();
    // Every provider process is about to die. Revoke all turn capabilities in
    // one synchronous step before the first teardown await, including room/task
    // threads that are not a bot's default DM.
    revokeAllInternalCapabilities();
    const direct = store.bots.flatMap((bot) => store.tasks(bot.id)
      .filter((task) => threadBusy(bot.id, task.threadId))
      .map((task) => ({ botId: bot.id, threadId: task.threadId, owner: turnResourceOwners.get(task.threadId) })));
    const rooms = [...groupSpeakers.entries()];
    for (const task of direct) cancelDirectTurnDispatch(task.botId, task.threadId);
    for (const [threadId] of rooms) {
      const group = store.groupByThread(threadId);
      if (group) cancelGroupTurnOperations(group.id, threadId);
    }
    bus.detachAll();
    try {
      await registry.disposeAll();
      await registry.load(instanceConfigs(cfg));
      // Personal providers are usable independently of the optional Company
      // overlay. Subscribe them before restoring that overlay so a broken or
      // expired Company runtime cannot leave the rebuilt personal fleet mute.
      bus.attach(registry.instances());
      await managedDesktop.restore();
    } finally {
      // Settle every exact conversation, not whichever one is selected now.
      // Teardown can swallow terminal events; no task may remain busy forever.
      for (const { botId, threadId, owner } of direct) {
        stopScreenPoller(botId, threadId);
        releaseLocalVmThread(threadId);
        turns.releaseTurnResources(owner);
        vpsThreadEnded(botId, threadId);
        watchdog.settle(threadId);
        closeOpenApprovals(threadId);
        directTurnBots.delete(threadId);
        finalizeDelegationWatch(threadId, false, "", "Delegated turn did not finish — provider settings changed");
        routines()?.failThread(threadId, "Provider settings changed while this thread was running");
        if (store.taskByThread(botId, threadId)) {
          store.appendMessage(threadId, {
            role: "bot", kind: "activity",
            tool: { name: "error: turn interrupted — provider settings changed", ok: false },
          });
          store.setTaskActivity(botId, threadId, "idle");
        }
        settleDirectFollowup(owner?.generation);
        retryDelegationsWaitingOn(botId);
      }
      for (const [threadId, speaker] of rooms) {
        releaseLocalVmThread(threadId);
        turns.releaseTurnResources(turnResourceOwners.get(threadId));
        watchdog.settle(threadId);
        closeOpenApprovals(threadId);
        if (groupSpeakers.get(threadId) !== speaker) continue;
        groupSpeakers.delete(threadId);
        const group = store.groupByThread(threadId);
        if (group) store.patchGroup(group.id, { busyBotId: null });
        store.setActivity(speaker.botId, "idle");
      }
      providerFleetReloading = false;
    }
    // killed turns settle here without a turn.completed event, so anything
    // queued behind them drains now — onto the freshly loaded fleet
    drainQueuedSends();
    drainConnectorResumes();
    drainSecretResumes();
    drainTeamSetupResumes();
  }

  return {
    stopCompanyInstances,
    persistProviderInstance,
    reloadProviders,
    providerInstancesChanging,
    get providerFleetReloading() { return providerFleetReloading; },
  };
}

export type ProviderFleet = ReturnType<typeof createProviderFleet>;
