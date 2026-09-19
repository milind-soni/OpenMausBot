// Capability-assembly phase for the direct-turn engine (server/start-turn.ts).
import * as box from "../../box.ts";
import * as composio from "../../composio.ts";
import * as vps from "../../vps-computer.ts";
import { customMcpServers, vpsSshAlias, type AppConfig } from "../../config.ts";
import { beginMemoryTurn } from "../../memory-journal.ts";
import {
  ensureTaskWorkspace,
  ensureWorkspace,
  supportsWorkspaceFiles,
} from "../../workspace.ts";
import { renderSkillInstructions, selectBundledSkills } from "../../skill-library.ts";
import { installedPlaybookInstructions } from "../../installed-playbooks.ts";
import { computerBackendFor } from "../../computer-backend.ts";
import { readCuaConnection, gatedLocalComputer } from "../../local-computer.ts";
import { shouldMountLocalComputer } from "../../local-routing.ts";
import {
  autoLocalVmAttachable,
  containerComputerFrame,
  containerComputerMcp,
  containerComputerStatus,
  type LocalVmTarget,
  type Runtime,
} from "../../container-computer.ts";
import { workspaceResource, type TurnOwner } from "../../turn-resources.ts";
import { claimTurnResource, threadBusy } from "../../turn-admission.ts";
import { computerSelectionTurns } from "../../internal-capabilities.ts";
import { type BotRecord, type Store } from "../../store.ts";
import type { SurfacePlan } from "../../surface.ts";
import type { ProviderInstance } from "../../contracts.ts";
import type { StartTurnOptions } from "../../start-turn.ts";
import type { Deps } from "./shared.ts";

