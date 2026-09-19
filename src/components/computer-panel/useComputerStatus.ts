import { useEffect, type Dispatch, type SetStateAction } from "react";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";
import type { CloudBackend } from "../../../shared/wire";
import {
  decideBoxErrorPhase,
  decideBoxPhase,
  decideLocalPhase,
  decideSelectionPhase,
  decideVmPhase,
  decideVpsPhase,
  decideVpsProvisionPhase,
  isVmAwaitingDesktop,
  type LocalVmStatus,
  type VpsComputerStatus,
} from "@/lib/computer-panel-phase";
import { isReadyBoxState } from "@/lib/local-computer";
import type { ComputerPanelView } from "@/lib/computer-panel-view";
import { LocalizedPanelError, phaseErrorToPanelError, type Phase } from "./panelError";

type ResolvedComputerSelection = {
  botId: string;
  threadId: string;
  computer: Bot["computer"];
  cloudBackend: CloudBackend;
};

type ComputerStatusDeps = {
  bot: Bot;
  profileBot: Bot;
  panelView: ComputerPanelView;
  capabilitiesReady: boolean;
  localAvailable: boolean;
  providerSupportsLocal: boolean;
  localSelectable: boolean;
  isLinux: boolean;
  vmSupported: boolean;
  cloudSupported: boolean;
  vpsSupported: boolean;
  canManageCloud: boolean;
  computerSelectionPersisted: boolean;
  surfaceReady: boolean;
  threadPath: (suffix: string) => string;
  cloudBackend: CloudBackend;
  retry: number;
  phase: Phase;
  selectedInstance: InstanceInfo | undefined;
  vmReadinessAttempts: { current: number };
  setPhase: Dispatch<SetStateAction<Phase>>;
  setError: Dispatch<SetStateAction<Error | string | null>>;
  setRetry: Dispatch<SetStateAction<number>>;
  setBoxState: Dispatch<SetStateAction<string | null>>;
  setVmStatus: Dispatch<SetStateAction<LocalVmStatus | null>>;
  setVpsStatus: Dispatch<SetStateAction<VpsComputerStatus | null>>;
  setVmViewerUrl: Dispatch<SetStateAction<string | null>>;
  setPolledFrame: Dispatch<SetStateAction<{ png: string; mime: string } | null>>;
  setPreviewError: Dispatch<SetStateAction<Error | string | null>>;
  setVmFrame: Dispatch<SetStateAction<string | null>>;
  setLocalFrame: Dispatch<SetStateAction<string | null>>;
  setResolvedComputerSelection: Dispatch<SetStateAction<ResolvedComputerSelection | null>>;
  setTeamComputer: Dispatch<SetStateAction<{
    id: string; name: string; botId: string; section: string;
  } | null>>;
};

/** Resolve the panel's phase set: one pass per confirmed selection that
 * reads the box/VM/VPS status snapshots and lets the pure deciders in
 * `@/lib/computer-panel-phase` settle what to show. */
