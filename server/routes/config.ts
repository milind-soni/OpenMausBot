import * as boat from "../boat.ts";
import { boatCreateRecoverySnapshot, retireDeletedBoatCreate } from "../boat-create-idempotency.ts";
import { boatDeletionSnapshot } from "../boat-delete-journal.ts";
import { browserEngineStatus, browserSessionId } from "../browser-engine.ts";
import { browserEngineKind } from "../browser/config.ts";
import type { BrowserCleanupCoordinator, BrowserCleanupRequest } from "../browser-lifecycle-cleanup.ts";
import { finalizeBrowserCleanupMutation, requireBrowserCleanupAcknowledged } from "../browser-lifecycle-cleanup.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import { boatAccountResourceChangeError, vpsAliasResourceChangeError } from "../cloud-backend.ts";
import { CLOUD_PERSONAL_REFUSAL } from "../cloud-owner.ts";
import * as composio from "../composio.ts";
import {
  browserProfilePartitionTarget,
  browserProfileReplacementConflict,
  builtInBrowserEnabled,
  changedInstanceIds,
  engineLaunches,
  loadConfig,
  localVmMode,
  mergeOpenCodeProviderKeys,
  parseConfigPatch,
  saveConfig,
  syncCredentialEnv,
  vpsSshAlias,
  type AppConfig,
} from "../config.ts";
import type { InstanceConfigMap, ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { deciderIncludedHere, deciderPatchKey, deciderSavePatch, deciderSharedKeyUsable, type Decider } from "../decider/index.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { forgetKey } from "../key-rejections.ts";
import type { ComputerIdleTimer } from "../computer-idle.ts";
import { PROVIDER_KEY_KINDS } from "../provider-key-check.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { SharedComputerControl } from "../shared-computer-control.ts";
import type { SharedComputers } from "../shared-computers.ts";
import { parseSkillMd } from "../skills.ts";
import type { Store } from "../store.ts";
import * as tts from "../tts/index.ts";
import * as vps from "../vps-computer.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BusyFlag {
  get(): boolean;
  set(busy: boolean): void;
}

export type RemoteComputerProvider = "box" | "vps";

export type ModelSelectionCheck = { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };

export type ConfigStatus = Record<string, unknown>;

export interface ConfigRouteDeps {
  store: Pick<Store, "bots" | "patchBot" | "clearVoiceSelections">;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "forgetSnapshots">;
  sessions: Pick<SessionRegistry, "revalidateEmailSessions">;
  browserCleanup: Pick<BrowserCleanupCoordinator, "hasPendingProfile" | "prepare" | "abort" | "commit" | "ensure">;
  browserLive: Pick<BrowserLive, "closeAll" | "closeForSession">;
  browserRuntime: Pick<BrowserRuntime, "heldBy">;
  usedBrowserSessions: Pick<Map<string, { command: string; env: Record<string, string> }>, "get" | "delete">;
  closeBrowser(session: string, spec: { command: string; env: Record<string, string> }): Promise<boolean>;
  /** After browserEngine.engine changed: closes the viewers and the browsers the other engine ran. */
  browserEngineSwitched(): void;
  decider: Pick<Decider, "testKey">;
  sharedComputers: Pick<SharedComputers, "close">;
  sharedComputerControl: Pick<SharedComputerControl, "close">;
  hostedModels: boolean;
  cloudHome: boolean;
  lendingEnabled(): boolean;
  providerConfigs(): InstanceConfigMap;
  localVmIdleMs(): number;
  localVmIdles: { values(): Iterable<Pick<ComputerIdleTimer, "setIdleMs">> };
  localVmActiveThreads: { readonly size: number };
  localVmLifecycleBusy: { readonly size: number };
  localVmImageBusy: Pick<BusyFlag, "get">;
  localVmModeChangeBusy: Pick<BusyFlag, "set">;
  providerConfigBusy: BusyFlag;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "add" | "delete">;
  managedBoatOwners(): boat.ManagedBoatOwner[];
  providerOperationConflict(provider: RemoteComputerProvider): string | null;
  perBotLocalVmCountForModeChange(): Promise<number | null>;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean): ModelSelectionCheck;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  browserSessionSpec(binaryPath: string, session: string, profile: string | undefined): { command: string; env: Record<string, string> };
  configStatus(): ConfigStatus;
  /** What this caller is shown: a client sees configured-or-not only; on a Team Cloud the profile is the caller's own. */
  configForAccess(status: ConfigStatus, auth: RequestAuth): unknown;
  /** A Team Cloud only: Settings → Profile saves the signed-in person's own profile, never the server's. False: nobody
   * signed in to save it for. */
  ownProfile?(auth: RequestAuth, profile: { name?: string; avatarUrl?: string; aboutMe?: string }): boolean;
  resyncOpenCodeProviderKeys(): void;
  revokeEngineCapabilities(engines: ReadonlySet<string>): void;
  reloadProviders(before: Record<string, unknown>): Promise<void>;
  broadcast(payload: Record<string, unknown>): void;
  drainQueuedSends(): void;
}

