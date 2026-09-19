// The app-config HTTP routes (GET/PUT/PATCH /api/config), extracted
// verbatim from index.ts's dispatch chain. Path matching, methods, status
// codes, and error messages are unchanged; the handler returns false for
// anything it does not own so the chain falls through in the same order.
// The config-write sequence is single-flighted against the provider
// instance routes through the shared providerConfigBusy accessor pair
// (index.ts owns the let); the local-VM mode-change flag crosses the same
// way and the image-busy flag as a thunk, matching the lifecycle
// factories. Everything else the family touches — the config views, the
// fleet reload, and the box/vps/composio/tts module calls — is either a
// direct module import or crosses through deps.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg, store } from "../runtime.ts";
import * as box from "../box.ts";
import * as composio from "../composio.ts";
import * as tts from "../tts/index.ts";
import * as vps from "../vps-computer.ts";
import {
  BrowserCleanupCoordinator,
  finalizeBrowserCleanupMutation,
  requireBrowserCleanupAcknowledged,
  type BrowserCleanupRequest,
} from "../browser-lifecycle-cleanup.ts";
import { browserSessionId } from "../browser-engine.ts";
import { boxCreateRecoverySnapshot, retireDeletedBoxCreate } from "../box-create-idempotency.ts";
import { boxDeletionSnapshot } from "../box-delete-journal.ts";
import { boxAccountResourceChangeError, vpsAliasResourceChangeError } from "../cloud-backend.ts";
import {
  builtInBrowserEnabled,
  browserProfilePartitionTarget,
  browserProfileReplacementConflict,
  loadConfig,
  localVmMode,
  parseConfigPatch,
  providerReloadKeys,
  saveConfig,
  sharedComputersEnabled,
  syncCredentialEnv,
  vpsSshAlias,
} from "../config.ts";
import { revokeAllInternalCapabilities } from "../internal-capabilities.ts";
import { SharedComputers } from "../shared-computers.ts";
import { SharedComputerControl } from "../shared-computer-control.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { createComputerLifecycle, RemoteComputerProvider } from "../computer-lifecycle.ts";
import type { createConfigViews } from "../config-views.ts";
import type { createDeferredResumes } from "../deferred-resumes.ts";
import type { createDelegationWatch } from "../delegation-watch.ts";
import type { createEventsRoutes } from "./events.ts";
import type { createLocalVmTurnPrep } from "../local-vm-turn-prep.ts";
import type { createProviderFleet } from "../provider-fleet.ts";
import type { createTurnIntegrations } from "../turn-integrations.ts";