export function useComputerStatus(deps: ComputerStatusDeps) {
  const {
    bot,
    profileBot,
    panelView,
    capabilitiesReady,
    localAvailable,
    providerSupportsLocal,
    localSelectable,
    isLinux,
    vmSupported,
    cloudSupported,
    vpsSupported,
    canManageCloud,
    computerSelectionPersisted,
    surfaceReady,
    threadPath,
    cloudBackend,
    retry,
    phase,
    selectedInstance,
    vmReadinessAttempts,
    setPhase,
    setError,
    setRetry,
    setBoxState,
    setVmStatus,
    setVpsStatus,
    setVmViewerUrl,
    setPolledFrame,
    setPreviewError,
    setVmFrame,
    setLocalFrame,
    setResolvedComputerSelection,
    setTeamComputer,
  } = deps;
  const { state } = useStore();
  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    // Other tabs own their surfaces. Do not provision a VM, wake a box,
    // or churn preview state while reading routine history.
    if (panelView !== "computer") return;
    let alive = true;
    let boxRetryTimer: number | undefined;
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    setPolledFrame(null);
    setPreviewError(null);
    setVmFrame(null);
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    // The selection may be optimistic for up to the profile debounce. Never
    // let it choose a provider until the PATCH lane confirms server state.
    if (!computerSelectionPersisted || !surfaceReady) return;
    const selectionPhase = decideSelectionPhase(bot.computer);
    if (selectionPhase) {
      setPhase(selectionPhase);
      return;
    }
    if (bot.computer === "local") {
      const local = decideLocalPhase({ capabilitiesReady, localAvailable, providerSupportsLocal });
      setError(phaseErrorToPanelError(local.error));
      setPhase(local.phase);
      setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        const unsupported = decideVmPhase({ vmSupported, status: null });
        setError(phaseErrorToPanelError(unsupported.error));
        setPhase(unsupported.phase);
        return;
      }
      let retryTimer: number | undefined;
      api(threadPath("local-computer"))
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
          setVmStatus(status);
          // parse at the boundary: our own status endpoint sends a string or nothing
          const viewerUrl = String(status.viewer_url ?? "");
          if (viewerUrl.startsWith("http")) setVmViewerUrl(viewerUrl);
          if (isVmAwaitingDesktop(status, vmReadinessAttempts.current)) {
            vmReadinessAttempts.current += 1;
            setError(null);
            setPhase("checking");
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
            return;
          }
          const vm = decideVmPhase({ vmSupported: true, status });
          if (vm.phase === "vm") vmReadinessAttempts.current = 0;
          setError(phaseErrorToPanelError(vm.error));
          setPhase(vm.phase);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase(decideVmPhase({ vmSupported: true, status: null }).phase);
        });
      return () => {
        alive = false;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setError(new LocalizedPanelError("computer.err.cloudEngine"));
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
      if (!vpsSupported) {
        setError(new LocalizedPanelError("computer.err.vpsEngine"));
        setPhase("error");
        return;
      }
      api(threadPath("computer"))
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          setResolvedComputerSelection({
            botId: bot.id,
            threadId: bot.threadId,
            computer: bot.computer,
            cloudBackend,
          });
          const vps = decideVpsPhase({ status, canManageCloud, autoStartVps: bot.autoStartVps });
          if (vps.phase === "provision") {
            setPhase("starting");
            return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
              if (!alive) return;
              setBoxState(result.container ?? null);
              const provisioned = decideVpsProvisionPhase(result);
              if (provisioned.phase === "ready") {
                setResolvedComputerSelection({
                  botId: bot.id,
                  threadId: bot.threadId,
                  computer: bot.computer,
                  cloudBackend,
                });
              }
              setError(phaseErrorToPanelError(provisioned.error));
              setPhase(provisioned.phase);
            });
          }
          if (vps.phase === "ready" || vps.phase === "vps-stopped"
            || (vps.phase === "vps-unconfigured" && status.configured)) {
            setBoxState(status.container ?? null);
          }
          setError(phaseErrorToPanelError(vps.error));
          setPhase(vps.phase);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("error");
        });
      return () => {
        alive = false;
      };
    }
    // Explicit Cloud may create/wake its Box. Auto is observation-only here:
    // even a ready Box and the box-native engine stay free of POSTs until the
    // person deliberately chooses Cloud.
    api(threadPath("computer"))
      .then((status) => {
        if (!alive) return;
        const box = decideBoxPhase({
          computer: bot.computer,
          canManageCloud,
          canUseCloud: cloudSupported,
          busy: profileBot.busy,
          status,
        });
        setResolvedComputerSelection({
          botId: bot.id,
          threadId: bot.threadId,
          computer: bot.computer,
          cloudBackend,
        });
        if (box.phase === "team-box") {
          setTeamComputer({ id: status.teamComputer.id, name: status.teamComputer.name,
            botId: bot.id, section: bot.section?.trim() ?? "" });
          setBoxState(typeof status.box?.state === "string" ? status.box.state : status.configured ? "missing" : "unavailable");
          setError(phaseErrorToPanelError(box.error));
          setPhase(box.phase);
          return;
        }
        if (box.phase === "ready") {
          // The turn owns a ready box; provisioning would be refused (409)
          // and is not needed. Going straight to ready lets the turn's live
          // frames and the screenshot poll show what the bot is doing.
          setBoxState(typeof status.box?.state === "string" ? status.box.state : null);
          setPhase(box.phase);
          return;
        }
        if (box.phase === "ensure-box") {
          setPhase("starting");
          return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
            if (!alive) return;
            setBoxState(r.state ?? null);
            setResolvedComputerSelection({
              botId: bot.id,
              threadId: bot.threadId,
              computer: bot.computer,
              cloudBackend,
            });
            setPhase("ready");
          });
        }
        if (box.phase === "show-ready-box" || box.phase === "show-sleeping-box" || box.phase === "show-pending-box") {
          setBoxState(typeof status.box?.state === "string" ? status.box.state : null);
        }
        setPhase(box.phase);
      })
      .catch((e) => {
        if (!alive) return;
        const outcome = decideBoxErrorPhase(e);
        // A turn that started while provision was in flight: not a fault,
        // the panel waits for the turn (bot.busy re-runs this effect).
        if (outcome.phase === "busy-box") {
          setPhase(outcome.phase);
          return;
        }
        // The panel's own screenshot poll holds this box's lifecycle claim
        // while it captures, so a provision landing mid-capture is refused
        // with a *different* 409. It is a wait too: re-resolve shortly
        // instead of showing the fault this panel exists to stop showing.
        if (outcome.phase === "checking") {
          setError(null);
          setPhase("checking");
          boxRetryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          return;
        }
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
      if (boxRetryTimer !== undefined) window.clearTimeout(boxRetryTimer);
    };
  }, [
    bot.id,
    bot.threadId,
    bot.computer,
    bot.section,
    bot.autoStartVps,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    selectedInstance?.driverKind,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
    panelView,
    computerSelectionPersisted,
    surfaceReady,
    canManageCloud,
    threadPath,
    setPhase,
    setError,
    setRetry,
    setBoxState,
    setVmStatus,
    setVpsStatus,
    setVmViewerUrl,
    setPolledFrame,
    setPreviewError,
    setVmFrame,
    setLocalFrame,
    setResolvedComputerSelection,
    setTeamComputer,
  ]);

  // busy-box waits for the turn's own provisioning. Nothing else re-runs the
  // resolve effect until the turn ends, so watch the box ourselves and attach
  // as soon as it is ready — the screen should appear mid-turn, not after.
  useEffect(() => {
    if (deps.phase !== "busy-box") return;
    let alive = true;
    const check = () => {
      if (!profileBot.busy && canManageCloud) {
        setRetry((n) => n + 1);
        return;
      }
      api(threadPath("computer"))
        .then((status) => {
          if (!alive) return;
          const state = typeof status.box?.state === "string" ? status.box.state : null;
          if (isReadyBoxState(state)) {
            setBoxState(state);
            setPhase("ready");
          }
        })
        .catch(() => { /* the next tick tries again */ });
    };
    const timer = window.setInterval(check, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, threadPath, profileBot.busy, canManageCloud, setRetry, setBoxState, setPhase]);
}