export function createConfigRoutes(deps: ConfigRouteDeps): RouteHandler {
  const {
    store, cfg, registry, sessions, browserCleanup, browserLive, browserRuntime, usedBrowserSessions, decider,
    closeBrowser, browserEngineSwitched, sharedComputers, sharedComputerControl, hostedModels, cloudHome: CLOUD_HOME, lendingEnabled, providerConfigs,
    localVmIdleMs, localVmIdles, localVmActiveThreads, localVmLifecycleBusy, localVmImageBusy, localVmModeChangeBusy,
    providerConfigBusy, computerProviderConfigTransitions, managedBoatOwners, providerOperationConflict,
    perBotLocalVmCountForModeChange, checkedModelSelection, policyModelRefusal, browserSessionSpec, configStatus,
    configForAccess, resyncOpenCodeProviderKeys, revokeEngineCapabilities, reloadProviders, broadcast, drainQueuedSends, ownProfile,
  } = deps;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    // API keys are never echoed back: booleans only.
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configForAccess(configStatus(), auth));
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      if (hostedModels && ["instances", "anthropic", "openai", "openrouter", "openaiCompat", "xai", "mistral", "cerebras", "groq", "meta", "opencodeGo"].some(key => Object.hasOwn(body, key))) return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });
      const patch = parseConfigPatch(body);
      if (patch.profile && ownProfile) {
        // The address is the verified claim's; a profile names no other.
        const { email: _email, ...own } = patch.profile;
        if (!ownProfile(auth, own)) return json(res, 403, { error: "Sign in to this team to have a profile." });
        delete patch.profile;
        if (!Object.keys(patch).length) {
          broadcast({ kind: "config", ...configStatus() });
          return json(res, 200, configForAccess(configStatus(), auth));
        }
      }
      if (CLOUD_HOME && (patch.signIn?.admins?.length || patch.signIn?.members?.length)) {
        return json(res, 403, { error: CLOUD_PERSONAL_REFUSAL, code: "cloud_personal" });
      }
      if (patch.newBotDefaults) {
        if (patch.newBotDefaults.profile.modelSelection) {
          const checked = checkedModelSelection(patch.newBotDefaults.profile.modelSelection);
          if (!checked.ok) return json(res, checked.status, { error: checked.error });
          patch.newBotDefaults.profile.modelSelection = checked.selection;
        }
        for (const skill of patch.newBotDefaults.skills) {
          const parsed = parseSkillMd(skill.text);
          if ("error" in parsed || parsed.name !== skill.name) return json(res, 400, { error: "Skill name does not match its contents" });
        }
      }
      if (hostedModels && patch.defaultModelSelection) {
        const checked = checkedModelSelection(patch.defaultModelSelection);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
      }
      if (patch.automaticRecovery?.enabled) {
        const checked = checkedModelSelection(patch.automaticRecovery.backup, undefined, true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        const target = registry.get(checked.selection.instanceId)!;
        if (!target.enabled) return json(res, 400, { error: "Enable the backup engine before selecting it for recovery." });
        const refusal = policyModelRefusal(target);
        if (refusal) return json(res, 403, { error: refusal, code: "managed_policy" });
        patch.automaticRecovery.backup = checked.selection;
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      if (patch.decider) {
        const planned = deciderSavePatch(patch.decider, cfg.decider, { included: deciderIncludedHere(), shared: deciderSharedKeyUsable(cfg) });
        if (!planned.ok) return json(res, 400, { error: planned.error });
        patch.decider = planned.patch;
      }
      const changingVoiceProvider = patch.tts?.provider !== undefined
        && patch.tts.provider !== tts.voiceProvider(cfg);
      if (changingVoiceProvider && patch.tts?.voice === undefined) {
        // Voice ids are provider-owned: never carry one from one catalog into another.
        patch.tts = { ...patch.tts, voice: "" };
      }
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      if (patch.openaiCompat?.contextWindows !== undefined && body.expectedContextWindows !== undefined &&
          JSON.stringify(body.expectedContextWindows) !== JSON.stringify(cfg.openaiCompat?.contextWindows ?? {})) {
        return json(res, 409, { error: "Context limits changed in another window. Refresh settings and try again." });
      }
      if (patch.browserProfiles !== undefined && body.expectedBrowserProfiles !== undefined) {
        const current = (cfg.browserProfiles ?? []).map(({ id, name, browser }) => ({ id, name, ...(browser ? { browser } : {}) }));
        if (JSON.stringify(body.expectedBrowserProfiles) !== JSON.stringify(current)) {
          return json(res, 409, { error: "Browser profiles changed in another window. Review the refreshed list and try again." });
        }
      }
      const disablingBuiltInBrowser = patch.features?.browser === false && builtInBrowserEnabled(cfg);
      const switchingBrowserEngine = patch.browserEngine?.engine !== undefined && patch.browserEngine.engine !== browserEngineKind(cfg);
      const removedBrowserProfileIds = patch.browserProfiles === undefined
        ? []
        : (cfg.browserProfiles ?? [])
            .map((profile) => profile.id)
            .filter((id) => !patch.browserProfiles!.some((profile) => profile.id === id));
      const browserChoiceChanged = (patch.browserProfiles ?? []).filter((profile) => {
        const current = cfg.browserProfiles?.find((candidate) => candidate.id === profile.id);
        return current !== undefined && (current.browser ?? null) !== (profile.browser ?? null);
      }).map((profile) => profile.id);
      const profileControlConflict = () => removedBrowserProfileIds.some((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        return target && browserRuntime.heldBy(browserSessionId("", target.partitionId));
      });
      if (profileControlConflict()) return json(res, 409, { error: "Release browser control before deleting its profile." });
      if (browserChoiceChanged.some((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        return target && browserRuntime.heldBy(browserSessionId("", target.partitionId));
      })) return json(res, 409, { error: "Release browser control before changing its browser." });
      if (patch.browserProfiles !== undefined) {
        const currentProfiles = new Map((cfg.browserProfiles ?? []).map((profile) => [profile.id, profile]));
        const nextProfiles = patch.browserProfiles.map((profile) => {
          const partitionId = currentProfiles.get(profile.id)?.partitionId;
          return partitionId ? { ...profile, partitionId } : profile;
        });
        const routingConflict = browserProfileReplacementConflict(cfg.browserProfiles ?? [], nextProfiles);
        if (routingConflict) return json(res, 409, { error: routingConflict });
        const currentIds = new Set((cfg.browserProfiles ?? []).map((profile) => profile.id));
        const pendingReuse = patch.browserProfiles.find(
          (profile) => !currentIds.has(profile.id) && browserCleanup.hasPendingProfile(profile.id),
        );
        if (pendingReuse) {
          return json(res, 409, {
            error: `the previous “${pendingReuse.name}” browser session is still being erased — wait before reusing it`,
          });
        }
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
      }
      if (patch.box?.token !== undefined) patch.box.token = patch.box.token.trim();
      const currentBoatToken = cfg.box?.token?.trim() ?? "";
      const nextBoatToken = patch.box?.token === undefined ? currentBoatToken : patch.box.token;
      const changingBoatToken = patch.box?.token !== undefined && nextBoatToken !== currentBoatToken;
      const currentVpsAlias = vpsSshAlias(cfg);
      const nextVpsAlias = patch.vps === undefined
        ? currentVpsAlias
        : vpsSshAlias({ ...cfg, vps: patch.vps });
      const changingVpsAlias = patch.vps !== undefined && nextVpsAlias !== currentVpsAlias;
      const transitioningProviders: RemoteComputerProvider[] = [
        ...(changingBoatToken ? ["box" as const] : []),
        ...(changingVpsAlias ? ["vps" as const] : []),
      ];
      providerConfigBusy.set(true);
      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== localVmMode(cfg);
      if (changingLocalVmMode) localVmModeChangeBusy.set(true);
      try {
        for (const provider of transitioningProviders) {
          const conflict = providerOperationConflict(provider);
          if (conflict) return json(res, 409, { error: conflict });
        }
        for (const provider of transitioningProviders) computerProviderConfigTransitions.add(provider);

        if (changingVpsAlias && currentVpsAlias) {
          const inventory = await vps.listManagedVpsComputers(
            { vps: { sshAlias: currentVpsAlias } },
            managedBoatOwners(),
          );
          if (!inventory.available) {
            return json(res, 503, {
              error: `${inventory.problem ?? "VPS computer inventory is unavailable"}. Keep the current SSH config alias and retry`,
            });
          }
          const resourceError = vpsAliasResourceChangeError(inventory.instances.length);
          if (resourceError) return json(res, 409, { error: resourceError });
        }

        let boatRecovery = changingBoatToken ? boatCreateRecoverySnapshot() : [];
        let boatDeletions = changingBoatToken ? boatDeletionSnapshot() : [];
        if (changingBoatToken && boatDeletions.length > 0 && !nextBoatToken) {
          return json(res, 409, {
            error: "finish or retry pending cloud computer deletion before removing the Boat account",
          });
        }
        let replacementProvedByDeletion = false;
        if (changingBoatToken && boatDeletions.length > 0 && nextBoatToken) {
          try {
            await boat.verifyBoatDeletionCredential({ box: { token: nextBoatToken } });
            replacementProvedByDeletion = true;
            // Re-snapshot: verification may have retired the deletion fence and its create receipt.
            boatRecovery = boatCreateRecoverySnapshot();
            boatDeletions = boatDeletionSnapshot();
          } catch (error) {
            return json(res, (error as { status?: number })?.status ?? 503, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        let currentBoatInventory: boat.ManagedBoatInventory | null = null;
        let replacingRejectedBoatToken = false;
        let currentBoatResources: Array<{ boxId: string; name: string }> | null = null;
        const journalBoatResources: Array<{ boxId: string; name: string }> = [];
        const deletingBoatIds = new Set(boatDeletions.map((entry) => entry.boxId));
        if (changingBoatToken && currentBoatToken) {
          currentBoatInventory = await boat.listManagedBoats(
            { box: { token: currentBoatToken } },
            managedBoatOwners(),
          );
          if (!currentBoatInventory.available) {
            replacingRejectedBoatToken = currentBoatInventory.credentialRejected === true && Boolean(nextBoatToken);
            if (!replacementProvedByDeletion && !replacingRejectedBoatToken) {
              return json(res, 503, {
                error: `${currentBoatInventory.problem ?? "cloud computer inventory is unavailable"}. Keep the current Boat account and retry`,
              });
            }
            // A rejected old key cannot authorize its own rotation.
            currentBoatInventory = null;
          }
          if (currentBoatInventory) {
            const currentById = new Map(
              currentBoatInventory.instances.map((instance) => [instance.boxId, { boxId: instance.boxId, name: instance.name }]),
            );
            for (const recovery of boatRecovery) {
              if (!recovery.boxId) continue;
              // The replacement credential already proved this exact deletion target.
              if (replacementProvedByDeletion && deletingBoatIds.has(recovery.boxId)) continue;
              const inspected = await boat.inspectBoatIdentity({ box: { token: currentBoatToken } }, recovery.boxId);
              if (!inspected.available) {
                return json(res, 503, {
                  error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Keep the current Boat account and retry`,
                });
              }
              if (!inspected.identity) {
                // Reconcile stale receipts while the current credential still works.
                retireDeletedBoatCreate(recovery.boxId);
                continue;
              }
              const listed = currentById.get(inspected.identity.boxId);
              if (listed && listed.name !== inspected.identity.name) {
                return json(res, 503, { error: "boat.dev returned conflicting cloud computer identities; keep the current Boat account and retry" });
              }
              currentById.set(inspected.identity.boxId, inspected.identity);
              journalBoatResources.push(inspected.identity);
            }
            currentBoatResources = [...currentById.values()];
          }
        }

        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy.get()) {
            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
          }
          if (localVmMode(cfg) === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              return json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
            }
            if (existing > 0) {
              return json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
            }
          }
        }
      const requestedComposioKey = patch.composio?.apiKey;
      if (requestedComposioKey !== undefined) {
        if (requestedComposioKey.trim()) {
          try {
            const prepared = await composio.prepareProjectSession(requestedComposioKey, cfg.composio);
            patch.composio = { ...patch.composio, ...prepared };
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        } else {
          patch.composio = { ...patch.composio, apiKey: "", sessionId: "" };
        }
      }
      const newBoatToken = patch.box?.token;
      if (newBoatToken?.trim()) {
        const check = await boat.verifyToken(newBoatToken);
        if (!check.ok) return json(res, 400, { error: check.message, ...(check.rejected ? { code: "key_rejected" } : {}) });
      }
      if (replacingRejectedBoatToken) {
        // An expired credential cannot authorize its own replacement: probe without adopting or retiring identities.
        const replacement = await boat.listManagedBoats(
          { box: { token: nextBoatToken } }, managedBoatOwners(), { adoptLegacy: false },
        );
        if (!replacement.available) return json(res, 503, { error: replacement.problem ?? "Could not verify the replacement Boat key. Your saved key and computers are unchanged." });
      }
      if (changingBoatToken && (!currentBoatToken || replacementProvedByDeletion || replacingRejectedBoatToken) && boatRecovery.length > 0) {
        if (!nextBoatToken) {
          return json(res, 409, { error: "restore the Boat account that owns the remembered cloud computers before clearing it" });
        }
        for (const recovery of boatRecovery) {
          if (!recovery.boxId) {
            return json(res, 409, { error: "finish reconciling pending cloud computer creation before changing the Boat account" });
          }
          if (replacementProvedByDeletion && deletingBoatIds.has(recovery.boxId)) continue;
          const inspected = await boat.inspectBoatIdentity({ box: { token: nextBoatToken } }, recovery.boxId);
          if (!inspected.available) {
            return json(res, 503, {
              error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Retry with the Boat account that created it`,
            });
          }
          if (!inspected.identity || !(await boat.boatNameMatchesBot(recovery.botId, inspected.identity.name))) {
            return json(res, 409, { error: "that Boat token cannot access the remembered cloud computers from this installation" });
          }
        }
      }
      if (changingBoatToken && currentBoatInventory && currentBoatResources) {
        let replacementResources: Array<{ boxId: string; name: string }> | null = null;
        if (nextBoatToken) {
          const replacementInventory = await boat.listManagedBoats(
            { box: { token: nextBoatToken } },
            managedBoatOwners(),
            { adoptLegacy: false },
          );
          if (!replacementInventory.available) {
            return json(res, 503, {
              error: `${replacementInventory.problem ?? "cloud computer inventory is unavailable"}. Keep the current Boat account and retry`,
            });
          }
          replacementResources = replacementInventory.instances.map((instance) => ({
            boxId: instance.boxId,
            name: instance.name,
          }));
          const replacementById = new Map(
            replacementResources.map((instance) => [instance.boxId, { boxId: instance.boxId, name: instance.name }]),
          );
          for (const identity of journalBoatResources) {
            const inspected = await boat.inspectBoatIdentity({ box: { token: nextBoatToken } }, identity.boxId);
            if (!inspected.available) {
              return json(res, 503, {
                error: `${inspected.problem ?? "a remembered cloud computer could not be verified"}. Keep the current Boat account and retry`,
              });
            }
            if (!inspected.identity || inspected.identity.name !== identity.name) {
              return json(res, 409, { error: "the replacement Boat token does not access the same cloud computers" });
            }
            replacementById.set(inspected.identity.boxId, inspected.identity);
          }
          replacementResources = [...replacementById.values()];
        }
        const resourceError = boatAccountResourceChangeError(
          currentBoatResources,
          replacementResources,
        );
        if (resourceError) return json(res, 409, { error: resourceError });
      }
      // Validated against each voice provider's own credential, so no service is ever sent another's key.
      const newTts = patch.tts;
      if (newTts?.key?.trim()) {
        const check = await tts.verifyKey("elevenlabs", newTts.key.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      if (newTts?.fishKey?.trim()) {
        const check = await tts.verifyKey("fish", newTts.fishKey.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      const deciderKey = patch.decider ? deciderPatchKey(patch.decider, cfg.decider) : null;
      if (deciderKey) {
        const check = await decider.testKey(deciderKey.check);
        if (!check.ok && check.reason === "rejected") {
          const error = deciderKey.provider === "openrouter"
            ? "OpenRouter rejected this key. Check it at openrouter.ai/keys and paste it again."
            : "Jev rejected this key. Check it at typesafe.ai and paste it again.";
          return json(res, 400, { error, code: "decider_rejected" });
        }
      }
      if (patch.browserProfiles !== undefined) {
        // Revalidated: the awaits above let a turn claim a profile. No awaits from here through the save.
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
        const switching = store.bots.find((bot) => bot.busy && bot.browserProfile && browserChoiceChanged.includes(bot.browserProfile));
        if (switching) return json(res, 409, { error: `stop ${switching.name}'s turn before changing its browser` });
      }
      const browsing = switchingBrowserEngine ? store.bots.find((bot) => bot.busy && bot.browser !== false) : undefined;
      if (browsing) return json(res, 409, { error: `stop ${browsing.name}'s turn before switching the browser` });
      // Observed again after the awaits: catches an operation that already held a claim.
      for (const provider of transitioningProviders) {
        const conflict = providerOperationConflict(provider);
        if (conflict) return json(res, 409, { error: conflict });
      }
      // Only the named keys change; merged with no await before the save.
      if (patch.opencodeGo?.providerKeys) {
        const merged = mergeOpenCodeProviderKeys(cfg, patch.opencodeGo.providerKeys);
        if (!merged.ok) return json(res, 400, { error: merged.error });
        patch.opencodeGo = { ...patch.opencodeGo, providerKeys: merged.keys };
      }
      const browserCleanupRequests: BrowserCleanupRequest[] = [];
      if (profileControlConflict()) return json(res, 409, { error: "Release browser control before deleting its profile." });
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
      const resetKeys = PROVIDER_KEY_KINDS.flatMap((kind) => {
        const next = patch[kind]?.key;
        return next === undefined ? [] : [cfg[kind]?.key, next];
      });
      const engineForSwitch = browserEngineStatus();
      const browsersToClose = browserChoiceChanged.flatMap((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        if (!target) return [];
        const session = browserSessionId("", target.partitionId);
        const spec = usedBrowserSessions.get(session) ?? (engineForSwitch.kind === "ready" ? browserSessionSpec(engineForSwitch.binaryPath, session, id) : null);
        return spec ? [{ session, spec }] : [];
      });
      let configWriteCommitted = false;
      const enginesBefore = engineLaunches(providerConfigs());
      const externalSecretStorage = url.searchParams.get("secretStorage") === "external";
      try {
        // Before the provider commit, so a failed write never leaves a foreign voice id to speak.
        if (changingVoiceProvider) store.clearVoiceSelections();
        if (externalSecretStorage) {
          // Supplied credentials are already in the OS-encrypted store: tombstone them so no older plaintext survives the merge.
          const persisted = structuredClone(patch);
          if (persisted.xai?.key !== undefined) persisted.xai.key = "";
          if (persisted.composio?.apiKey !== undefined) persisted.composio.apiKey = "";
          if (persisted.box?.token !== undefined) persisted.box.token = "";
          if (persisted.opencodeGo?.apiKey !== undefined) persisted.opencodeGo.apiKey = "";
          if (persisted.tts?.key !== undefined) persisted.tts.key = "";
          if (persisted.tts?.fishKey !== undefined) persisted.tts.fishKey = "";
          if (persisted.decider?.key !== undefined) persisted.decider.key = "";
          if (persisted.decider?.openrouterKey !== undefined) persisted.decider.openrouterKey = "";
          if (persisted.imageGen?.key !== undefined) persisted.imageGen.key = "";
          if (persisted.imageGen?.customApiKey !== undefined) persisted.imageGen.customApiKey = "";
          if (persisted.live?.key !== undefined) persisted.live.key = "";
          if (persisted.treg?.key !== undefined) persisted.treg.key = "";
          saveConfig(persisted);
          configWriteCommitted = true;
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        } else {
          saveConfig(patch);
          configWriteCommitted = true;
          // loadConfig prefers env over the file for credentials, so the env must follow the save.
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
      for (const key of resetKeys) if (key) forgetKey(key);
      // A saved key reaches an engine through the environment its status read uses, often with no reload.
      registry.forgetSnapshots();
      if (patch.localVm?.idleTimeoutMinutes !== undefined) {
        for (const idle of localVmIdles.values()) idle.setIdleMs(localVmIdleMs());
      }
      let browserReferenceCleanupError: unknown = null;
      if (patch.signIn !== undefined) {
        sessions.revalidateEmailSessions();
        resyncOpenCodeProviderKeys();
      }
      if (!lendingEnabled()) {
        sharedComputers.close();
        sharedComputerControl.close();
      }
      if (disablingBuiltInBrowser) browserLive.closeAll();
      if (switchingBrowserEngine) browserEngineSwitched();
      for (const request of browserCleanupRequests) {
        if (request.kind === "profile") browserLive.closeForSession(browserSessionId("", request.partitionId));
      }
      for (const { session, spec } of browsersToClose) {
        browserLive.closeForSession(session);
        usedBrowserSessions.delete(session);
        void closeBrowser(session, spec).then((closed) => {
          if (!closed) console.warn(`browser ${session}: could not close it after its browser changed; the next turn may still use the old one`);
        });
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        try {
          for (const bot of store.bots) {
            if (bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile)) {
              store.patchBot(bot.id, { browserProfile: undefined });
            }
          }
        } catch (error) {
          // Config is already durable: this failure must not skip revocation and reload below.
          browserReferenceCleanupError = error;
        }
      }
      const changedEngines = new Set(changedInstanceIds(enginesBefore, engineLaunches(providerConfigs())));
      // Revoked before any await: a changed engine's old children are invalid at once.
      revokeEngineCapabilities(changedEngines);
      // Commit failures wait until every mandatory effect has run: no journal failure may leave a bearer or stale engines active.
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
          if (changedEngines.size > 0) {
            try {
              await reloadProviders(enginesBefore);
            } catch (error) {
              if (!mandatoryError) mandatoryError = error;
            }
          }
          const status = configStatus();
          broadcast({ kind: "config", ...status });
          if (patch.threads !== undefined) {
            drainQueuedSends();
          }
          if (mandatoryError) throw mandatoryError;
          return status;
        },
      });
      // Asserted after every mandatory post-commit effect, so the runtime matches the config even on a 503.
      requireBrowserCleanupAcknowledged(
        finalized.acknowledgements.every(Boolean),
        removedBrowserProfileIds.length === 1 ? "The browser profile" : "The browser profiles",
      );
      return json(res, 200, configForAccess(finalized.value, auth));
      } finally {
        for (const provider of transitioningProviders) computerProviderConfigTransitions.delete(provider);
        if (changingLocalVmMode) localVmModeChangeBusy.set(false);
        providerConfigBusy.set(false);
      }
    }
    return PASS;
  };
}