/** Capability assembly: workspace, skills, phone/composio/MCP integrations and the computer destination (VM/VPS/Box/host). */
export async function assembleTurnIntegrations({
  bot,
  opts,
  threadId,
  plan,
  instance,
  providerText,
  skillAuthoring,
  dispatchClaimId,
  resourceOwner,
  store,
  cfg,
  broadcast,
  availableSkills,
  phoneIntegration,
  connectedAppsIntegration,
  bindTurnComputer,
  attachTeamBox,
  controlIntegration,
  vpsThreadStarted,
  vpsThreadEnded,
  turnResources,
  turnComputerResources,
  stopScreenPoller,
  screenPollers,
  startScreenPoller,
  browserCaptureRef,
  inheritedTeamComputer,
  autoVmClaims,
  releaseLocalVmThread,
  localVmTargetForBot,
  localVmLeaseFor,
  localVmIdleFor,
  localVmThreadTargets,
  localVmActiveThreads,
  localVmLifecycleBusy,
  localVmSeen,
  localVmOwnerBusy,
  localVmImageBusy,
  localVmModeChangeBusy,
  readyLocalVmForTurn,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  plan: SurfacePlan;
  instance: ProviderInstance;
  providerText: string;
  skillAuthoring: boolean;
  dispatchClaimId: string;
  resourceOwner: TurnOwner;
  store: Store;
  cfg: AppConfig;
  broadcast: Deps["events"]["broadcast"];
  availableSkills: Deps["prompts"]["availableSkills"];
  phoneIntegration: Deps["computers"]["phoneIntegration"];
  connectedAppsIntegration: Deps["computers"]["connectedAppsIntegration"];
  bindTurnComputer: Deps["computers"]["bindTurnComputer"];
  attachTeamBox: Deps["computers"]["attachTeamBox"];
  controlIntegration: Deps["computers"]["controlIntegration"];
  vpsThreadStarted: Deps["computers"]["vpsThreadStarted"];
  vpsThreadEnded: Deps["computers"]["vpsThreadEnded"];
  turnResources: Deps["cleanup"]["turnResources"];
  turnComputerResources: Deps["cleanup"]["turnComputerResources"];
  stopScreenPoller: Deps["cleanup"]["stopScreenPoller"];
  screenPollers: Deps["cleanup"]["screenPollers"];
  startScreenPoller: Deps["cleanup"]["startScreenPoller"];
  browserCaptureRef: { current: (() => Promise<{ png: string; format: string }>) | null };
  inheritedTeamComputer: Deps["prompts"]["inheritedTeamComputer"];
  autoVmClaims: Deps["cleanup"]["autoVmClaims"];
  releaseLocalVmThread: Deps["cleanup"]["releaseLocalVmThread"];
  localVmTargetForBot: Deps["localVm"]["localVmTargetForBot"];
  localVmLeaseFor: Deps["localVm"]["localVmLeaseFor"];
  localVmIdleFor: Deps["localVm"]["localVmIdleFor"];
  localVmThreadTargets: Deps["localVm"]["localVmThreadTargets"];
  localVmActiveThreads: Deps["localVm"]["localVmActiveThreads"];
  localVmLifecycleBusy: Deps["localVm"]["localVmLifecycleBusy"];
  localVmSeen: Deps["localVm"]["localVmSeen"];
  localVmOwnerBusy: Deps["localVm"]["localVmOwnerBusy"];
  localVmImageBusy: Deps["localVm"]["localVmImageBusy"];
  localVmModeChangeBusy: Deps["localVm"]["localVmModeChangeBusy"];
  readyLocalVmForTurn: Deps["localVm"]["readyLocalVmForTurn"];
}) {
  const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
  const selectedSkills = selectBundledSkills(
    providerText,
    [
      ...(instance.adapter.capabilities.phoneMcp === true ? ["phoneMcp"] : []),
      ...(skillAuthoring ? ["skillAuthoring"] : []),
    ],
    availableSkills(),
  );
  if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("phoneMcp"))) {
    if (!claimTurnResource(resourceOwner, "computer:phone")) throw new Error("another thread is using the phone — wait for it to finish");
    integrations.phone = phoneIntegration();
  }
  // the user's connected apps, but only to a driver that can mount
  // them — a key in the config says the connections exist, not that
  // this engine can reach them — and only to a bot the user has not
  // switched off: the key is workspace-wide, the grant is per bot.
  if (bot.composio !== false && composio.configured(cfg) && instance.adapter.capabilities.composioMcp === true) {
    const connection = await connectedAppsIntegration(bot.id, threadId, dispatchClaimId);
    if (connection) integrations.composio = connection;
  }
  // user-configured MCP servers (config.json mcpServers): same rule as
  // composio — only to a driver that can mount them. Their tools are
  // never pre-allowed, so every call rides the normal permission flow.
  if (instance.adapter.capabilities.customMcp === true) {
    const custom = customMcpServers(cfg, bot.mcpServers);
    if (Object.keys(custom).length) integrations.custom = custom;
  }
  // CLI engines work inside the bot's own workspace directory rather
  // than the user's home: a bot with file tools and acceptEdits gets a
  // desk, not the whole house — and the workspace is where its
  // MEMORY.md lives. API/box engines have no local filesystem story.
  const worksInWorkspace = supportsWorkspaceFiles(instance.driverKind);
  if (worksInWorkspace) {
    ensureWorkspace(bot.id);
    // baseline for the journal's turn-boundary diff (see the bus hook)
    beginMemoryTurn(bot.id, threadId);
  }
  const privateWorkspace = worksInWorkspace ? ensureTaskWorkspace(bot.id, threadId) : undefined;
  const skillInstructions = renderSkillInstructions(selectedSkills, {
    includeRoot: worksInWorkspace && opts?.runOn !== "cloud",
  });
  const packagePlaybooks = installedPlaybookInstructions(providerText, bot.playbooks);
  // An explicit working folder wins for new tasks; otherwise they use
  // the private bot workspace. A legacy task with an existing provider
  // session deliberately pins to null (the old home-folder behavior),
  // because moving a live session would break resume.
  // A cloud run happens on the box, where a host folder means nothing:
  // pin the task to the default so the header chip never shows the
  // bot's folder for a task that runs elsewhere.
  if (opts?.runOn === "cloud") store.pinTaskCwd(bot.id, threadId, undefined, { none: true });
  const pinnedCwd =
    privateWorkspace && opts?.runOn !== "cloud"
      ? store.pinTaskCwd(bot.id, threadId, privateWorkspace)
      : null;
  const cwd = pinnedCwd ?? undefined;
  if (cwd && !claimTurnResource(resourceOwner, workspaceResource(cwd))) {
    throw Object.assign(new Error("another thread is working in this project folder — wait for it to finish or choose a separate folder"), { status: 409, code: "workspace_busy" });
  }
  // Checkpoint explicit project folders, where a bot can overwrite the
  // user's work. Its private OpenMaus workspace is app-owned and changes
  // on nearly every ordinary chat; snapshotting it would add hidden disk
  // and process overhead without a user project to restore.
  const checkpointCwd = cwd && cwd !== privateWorkspace ? cwd : undefined;
  // dweb is opt-in: without an explicit daemon URL, do not advertise
  // tools that would fail on every call or spawn an unnecessary proxy.
  const dwebUrl = process.env.DWEB_URL?.trim();
  if (dwebUrl) integrations.dweb = { url: dwebUrl };
  // Cloud routines always use Box/BoxAgent. The per-bot backend applies
  // only to ordinary turns that mount a computer into the local agent.
  const teamComputer = inheritedTeamComputer(bot);
  const computerBackend = computerBackendFor(bot);
  const cloudBackend = teamComputer || opts?.runOn === "cloud" || computerBackend.kind !== "vps" ? "box" : "vps";
  const mountsComputerMcp = instance.adapter.capabilities.computerMcp === true;
  // Box's native runner owns its computer tools. Local drivers mount
  // Local VM/VPS tools, but have no Box relay to execute this descriptor.
  const mountsCloudComputer = instance.driverKind === "boxAgent";
  const mountsLocalComputer = instance.adapter.capabilities.localComputerMcp === true;
  // Where this turn's hands may land. The bot's "Works on" choice is
  // strict; a browser-only bot gets no computer at all, and a bot whose
  // browser is withheld (workspace flag, its own switch, or an engine
  // without browser tools) gets told so instead of silently falling back
  // to a desktop it was never meant to touch.
  // The conversation's own place wins over the bot default: the person
  // pinned it from the composer, or its first Auto turn recorded where it
  // landed. A team computer or a cloud routine is not this conversation's
  // choice, so those ignore the pin.
  const dispatchTask = store.taskByThread(bot.id, threadId);
  if (plan.clearPin && dispatchTask) store.patchTask(bot.id, threadId, { surface: undefined });
  if (plan.computer !== undefined && plan.computer !== "cloud" && instance.driverKind === "boxAgent") {
    throw new Error("the Computer engine works on the cloud computer — set Works on to Cloud, or choose another engine");
  }
  const wants = plan.computer;
  let previewCapture: (() => Promise<{ png: string; format: string }>) | null = null;
  let computerKind: "box" | "vps" | "vm" | "local" | null = null;
  let autoVpsProblem: string | null = null;
  /** The Local VM frame capture for the poller and the settled transcript
   * screenshot. The shared desktop outlives the turn: once another thread
   * owns it, a capture still in flight would picture ITS work under this
   * bot's name — live and in the settled frame, which is taken after the
   * lease is already released. No owner means the desktop is simply
   * idle: that final frame is ours to keep. */
  const localVmPreviewFor = (localVmTarget: LocalVmTarget, claimThreadId: string) => () => {
    const owner = localVmLeaseFor(localVmTarget).current(localVmOwnerBusy);
    if (owner && owner.threadId !== claimThreadId) {
      throw new Error("the Local VM moved on to another turn");
    }
    return containerComputerFrame(undefined, undefined, localVmTarget);
  };
  /** The exclusive Local VM claim sequence, verbatim from the old inline
   * attach path, shared by dispatch (eager) and the first-screen-call
   * gate (issue #1361). Idempotent per turn: the resource claim and
   * the lease both re-assert the same owner, so a re-entrant call from
   * the gate no-ops once dispatch has already claimed. */
  const claimAutoLocalVm = async (claimThreadId: string, pinnedTarget?: LocalVmTarget): Promise<{ target: LocalVmTarget; runtime: Runtime }> => {
    const localVmTarget = pinnedTarget ?? localVmTargetForBot(bot.id);
    await bindTurnComputer(resourceOwner, `computer:vm:${localVmTarget.key}`, true);
    if (localVmImageBusy() || localVmModeChangeBusy() || localVmLifecycleBusy.has(localVmTarget.key)) {
      throw new Error("this Local VM is being started, stopped, or replaced — wait for setup to finish");
    }
    // Claim before the first await. The lifecycle route performs its
    // matching check synchronously, so neither side can enter while the
    // other is between inspection and mutation.
    if (!localVmLeaseFor(localVmTarget).claim(claimThreadId, bot.id, localVmOwnerBusy)) {
      throw new Error("this Local VM is already being used by another turn — wait for that turn to finish");
    }
    localVmThreadTargets.set(claimThreadId, localVmTarget);
    localVmActiveThreads.set(localVmTarget.key, claimThreadId);
    localVmIdleFor(localVmTarget).touch();
    // The lease is held from here. An eager attach that fails below
    // fails the turn and settle releases it; a lazy claim's rejection is
    // swallowed into the slot's failed flag and the turn carries on, so
    // without this the exclusive lease would sit held for the rest of a
    // turn that never got the VM — the very serialisation #1361 removes.
    const dropLease = () => {
      localVmLeaseFor(localVmTarget).release(claimThreadId);
      if (localVmActiveThreads.get(localVmTarget.key) === claimThreadId) localVmActiveThreads.delete(localVmTarget.key);
      localVmThreadTargets.delete(claimThreadId);
      // bindTurnComputer above also took the turn-level resource; a
      // later turn's exclusive bind queues behind it just the same.
      const resource = `computer:vm:${localVmTarget.key}`;
      turnResources.releaseOne(resource, resourceOwner);
      if (turnComputerResources.get(resourceOwner.threadId)?.resource === resource) turnComputerResources.delete(resourceOwner.threadId);
    };
    let localVm: Awaited<ReturnType<typeof readyLocalVmForTurn>>;
    try {
      localVm = await readyLocalVmForTurn(bot.id, localVmTarget);
    } catch (error) {
      dropLease();
      throw error;
    }
    if (!localVm.ready || !localVm.runtime) {
      dropLease();
      throw new Error(`${localVm.problem ?? "the Local VM is not ready"} (App Settings → Computers)`);
    }
    // The readiness walk can wait minutes for the desktop, and the group
    // path re-validates its lease afterwards; the direct path needs the
    // same guard so a turn never attaches MCP to a desktop another turn
    // now owns.
    const owner = localVmLeaseFor(localVmTarget).current(localVmOwnerBusy);
    if (owner?.threadId !== claimThreadId || owner.botId !== bot.id) {
      dropLease();
      throw new Error("the Local VM lease expired while preparing the turn");
    }
    // Same contract as the Box and VPS branches below: without this the
    // poller never starts, so the Local VM publishes no `screen` events
    // and every client that only has the stream (the phone) waits
    // forever. The web panel hid the gap by polling the screenshot
    // route itself.
    previewCapture = localVmPreviewFor(localVmTarget, claimThreadId);
    return { target: localVmTarget, runtime: localVm.runtime };
  };

  // Explicit destinations are strict. In particular, Local VM must never
  // fall through to host CUA and accidentally click on the user's Mac.
  // The Local VM attach, shared by explicit "Local VM" and by Auto. Explicit
  // is strict and throws with the reason. Auto only reaches a VM this bot
  // already has — ready now, or one whose desktop image is prepared and can
  // be recreated on demand after idling away — and never creates a first
  // VM on its own; every failure there is a quiet "not this place".
  const attachLocalVm = async (strict: boolean): Promise<boolean> => {
    if (!mountsComputerMcp || instance.driverKind === "boxAgent") {
      if (!strict) return false;
      throw new Error("this model engine cannot use the Local VM — choose Claude or an ACP engine, or select another computer destination");
    }
    const localVmTarget = localVmTargetForBot(bot.id);
    let lazyReadyVm: { runtime: Runtime } | null = null;
    if (!strict) {
      // Nothing this process has ever seen for this target, and nobody is
      // relying on an unattended run: do not pay for a runtime probe.
      if (!localVmSeen.has(localVmTarget.key) && !opts?.automationSource) return false;
      const seen = await containerComputerStatus(undefined, undefined, localVmTarget).catch(() => null);
      if (!seen || !autoLocalVmAttachable(seen)) return false;
      if (localVmImageBusy() || localVmModeChangeBusy() || localVmLifecycleBusy.has(localVmTarget.key)) return false;
      if (seen.ready && seen.runtime) lazyReadyVm = { runtime: seen.runtime };
    }
    try {
      if (lazyReadyVm) {
        // Lazy exclusivity (issue #1361): a VM that is ready right now
        // mounts without claiming — screen-less Auto turns never touch
        // the lease, and the first screen tools/call fires the claim
        // through the computer-control gate. A VM that must be created
        // or recreated first keeps the eager claim below: the bridge
        // child needs the container to exist, and readyLocalVmForTurn
        // is what boots it.
        integrations.localComputer = containerComputerMcp(
          lazyReadyVm.runtime,
          controlIntegration(bot.id, threadId, dispatchClaimId),
          localVmTarget,
        );
        autoVmClaims.set(threadId, {
          owner: resourceOwner,
          lazy: true,
          label: "the Local VM",
          claim: async () => {
            await claimAutoLocalVm(threadId, localVmTarget);
            // The dispatch-site poller start saw a null previewCapture
            // (this lazy mount runs before any claim exists), so this
            // turn would publish no live `screen` events and settle no
            // final computer frame. Restart the poller with the now-live
            // computer capture, keeping any browser capture and whether
            // this turn already touched its screen. Same still-running
            // guard as dispatch: a poller started after its own
            // turn.completed would never be torn down.
            if (previewCapture && threadBusy(bot.id, threadId)) {
              const touched = screenPollers.get(threadId)?.touched ?? instance.driverKind === "boxAgent";
              stopScreenPoller(bot.id, threadId);
              startScreenPoller(
                bot.id,
                threadId,
                { computer: previewCapture, ...(browserCaptureRef.current ? { browser: browserCaptureRef.current } : {}) },
                { screenIsTheWork: touched },
              );
            }
          },
        });
        return true;
      }
      const claimed = await claimAutoLocalVm(threadId);
      integrations.localComputer = containerComputerMcp(
        claimed.runtime,
        controlIntegration(bot.id, threadId, dispatchClaimId),
        claimed.target,
      );
      // Hand the same claim to the first-screen-call gate. This eager
      // path has already claimed, so the gate's fire-once call can only
      // re-assert the same owner — a no-op (issue #1361).
      autoVmClaims.set(threadId, {
        owner: resourceOwner,
        label: "the Local VM",
        claim: async () => { await claimAutoLocalVm(threadId); },
      });
      return true;
    } catch (error) {
      if (strict) throw error;
      releaseLocalVmThread(threadId);
      return false;
    }
  };
  if (wants === "vm") {
    if (await attachLocalVm(true)) computerKind = "vm";
  } else if (wants === "local") {
    if (!shouldMountLocalComputer({
      requested: "local",
      hostPlatform: process.platform,
      providerSupportsLocal: mountsLocalComputer,
    })) {
      // Name the condition that actually failed: a person told "choose an
      // ACP engine" while already on one has nowhere to go.
      throw new Error(mountsLocalComputer
        ? `local computer control is not available on ${process.platform} — select another destination`
        : "this model engine cannot control this computer — choose Claude or an ACP engine, or select another destination");
    }
    const cua = readCuaConnection();
    if (!cua) throw new Error("CUA Driver is not ready for this computer — check permissions and restart OpenMausBot");
    await bindTurnComputer(resourceOwner, "computer:host");
    integrations.localComputer = gatedLocalComputer(cua, controlIntegration(bot.id, threadId, dispatchClaimId));
    computerKind = "local";
  }

  // A VPS is a local-agent computer mount, never a remote agent runner.
  // Explicit Cloud may prepare/start it. Auto remains read-only unless
  // the person explicitly opted this bot into remote lifecycle actions.
  if (computerBackend.kind === "vps" && !teamComputer && opts?.runOn !== "cloud" && (wants === "cloud" || wants === undefined)) {
    const unsupported = vps.vpsDriverError(instance.driverKind, mountsComputerMcp);
    if (unsupported && wants === "cloud") throw new Error(unsupported);
    if (unsupported && wants === undefined) autoVpsProblem = unsupported;
    if (!unsupported) {
      // The VPS "computer" is the desktop inside this bot's managed
      // container, and only screen work needs that desktop to itself.
      // So the lease is claimed on the first computer call, through the
      // computer-control gate (the Local VM's seam, #1361), never at
      // mount: a bot's turns that never touch the computer tools run
      // side by side, and its 3-hourly routine no longer queues behind
      // — or fails after 30 minutes behind — its own long-running task.
      // Container lifecycle (provision, start) is serialized by the
      // runner's per-container lock, not by this turn.
      const vpsResource = `computer:vps:${vpsSshAlias(cfg)}:${bot.id}`;
      vpsThreadStarted(bot.id, threadId);
      let remote;
      remote = vps.vpsStartsForTurn({ wants, autoStartVps: bot.autoStartVps, automationSource: opts?.automationSource })
        ? await computerBackend.action(cfg, bot.id, "provision")
        : await computerBackend.inspectForAuto(cfg, bot.id);
      if (remote?.ready && remote.sshAlias) {
        const targetCfg = { ...cfg, vps: { sshAlias: remote.sshAlias } };
        const vpsMcp = computerBackend.mcp(targetCfg, bot.id, remote.container_id ?? undefined);
        const vpsControl = controlIntegration(bot.id, threadId, dispatchClaimId);
        integrations.localComputer = {
          ...vpsMcp,
          env: { ...vpsMcp.env, OMB_CONTROL_URL: vpsControl.url, OMB_CONTROL_TOKEN: vpsControl.token },
        };
        computerKind = "vps";
        // Live frames only once this turn holds the desktop: a poller on
        // a desktop another turn is driving would publish that turn's
        // screen as this one's. The claim restarts the poller with the
        // capture, the way the Local VM's lazy claim does.
        const vpsCapture = () => computerBackend.screenshot(targetCfg, bot.id);
        autoVmClaims.set(threadId, {
          owner: resourceOwner,
          lazy: true,
          label: "the VPS computer",
          claim: async () => {
            await bindTurnComputer(resourceOwner, vpsResource, true);
            previewCapture = vpsCapture;
            if (threadBusy(bot.id, threadId)) {
              const touched = screenPollers.get(threadId)?.touched ?? false;
              stopScreenPoller(bot.id, threadId);
              startScreenPoller(
                bot.id,
                threadId,
                { computer: vpsCapture, ...(browserCaptureRef.current ? { browser: browserCaptureRef.current } : {}) },
                { screenIsTheWork: touched },
              );
            }
          },
        });
      } else {
        vpsThreadEnded(bot.id, threadId);
        if (wants === "cloud") {
          throw new Error(remote?.problem ?? "the VPS computer could not be created or reached");
        }
        autoVpsProblem = remote?.problem ?? "the VPS computer could not be reached";
      }
    }
  }

  // Cloud is strict when selected. Only the native Box engine can reuse
  // a Box on Auto; local engines have no relay for its desktop tools.
  if (teamComputer) {
    const attached = await attachTeamBox(teamComputer, bot.id, resourceOwner, mountsCloudComputer, instance.driverKind === "boxAgent");
    integrations.computer = attached.integration;
    previewCapture = attached.capture;
    computerKind = "box";
  }
  if (!teamComputer && !mountsCloudComputer && wants === "cloud" && cloudBackend === "box" && box.boxConfigured(cfg)) {
    throw new Error("this model engine cannot use computer tools — choose Claude, an ACP engine, or the Computer engine");
  }
  if (!teamComputer && mountsCloudComputer && (wants === "cloud" || wants === undefined) && cloudBackend === "box" && box.boxConfigured(cfg)) {
    // Explicit cloud turns can provision/wake the same bot's Box. Claim
    // before any network await so setup itself cannot race another turn.
    if (wants === "cloud") await bindTurnComputer(resourceOwner, `computer:box-bot:${bot.id}`, true);
    let b;
    try {
      b = await box.findBox(cfg, bot.id);
    } catch (error) {
      // Auto may fall through when an optional provider is offline, but a
      // durable deletion fence must never be mistaken for "no computer".
      if (wants === "cloud" || (error as { status?: number })?.status === 409) throw error;
      b = null;
    }
    let lifecycle = box.boxTurnLifecycleAction({
      explicitCloud: wants === "cloud",
      canMount: mountsCloudComputer,
      state: typeof b?.state === "string" ? b.state : null,
    });
    if (lifecycle === "provision") {
      broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
      await box.provisionBox(cfg, bot.id, bot.name);
      b = await box.findBox(cfg, bot.id);
      lifecycle = box.boxTurnLifecycleAction({
        explicitCloud: true,
        canMount: mountsCloudComputer,
        state: typeof b?.state === "string" ? b.state : null,
      });
    }
    // an archived box answers every action with an error until it
    // resumes — wake it here, once, instead of letting the agent
    // discover it one failed tool call at a time. Explicit Cloud is the
    // consent boundary for the resume (~8s, and it un-pauses billing).
    if (lifecycle === "wake") {
      broadcast({ kind: "computer", botId: bot.id, state: "waking" });
      b = (await box.readyBox(cfg, bot.id)) ?? b;
      lifecycle = box.boxTurnLifecycleAction({
        explicitCloud: true,
        canMount: mountsCloudComputer,
        state: typeof b?.state === "string" ? b.state : null,
      });
    }
    if (b && lifecycle === "attach") {
      await bindTurnComputer(resourceOwner, `computer:box:${b.id}`, instance.driverKind === "boxAgent");
      previewCapture = () => box.screenshotBox(cfg, bot.id, b!.id);
      if (mountsCloudComputer) {
        integrations.computer = {
          kind: "box",
          boxId: b.id,
          token: cfg.box!.token!,
          control: controlIntegration(bot.id, threadId, dispatchClaimId),
        };
        computerKind = "box";
      }
    }
  }
  if (wants === "cloud" && cloudBackend === "box" && !box.boxConfigured(cfg)) {
    throw new Error("Cloud box is not configured — add a Box API key or choose Local VM");
  }
  if (wants === "cloud" && cloudBackend === "box" && !integrations.computer) {
    throw new Error("the cloud computer could not be created or reached");
  }

  // Auto-only host fallback. Electron owns cua-driver/TCC attribution;
  // the harness only reads its already-running connection descriptor.
  // Auto reaches a Local VM this bot already has before it ever touches the
  // host's own desktop: on a headless server that VM is the only desktop
  // there is, and a person who prepared one meant it to be used.
  if (wants === undefined && !integrations.computer && !integrations.localComputer && await attachLocalVm(false)) computerKind = "vm";
  // An unattended run on a bot with a VPS configured never lands on the
  // host's own desktop instead: a scheduled job clicking on someone's
  // laptop is worse than a scheduled job that fails and says why.
  const unattendedVps = cloudBackend === "vps" && Boolean(opts?.automationSource);
  if (
    !integrations.computer &&
    !integrations.localComputer &&
    wants === undefined &&
    !unattendedVps &&
    shouldMountLocalComputer({
      requested: undefined,
      hostPlatform: process.platform,
      providerSupportsLocal: mountsLocalComputer,
    })
  ) {
    const cua = readCuaConnection();
    if (cua) {
      await bindTurnComputer(resourceOwner, "computer:host");
      integrations.localComputer = gatedLocalComputer(cua, controlIntegration(bot.id, threadId, dispatchClaimId));
      computerKind = "local";
    }
  }
  if (
    wants === undefined &&
    cloudBackend === "vps" &&
    !integrations.computer &&
    !integrations.localComputer &&
    autoVpsProblem &&
    !computerSelectionTurns.has(threadId)
  ) {
    const hint = opts?.automationSource
      ? "This scheduled run tried to start the VPS computer and could not reach it. Check the VPS connection in App Settings → Connections."
      : bot.autoStartVps
        ? "Check the VPS connection in App Settings → Connections."
        : "Open Computer and enable Start VPS automatically, or choose Cloud to start it manually.";
    throw new Error(`${autoVpsProblem}. ${hint}`);
  }
  return { integrations, previewCapture, computerKind, worksInWorkspace, privateWorkspace, skillInstructions, packagePlaybooks, cwd, checkpointCwd, teamComputer };
}
