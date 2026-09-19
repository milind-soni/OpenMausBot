// The bot deletion lifecycle -- the preflight-and-teardown path that guards
// provider-owned computers, Local VM containers, phone-secret mutations and
// team-setup resumes while a reviewed bot reference is erased -- extracted
// verbatim from index.ts. index.ts calls createBotLifecycle at the
// function's original site (just above the team-setup wiring) and rebinds
// deleteBotWithLifecycle from its result. The computer/turn/browser and
// deferred-resume names it reads were already-initialized consts and
// functions above that site, so they cross by value; routines and
// calendarCalls are index.ts lets, localVmModeChangeBusy is a mutated let,
// and webhooks plus claimPhoneSecretBotDeletion are declared after the
// wiring site (the old function relied on hoisting), so all of those read
// through thunks that preserve call-time resolution.
import { existsSync } from "node:fs";
import { rm as removeDirectory } from "node:fs/promises";
import * as box from "./box.ts";
import { boxCreateRecoverySnapshot } from "./box-create-idempotency.ts";
import { boxDeletionSnapshot } from "./box-delete-journal.ts";
import { requireBrowserCleanupAcknowledged, type BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import {
  containerComputerAction,
  containerComputerStatus,
  perBotLocalVmTarget,
  type LocalVmTarget,
} from "./container-computer.ts";
import { localVmMode, vpsSshAlias } from "./config.ts";
import { discardDelegations } from "./delegations.ts";
import { revokeInternalCapabilitiesForThread } from "./internal-capabilities.ts";
import { cancelPeerApprovalsFor } from "./peer-approval.ts";
import { cfg, store } from "./runtime.ts";
import { directTurnBots, hasDirectDispatch } from "./turn-admission.ts";
import * as vps from "./vps-computer.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import type { RoutineManager } from "./routines.ts";
import type { CalendarCallManager } from "./calendar-calls.ts";
import type { WebhookManager } from "./webhooks.ts";
import type { createComputerLifecycle } from "./computer-lifecycle.ts";
import type { createTurnIntegrations } from "./turn-integrations.ts";
import type { createGroupTurnOperations } from "./group-turn-operations.ts";
import type { createDelegationWatch } from "./delegation-watch.ts";
import type { createScreenPollers } from "./screen-pollers.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";
import type { createRoutineLifecycle } from "./routine-lifecycle.ts";
import type { createDeferredResumes } from "./deferred-resumes.ts";

type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;

/** Everything the deletion lifecycle reads from its host. The computer and
 * turn registries arrive by value from their factories' results; the
 * lateBound slice reads index.ts state that is reassigned or declared after
 * the wiring site. */
export interface BotLifecycleDeps {
  computer: {
    computerProviderConfigTransitions: ComputerLifecycle["computerProviderConfigTransitions"];
    boxLifecycleBusyBots: ComputerLifecycle["boxLifecycleBusyBots"];
    claimBotComputerLifecycle: ComputerLifecycle["claimBotComputerLifecycle"];
    managedBoxOwners: ComputerLifecycle["managedBoxOwners"];
    localVmOwnerBusy: ComputerLifecycle["localVmOwnerBusy"];
    localVmLeases: ComputerLifecycle["localVmLeases"];
    localVmLeaseFor: ComputerLifecycle["localVmLeaseFor"];
    localVmActiveThreads: ComputerLifecycle["localVmActiveThreads"];
    localVmLifecycleBusy: ComputerLifecycle["localVmLifecycleBusy"];
    localVmSeen: ComputerLifecycle["localVmSeen"];
    localVmIdles: ComputerLifecycle["localVmIdles"];
    activeVpsThreads: ComputerLifecycle["activeVpsThreads"];
    computerControl: TurnIntegrations["computerControl"];
    computerControlRevision: TurnIntegrations["computerControlRevision"];
  };
  helpers: {
    activeGroupTurnForBot: ReturnType<typeof createGroupTurnOperations>["activeGroupTurnForBot"];
    interruptAllDirectThreads(botId: string): Promise<void>;
    purgeGeneratedImagesForThread: TurnIntegrations["purgeGeneratedImagesForThread"];
    settleDirectFollowup: ReturnType<typeof createDelegationWatch>["settleDirectFollowup"];
    directTurnGenerationByThread: Map<string, string>;
    stopScreenPoller: ReturnType<typeof createScreenPollers>["stopScreenPoller"];
    lastReply: ReturnType<typeof createEventsPipeline>["lastReply"];
    browserCleanup: BrowserCleanupCoordinator;
    browserLive: TurnIntegrations["browserLive"];
    forgetTemporaryBrowser: TurnIntegrations["forgetTemporaryBrowser"];
    commsBus: ReturnType<typeof createRoutineLifecycle>["commsBus"];
    pendingTeamSetupResumes: ReturnType<typeof createDeferredResumes>["pendingTeamSetupResumes"];
    cancelTeamSetupResumesForThread: ReturnType<typeof createDeferredResumes>["cancelTeamSetupResumesForThread"];
  };
  lateBound: {
    routines(): RoutineManager | null;
    calendarCalls(): CalendarCallManager | null;
    localVmModeChangeBusy(): boolean;
    webhooks(): WebhookManager;
    claimPhoneSecretBotDeletion(botId: string): (() => void) | null;
  };
}

export function createBotLifecycle(deps: BotLifecycleDeps) {
  const {
    computerProviderConfigTransitions, boxLifecycleBusyBots, claimBotComputerLifecycle, managedBoxOwners,
    localVmOwnerBusy, localVmLeases, localVmLeaseFor, localVmActiveThreads, localVmLifecycleBusy,
    localVmSeen, localVmIdles, activeVpsThreads, computerControl, computerControlRevision,
  } = deps.computer;
  const {
    activeGroupTurnForBot, interruptAllDirectThreads, purgeGeneratedImagesForThread,
    settleDirectFollowup, directTurnGenerationByThread, stopScreenPoller, lastReply,
    browserCleanup, browserLive, forgetTemporaryBrowser, commsBus,
    pendingTeamSetupResumes, cancelTeamSetupResumesForThread,
  } = deps.helpers;
  const { routines, calendarCalls, localVmModeChangeBusy, webhooks, claimPhoneSecretBotDeletion } = deps.lateBound;

async function deleteBotWithLifecycle(botId: string, revalidate: () => void = () => {}, setupRequest?: TeamSetupRequest) {
  const deletionResponse = (status: number, body: { error?: string; ok?: boolean }) => ({ status, body });
      revalidate();
      const bot = store.bot(botId);
      if (!bot) return deletionResponse( 404, { error: "no such bot" });
      if (computerProviderConfigTransitions.size > 0) {
        return deletionResponse( 409, { error: "computer provider settings are being updated — wait before deleting this bot" });
      }
      if (localVmModeChangeBusy()) {
        return deletionResponse(409, { error: "Local VM settings are being updated — wait before deleting this bot" });
      }
      if (boxLifecycleBusyBots.has(bot.id)) {
        return deletionResponse( 409, { error: "wait for this bot's cloud computer action to finish before deleting the bot" });
      }
      const activeRoutine = routines()!.activeRunForBot(bot.id);
      if (activeRoutine) {
        return deletionResponse( 409, {
          error: "stop this bot's active routine before deleting the bot",
        });
      }
      const activeGroup = activeGroupTurnForBot(bot.id);
      if (activeGroup) {
        return deletionResponse( 409, {
          error: `stop this bot's work in channel ${activeGroup.group.name} before deleting the bot`,
        });
      }
      // A direct turn that has already claimed the bot can provision a Box in
      // its background setup. Do not let deletion race that work while a Box
      // account is configured; the person can stop the turn and retry.
      if ((box.boxConfigured(cfg) || vpsSshAlias(cfg)) && (bot.busy || hasDirectDispatch(bot.id))) {
        return deletionResponse( 409, { error: "stop this bot's work before checking and deleting its cloud computer" });
      }
      const botBoxRecovery = boxCreateRecoverySnapshot().filter((entry) => entry.botId === bot.id);
      const botBoxDeletions = boxDeletionSnapshot().filter((entry) => entry.ownerBotId === bot.id);
      if (botBoxRecovery.some((entry) => !entry.resolved)) {
        return deletionResponse( 409, {
          error: "finish reconciling this bot's pending cloud computer creation before deleting it — check ascii.dev, then retry Box setup",
        });
      }
      // Bot deletion awaits VM/browser/provider cleanup. Claim the bot and
      // every channel it belongs to before that first await so a phone save
      // cannot begin halfway through teardown (or vice versa). The computer
      // lifecycle claim is synchronous too, so either both claims are held or
      // neither survives this request.
      const releaseComputerLifecycle = claimBotComputerLifecycle(bot.id);
      const releasePhoneSecretMutation = claimPhoneSecretBotDeletion(bot.id);
      if (!releasePhoneSecretMutation) {
        releaseComputerLifecycle();
        return deletionResponse( 409, { error: "this bot or one of its channels is securely saving a credential" });
      }
      let claimedLocalVmTarget: LocalVmTarget | null = null;
      try {
        let localVmCleanup: { target: LocalVmTarget; removeContainer: boolean } | null = null;
        if (localVmMode(cfg) === "per-bot") {
          const target = perBotLocalVmTarget(bot.id);
          if (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key)) {
            return deletionResponse( 409, { error: "stop this bot's Local VM turn or setup action before deleting the bot" });
          }
          if (localVmLeaseFor(target).current(localVmOwnerBusy)) {
            return deletionResponse(409, { error: "stop this bot's Local VM turn before deleting the bot" });
          }
          // Hold the target from preflight through deletion. A simultaneous
          // mode change or lifecycle route must not recreate the container
          // after we checked it and before its bot owner disappears.
          localVmLifecycleBusy.add(target.key);
          claimedLocalVmTarget = target;
          const vm = await containerComputerStatus(undefined, undefined, target);
          if (!vm.daemonUp && existsSync(target.workspaceDir)) {
            return deletionResponse( 409, {
              error: "start the container runtime so OpenMausBot can remove this bot's Local VM while deleting it",
            });
          }
          if (vm.container !== "missing" && !vm.managed) {
            return deletionResponse(409, {
              error: `The container named ${vm.container_name} was not created by OpenMausBot. Remove it manually before deleting this bot`,
            });
          }
          localVmCleanup = {
            target,
            removeContainer: vm.container !== "missing",
          };
        }

        // Preflight every provider before deleting any resource. Cleanup can
        // still fail mid-flight across independent providers, but a missing
        // credential or offline daemon should not cause avoidable partial work.
        const vpsInventory = await vps.listManagedVpsComputers(cfg, managedBoxOwners());
        if (vpsInventory.configured && !vpsInventory.available) {
          return deletionResponse( 503, {
            error: `${vpsInventory.problem ?? "VPS computer inventory is unavailable"}. The bot was kept so its computer can be retried safely`,
          });
        }
        const ownedVpsComputers = vpsInventory.instances.filter((instance) => instance.ownerBotId === bot.id);

        if ((botBoxRecovery.length > 0 || botBoxDeletions.length > 0) && !box.boxConfigured(cfg)) {
          return deletionResponse(409, {
            error: "Reconnect the Box account that owns this bot's remembered cloud computer, then retry deletion",
          });
        }
        const cloudInventory = await box.listManagedBoxes(cfg, managedBoxOwners());
        if (cloudInventory.configured && !cloudInventory.available) {
          return deletionResponse( 503, {
            error: `${cloudInventory.problem ?? "cloud computer inventory is unavailable"}. The bot was kept so its computer can be retried safely`,
          });
        }
        const ownedBoxComputers = cloudInventory.instances.filter((instance) => instance.ownerBotId === bot.id);

        // Revalidate a reviewed Chief-of-Staff request and establish the
        // browser cleanup intent before the first irreversible provider
        // mutation. A stale review or damaged journal therefore leaves every
        // computer intact. Cross-provider rollback is impossible, so every
        // subsequent operation is exact and retry-safe.
        revalidate();
        const browserCleanupRequest = browserCleanup.prepare("bot", bot.id);
        try {
          // Provider-owned computers are durable, billable resources. Remove
          // each exact, freshly revalidated identity before making its bot
          // owner disappear. Shared team computers use a different owner id
          // and are intentionally absent from these lists.
          for (const instance of ownedBoxComputers) {
            const removed = await box.deleteManagedBox(cfg, managedBoxOwners(), instance.boxId, instance.name);
            if (removed.pending) {
              throw Object.assign(
                new Error("The cloud computer deletion has started but is still finishing. The bot was kept; retry in a moment"),
                { status: 409 },
              );
            }
          }
          for (const instance of ownedVpsComputers) {
            await vps.removeManagedVpsComputer(cfg, managedBoxOwners(), instance.name, instance.name);
          }
          if (localVmCleanup) {
            if (localVmCleanup.removeContainer) {
              await containerComputerAction("remove", undefined, undefined, localVmCleanup.target);
            }
            // Unlike the standalone "Delete VM" action, deleting the bot is
            // a complete erasure: its now-ownerless desktop files and browser
            // session must not remain hidden on disk or block the event loop.
            await removeDirectory(localVmCleanup.target.workspaceDir, { recursive: true, force: true });
            localVmSeen.delete(localVmCleanup.target.key);
            localVmIdles.get(localVmCleanup.target.key)?.cancel();
            localVmIdles.delete(localVmCleanup.target.key);
            localVmLeases.forget(localVmCleanup.target.key);
          }
          // a running turn dies with its bot
          // Invalidate every bot-callable bearer before the first asynchronous
          // teardown step. A request that already passed its initial header
          // check is revalidated after its body arrives and must fail closed.
          for (const entry of pendingTeamSetupResumes.values()) {
            if (entry.request.botId === bot.id) cancelTeamSetupResumesForThread(entry.request.threadId);
          }
          for (const task of store.tasks(bot.id)) {
            cancelTeamSetupResumesForThread(task.threadId);
            revokeInternalCapabilitiesForThread(task.threadId);
          }
          await interruptAllDirectThreads(bot.id);
          // Deletion removes the thread before a late turn.completed can fold
          // staged provider images into a message, so dispose them here.
          for (const task of store.tasks(bot.id)) {
            purgeGeneratedImagesForThread(task.threadId);
            settleDirectFollowup(directTurnGenerationByThread.get(task.threadId));
            directTurnGenerationByThread.delete(task.threadId);
            directTurnBots.delete(task.threadId);
          }
          stopScreenPoller(bot.id);
          activeVpsThreads.delete(bot.id);
          lastReply.delete(bot.threadId);
          // a peer approval naming this bot can never be meaningfully answered
          // now, and its caller would otherwise wait out the 15-minute timeout
          cancelPeerApprovalsFor(bot.id);
          discardDelegations(commsBus, bot.threadId);
          computerControl.forget(bot.id);
          computerControlRevision.delete(bot.id);
          const target = perBotLocalVmTarget(bot.id);
          localVmIdles.get(target.key)?.cancel();
          localVmIdles.delete(target.key);
          // Provider and local-computer teardown above can await for an
          // arbitrary amount of time. A reviewed Chief deletion is bound to
          // the exact target profile it presented; re-check that receipt at
          // the final durable mutation boundary so a concurrent profile edit
          // cannot be erased under a stale approval.
          revalidate();
          store.deleteBot(bot.id, setupRequest);
          // Removing schedules is not a security revocation. Keep them intact
          // if the bot/receipt write fails, so a failed deletion is retryable.
          routines()!.disableForBot(bot.id);
          webhooks().disableForBot(bot.id);
          calendarCalls()!.removeBot(bot.id);
          browserLive.closeForBot(bot.id);
          await forgetTemporaryBrowser(bot.id);
        } catch (error) {
          if (browserCleanupRequest) {
            // Store removal is already durable once the in-memory owner is
            // gone. A later cleanup error must retain its browser erasure
            // intent for retry instead of aborting a completed deletion.
            if (store.bot(bot.id)) browserCleanup.abort(browserCleanupRequest);
            else browserCleanup.commit(browserCleanupRequest);
          }
          throw error;
        }
        if (browserCleanupRequest) {
          const committedCleanup = browserCleanup.commit(browserCleanupRequest);
          const acknowledged = await browserCleanup.ensure(committedCleanup);
          requireBrowserCleanupAcknowledged(acknowledged, `Browser data for ${bot.name}`);
        }
        return deletionResponse( 200, { ok: true });
      } finally {
        if (claimedLocalVmTarget) localVmLifecycleBusy.delete(claimedLocalVmTarget.key);
        releaseComputerLifecycle();
        releasePhoneSecretMutation();
      }
}

  return { deleteBotWithLifecycle };
}