export function createConfigRoutes(deps: {
  providerConfigBusy: { get: () => boolean; set: (value: boolean) => void };
  localVmModeChangeBusy: { get: () => boolean; set: (value: boolean) => void };
  localVmImageBusy: () => boolean;
  computerProviderConfigTransitions: ReturnType<typeof createComputerLifecycle>["computerProviderConfigTransitions"];
  localVmActiveThreads: ReturnType<typeof createComputerLifecycle>["localVmActiveThreads"];
  localVmLifecycleBusy: ReturnType<typeof createComputerLifecycle>["localVmLifecycleBusy"];
  perBotLocalVmCountForModeChange: ReturnType<typeof createLocalVmTurnPrep>["perBotLocalVmCountForModeChange"];
  managedBoxOwners: ReturnType<typeof createComputerLifecycle>["managedBoxOwners"];
  providerOperationConflict: ReturnType<typeof createComputerLifecycle>["providerOperationConflict"];
  configStatus: ReturnType<typeof createConfigViews>["configStatus"];
  configForAccess: ReturnType<typeof createConfigViews>["configForAccess"];
  sessions: SessionRegistry;
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  browserRuntime: ReturnType<typeof createTurnIntegrations>["browserRuntime"];
  browserLive: ReturnType<typeof createTurnIntegrations>["browserLive"];
  browserCleanup: BrowserCleanupCoordinator;
  sharedComputers: SharedComputers;
  sharedComputerControl: SharedComputerControl;
  reloadProviders: ReturnType<typeof createProviderFleet>["reloadProviders"];
  drainQueuedSends: () => void;
  drainDelegationWakes: ReturnType<typeof createDelegationWatch>["drainDelegationWakes"];
  drainConnectorResumes: ReturnType<typeof createDeferredResumes>["drainConnectorResumes"];
  drainSecretResumes: ReturnType<typeof createDeferredResumes>["drainSecretResumes"];
  drainTeamSetupResumes: ReturnType<typeof createDeferredResumes>["drainTeamSetupResumes"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url, auth } = rctx;
    const {
      providerConfigBusy, localVmModeChangeBusy, localVmImageBusy,
      computerProviderConfigTransitions, localVmActiveThreads, localVmLifecycleBusy,
      perBotLocalVmCountForModeChange, managedBoxOwners, providerOperationConflict,
      configStatus, configForAccess, sessions, broadcast,
      browserRuntime, browserLive, browserCleanup, sharedComputers, sharedComputerControl,
      reloadProviders, drainQueuedSends, drainDelegationWakes, drainConnectorResumes,
      drainSecretResumes, drainTeamSetupResumes,
    } = deps;
    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      json(res, 200, configForAccess(configStatus(), auth.scopes.includes("admin")));
      return true;
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch = parseConfigPatch(body);
      if (!Object.keys(patch).length) {
        json(res, 400, { error: "nothing to save" });
        return true;
      }
      const changingVoiceProvider = patch.tts?.provider !== undefined
        && patch.tts.provider !== tts.voiceProvider(cfg);
      if (changingVoiceProvider && patch.tts?.voice === undefined) {
        // Voice ids are provider-owned opaque values. Never carry a default
        // from one catalog into another. A caller may explicitly supply a
        // voice for the newly selected provider in this same atomic patch.
        patch.tts = { ...patch.tts, voice: "" };
      }
      if (providerConfigBusy.get()) {
        json(res, 409, { error: "provider settings are already being updated" });
        return true;
      }
      if (patch.browserProfiles !== undefined && body.expectedBrowserProfiles !== undefined) {
        const current = (cfg.browserProfiles ?? []).map(({ id, name }) => ({ id, name }));
        if (JSON.stringify(body.expectedBrowserProfiles) !== JSON.stringify(current)) {
          json(res, 409, { error: "Browser profiles changed in another window. Review the refreshed list and try again." });
          return true;
        }
      }
      const disablingBuiltInBrowser = patch.features?.browser === false && builtInBrowserEnabled(cfg);
      const removedBrowserProfileIds = patch.browserProfiles === undefined
        ? []
        : (cfg.browserProfiles ?? [])
            .map((profile) => profile.id)
            .filter((id) => !patch.browserProfiles!.some((profile) => profile.id === id));
      const profileControlConflict = () => removedBrowserProfileIds.some((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        return target && browserRuntime.heldBy(browserSessionId("", target.partitionId));
      });
      if (profileControlConflict()) {
        json(res, 409, { error: "Release browser control before deleting its profile." });
        return true;
      }
      if (patch.browserProfiles !== undefined) {
        const currentProfiles = new Map((cfg.browserProfiles ?? []).map((profile) => [profile.id, profile]));
        const nextProfiles = patch.browserProfiles.map((profile) => {
          const partitionId = currentProfiles.get(profile.id)?.partitionId;
          return partitionId ? { ...profile, partitionId } : profile;
        });
        const routingConflict = browserProfileReplacementConflict(cfg.browserProfiles ?? [], nextProfiles);
        if (routingConflict) {
          json(res, 409, { error: routingConflict });
          return true;
        }
        const currentIds = new Set((cfg.browserProfiles ?? []).map((profile) => profile.id));
        const pendingReuse = patch.browserProfiles.find(
          (profile) => !currentIds.has(profile.id) && browserCleanup.hasPendingProfile(profile.id),
        );
        if (pendingReuse) {
          json(res, 409, {
            error: `the previous “${pendingReuse.name}” browser session is still being erased — wait before reusing it`,
          });
          return true;
        }
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
          return true;
        }
      }
      if (patch.box?.token !== undefined) patch.box.token = patch.box.token.trim();
      const currentBoxToken = cfg.box?.token?.trim() ?? "";
      const nextBoxToken = patch.box?.token === undefined ? currentBoxToken : patch.box.token;
      const changingBoxToken = patch.box?.token !== undefined && nextBoxToken !== currentBoxToken;
      const currentVpsAlias = vpsSshAlias(cfg);
      const nextVpsAlias = patch.vps === undefined
        ? currentVpsAlias
        : vpsSshAlias({ ...cfg, vps: patch.vps });
      const changingVpsAlias = patch.vps !== undefined && nextVpsAlias !== currentVpsAlias;
      const transitioningProviders: RemoteComputerProvider[] = [
        ...(changingBoxToken ? ["box" as const] : []),
        ...(changingVpsAlias ? ["vps" as const] : []),
      ];
      providerConfigBusy.set(true);
      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== localVmMode(cfg);
      if (changingLocalVmMode) localVmModeChangeBusy.set(true);
      try {
        for (const provider of transitioningProviders) {
          const conflict = providerOperationConflict(provider);
          if (conflict) {
            json(res, 409, { error: conflict });
            return true;
          }
        }
        for (const provider of transitioningProviders) computerProviderConfigTransitions.add(provider);

        if (changingVpsAlias && currentVpsAlias) {
          const inventory = await vps.listManagedVpsComputers(
            { vps: { sshAlias: currentVpsAlias } },
            managedBoxOwners(),
          );
          if (!inventory.available) {
            json(res, 503, {
              error: `${inventory.problem ?? "VPS computer inventory is unavailable"}. Keep the current SSH config alias and retry`,
            });
            return true;
          }
          const resourceError = vpsAliasResourceChangeError(inventory.instances.length);
          if (resourceError) {
            json(res, 409, { error: resourceError });
            return true;
          }
        }

        let boxRecovery = changingBoxToken ? boxCreateRecoverySnapshot() : [];
        let boxDeletions = changingBoxToken ? boxDeletionSnapshot() : [];
        if (changingBoxToken && boxDeletions.length > 0 && !nextBoxToken) {
          json(res, 409, {
            error: "finish or retry pending cloud computer deletion before removing the Box account",
          });
          return true;
        }
        let replacementProvedByDeletion = false;
        if (changingBoxToken && boxDeletions.length > 0 && nextBoxToken) {
          try {
            await box.verifyBoxDeletionCredential({ box: { token: nextBoxToken } });
            replacementProvedByDeletion = true;
            // Verification can observe a completed operation and retire both
            // its deletion fence and matching create receipt. Never continue
            // with the pre-verification snapshots: they would demand access
            // to a Box whose exact operation just proved it was deleted.
            boxRecovery = boxCreateRecoverySnapshot();
            boxDeletions = boxDeletionSnapshot();
          } catch (error) {
            json(res, (error as { status?: number })?.status ?? 503, {
              error: error instanceof Error ? error.message : String(error),
            });
            return true;
          }
        }
        let currentBoxInventory: box.ManagedBoxInventory | null = null;
        let currentBoxResources: Array<{ boxId: string; name: string }> | null = null;
        const journalBoxResources: Array<{ boxId: string; name: string }> = [];
        const deletingBoxIds = new Set(boxDeletions.map((entry) => entry.boxId));
        if (changingBoxToken && currentBoxToken) {
          currentBoxInventory = await box.listManagedBoxes(
            { box: { token: currentBoxToken } },
            managedBoxOwners(),
          );
          if (!currentBoxInventory.available) {
            if (!replacementProvedByDeletion) {
              json(res, 503, {
                error: `${currentBoxInventory.problem ?? "cloud computer inventory is unavailable"}. Keep the current Box account and retry`,
              });
              return true;
            }
            // The old token may be the reason this deletion is stuck. A
            // target-bound operation/identity proved the replacement belongs
            // to the same account, so do not deadlock credential recovery on
            // an inventory request made with the expired token.
            currentBoxInventory = null;
          }
          if (currentBoxInventory) {
            const currentById = new Map(
              currentBoxInventory.instances.map((instance) => [instance.boxId, { boxId: instance.boxId, name: instance.name }]),
            );
            for (const recovery of boxRecovery) {
              if (!recovery.boxId) continue;
              // A failed provisioning attempt may never have reached the
              // deterministic rename. The replacement credential already
              // proved the exact deletion target, so its in-flight resource
              // is governed by that stronger target-bound receipt rather
              // than an OpenMausBot name check.
              if (replacementProvedByDeletion && deletingBoxIds.has(recovery.boxId)) continue;
              const inspected = await box.inspectBoxIdentity({ box: { token: currentBoxToken } }, recovery.boxId);
              if (!inspected.available) {
                json(res, 503, {
                  error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Keep the current Box account and retry`,
                });
                return true;
              }
              if (!inspected.identity) {
                // Reconcile exact stale receipts while the current credential is
                // still available. Leaving one behind would make a later token
                // addition demand access to a Box the provider proved is gone.
                retireDeletedBoxCreate(recovery.boxId);
                continue;
              }
              const listed = currentById.get(inspected.identity.boxId);
              if (listed && listed.name !== inspected.identity.name) {
                json(res, 503, { error: "ascii.dev returned conflicting cloud computer identities; keep the current Box account and retry" });
                return true;
              }
              currentById.set(inspected.identity.boxId, inspected.identity);
              journalBoxResources.push(inspected.identity);
            }
            currentBoxResources = [...currentById.values()];
          }
        }

        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy()) {
            json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
            return true;
          }
          if (localVmMode(cfg) === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
              return true;
            }
            if (existing > 0) {
              json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
              return true;
            }
          }
        }
      // A project key is useful only if it can create/reuse the Session that
      // powers both the connections UI and the agent MCP. Validate it before
      // persisting, and save the non-secret ids needed to reuse that Session.
      const requestedComposioKey = patch.composio?.apiKey;
      if (requestedComposioKey !== undefined) {
        if (requestedComposioKey.trim()) {
          try {
            const prepared = await composio.prepareProjectSession(requestedComposioKey, cfg.composio);
            patch.composio = { ...patch.composio, ...prepared };
          } catch (error) {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) });
            return true;
          }
        } else {
          patch.composio = { ...patch.composio, apiKey: "", sessionId: "" };
        }
      }
      // check a box token against the provider before storing it: a
      // rejected token used to save happily and only surface as a 401 in
      // another panel later, with nothing the user could act on
      const newBoxToken = patch.box?.token;
      if (newBoxToken?.trim()) {
        const check = await box.verifyToken(newBoxToken);
        if (!check.ok) {
          json(res, 400, { error: check.message });
          return true;
        }
      }
      if (changingBoxToken && (!currentBoxToken || replacementProvedByDeletion) && boxRecovery.length > 0) {
        if (!nextBoxToken) {
          json(res, 409, { error: "restore the Box account that owns the remembered cloud computers before clearing it" });
          return true;
        }
        for (const recovery of boxRecovery) {
          if (!recovery.boxId) {
            json(res, 409, { error: "finish reconciling pending cloud computer creation before changing the Box account" });
            return true;
          }
          if (replacementProvedByDeletion && deletingBoxIds.has(recovery.boxId)) continue;
          const inspected = await box.inspectBoxIdentity({ box: { token: nextBoxToken } }, recovery.boxId);
          if (!inspected.available) {
            json(res, 503, {
              error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Retry with the Box account that created it`,
            });
            return true;
          }
          if (!inspected.identity || !(await box.boxNameMatchesBot(recovery.botId, inspected.identity.name))) {
            json(res, 409, { error: "that Box token cannot access the remembered cloud computers from this installation" });
            return true;
          }
        }
      }
      if (changingBoxToken && currentBoxInventory && currentBoxResources) {
        let replacementResources: Array<{ boxId: string; name: string }> | null = null;
        if (nextBoxToken) {
          const replacementInventory = await box.listManagedBoxes(
            { box: { token: nextBoxToken } },
            managedBoxOwners(),
            { adoptLegacy: false },
          );
          if (!replacementInventory.available) {
            json(res, 503, {
              error: `${replacementInventory.problem ?? "cloud computer inventory is unavailable"}. Keep the current Box account and retry`,
            });
            return true;
          }
          replacementResources = replacementInventory.instances.map((instance) => ({
            boxId: instance.boxId,
            name: instance.name,
          }));
          const replacementById = new Map(
            replacementResources.map((instance) => [instance.boxId, { boxId: instance.boxId, name: instance.name }]),
          );
          for (const identity of journalBoxResources) {
            const inspected = await box.inspectBoxIdentity({ box: { token: nextBoxToken } }, identity.boxId);
            if (!inspected.available) {
              json(res, 503, {
                error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Keep the current Box account and retry`,
              });
              return true;
            }
            if (!inspected.identity || inspected.identity.name !== identity.name) {
              json(res, 409, { error: "the replacement Box token does not access the same cloud computers" });
              return true;
            }
            replacementById.set(inspected.identity.boxId, inspected.identity);
          }
          replacementResources = [...replacementById.values()];
        }
        const resourceError = boxAccountResourceChangeError(
          currentBoxResources,
          replacementResources,
        );
        if (resourceError) {
          json(res, 409, { error: resourceError });
          return true;
        }
      }
      // Each cloud voice provider owns its own credential. Validate the field
      // against that provider rather than whichever provider happens to be
      // selected, so switching engines never sends one service another's key.
      const newTts = patch.tts;
      if (newTts?.key?.trim()) {
        const check = await tts.verifyKey("elevenlabs", newTts.key.trim());
        if (!check.ok) {
          json(res, 400, { error: check.message });
          return true;
        }
      }
      if (newTts?.fishKey?.trim()) {
        const check = await tts.verifyKey("fish", newTts.fishKey.trim());
        if (!check.ok) {
          json(res, 400, { error: check.message });
          return true;
        }
      }
      if (patch.browserProfiles !== undefined) {
        // Provider/credential validation above may await the network. A turn
        // can start during that window and claim a profile which looked idle
        // at the route's first check, so validate again at the mutation
        // boundary. Keep this check and the synchronous save/reference cleanup
        // below free of awaits.
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
          return true;
        }
      }
      // Provider validation above awaits remote services. The transition flag
      // blocks new work, while this second observation catches any operation
      // that already held a claim at the initial boundary.
      for (const provider of transitioningProviders) {
        const conflict = providerOperationConflict(provider);
        if (conflict) {
          json(res, 409, { error: conflict });
          return true;
        }
      }
      const browserCleanupRequests: BrowserCleanupRequest[] = [];
      if (profileControlConflict()) {
        json(res, 409, { error: "Release browser control before deleting its profile." });
        return true;
      }
      try {
        for (const profileId of removedBrowserProfileIds) {
          const target = browserProfilePartitionTarget(cfg, profileId);
          if (!target) throw new Error(`browser profile cleanup target “${profileId}” is unavailable`);
          browserCleanupRequests.push(
            browserCleanup.prepare("profile", target.profileId, target.partitionId),
          );
        }
      } catch (error) {
        for (const request of browserCleanupRequests) browserCleanup.abort(request);
        throw error;
      }
      let configWriteCommitted = false;
      const externalSecretStorage = url.searchParams.get("secretStorage") === "external";
      try {
        // Provider-owned voice ids must be invalidated before the provider
        // commit. If bots.json cannot be written, leave the old provider in
        // place rather than committing a new provider with stale bot voices.
        // A later config-write failure may leave voices cleared, which is the
        // safe side of this cross-file mutation: no foreign id can be spoken.
        if (changingVoiceProvider) store.clearVoiceSelections();
        if (externalSecretStorage) {
          // The packaged Electron caller commits supplied credentials to the
          // OS-encrypted store before entering this route. Persist every
          // non-secret sibling in the same request, but replace each supplied
          // credential with an empty tombstone so an older plaintext value can
          // never survive the merge in config.json.
          const persisted = structuredClone(patch);
          if (persisted.xai?.key !== undefined) persisted.xai.key = "";
          if (persisted.composio?.apiKey !== undefined) persisted.composio.apiKey = "";
          if (persisted.box?.token !== undefined) persisted.box.token = "";
          if (persisted.opencodeGo?.apiKey !== undefined) persisted.opencodeGo.apiKey = "";
          if (persisted.tts?.key !== undefined) persisted.tts.key = "";
          if (persisted.tts?.fishKey !== undefined) persisted.tts.fishKey = "";
          if (persisted.imageGen?.key !== undefined) persisted.imageGen.key = "";
          if (persisted.imageGen?.customApiKey !== undefined) persisted.imageGen.customApiKey = "";
          saveConfig(persisted);
          configWriteCommitted = true;
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        } else {
          saveConfig(patch);
          configWriteCommitted = true;
          // loadConfig prefers env over the file for credentials, so the env
          // must follow the save — otherwise the value injected at boot would
          // shadow the new key until the next launch
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        }
      } catch (error) {
        if (configWriteCommitted) {
          for (const request of browserCleanupRequests) {
            const committed = browserCleanup.commit(request);
            void browserCleanup.ensure(committed);
          }
        } else {
          for (const request of browserCleanupRequests) browserCleanup.abort(request);
        }
        throw error;
      }
      let browserReferenceCleanupError: unknown = null;
      if (patch.signIn !== undefined) sessions.revalidateEmailSessions();
      if (!sharedComputersEnabled(cfg)) {
        sharedComputers.close();
        sharedComputerControl.close();
      }
      if (disablingBuiltInBrowser) browserLive.closeAll();
      for (const request of browserCleanupRequests) {
        if (request.kind === "profile") browserLive.closeForSession(browserSessionId("", request.partitionId));
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        try {
          for (const bot of store.bots) {
            if (bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile)) {
              // The profile list and every bot reference change in the same
              // config request. Non-renderer clients therefore cannot leave a
              // bot pointing at a deleted cookie partition.
              store.patchBot(bot.id, { browserProfile: undefined });
            }
          }
        } catch (error) {
          // Config is already durable. Keep the cleanup intent prepared (so
          // it cannot wipe ambiguous state and its id remains locked), but do
          // not let this secondary write failure skip revocation/reload below.
          browserReferenceCleanupError = error;
        }
      }
      // Provider keys change the fleet. Profile, language, voice, VPS, room
      // timeout, and onboarding progress changes do not rebuild it: no driver
      // reads them, and they should not interrupt in-flight turns.
      const reloadKeys = providerReloadKeys(patch);
      // Config is already durable. A provider credential or runtime change
      // invalidates every old child immediately, including when browser
      // cleanup below has to await Electron before reloadProviders begins.
      if (reloadKeys.length > 0) revokeAllInternalCapabilities();
      // The cleanup marker becomes committed only after both pieces of durable
      // application state agree. Commit/ACK failures are deferred until every
      // mandatory consequence of the config write has run: no journal I/O
      // failure may leave a two-hour bearer or stale provider fleet active.
      const finalized = await finalizeBrowserCleanupMutation({
        requests: browserCleanupRequests,
        referenceError: browserReferenceCleanupError,
        commit: (request) => browserCleanup.commit(request),
        ensure: (request) => browserCleanup.ensure(request),
        mandatory: async () => {
          let mandatoryError: unknown = null;
          if (disablingBuiltInBrowser) {
            try {
            } catch (error) {
              mandatoryError = error;
            }
          }
          if (reloadKeys.length > 0) {
            try {
              await reloadProviders();
            } catch (error) {
              if (!mandatoryError) mandatoryError = error;
            }
          }
          const status = configStatus();
          broadcast({ kind: "config", ...status });
          if (patch.threads !== undefined) {
            drainQueuedSends();
            drainDelegationWakes();
            drainConnectorResumes();
            drainSecretResumes();
            drainTeamSetupResumes();
          }
          if (mandatoryError) throw mandatoryError;
          return status;
        },
      });
      // Normal desktop deletes wait for Electron's acknowledgement. If
      // Electron is restarting, the committed journal keeps retrying and the
      // id-reuse guard above prevents stale logins from resurfacing. Delaying
      // this assertion until after every mandatory post-commit effect keeps
      // the runtime aligned with the config even on a truthful 503 response.
      requireBrowserCleanupAcknowledged(
        finalized.acknowledgements.every(Boolean),
        removedBrowserProfileIds.length === 1 ? "The browser profile" : "The browser profiles",
      );
      json(res, 200, finalized.value);
      return true;
      } finally {
        for (const provider of transitioningProviders) computerProviderConfigTransitions.delete(provider);
        if (changingLocalVmMode) localVmModeChangeBusy.set(false);
        providerConfigBusy.set(false);
      }
    }
    return false;
  };
}
