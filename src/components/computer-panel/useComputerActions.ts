import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { api, type Bot } from "@/state/store";
import type { CloudBackend } from "../../../shared/wire";
import type { ComputerControlAction } from "@/lib/computer-control";
import type { LocalVmStatus, VpsComputerStatus } from "@/lib/computer-panel-phase";
import { t } from "@/lib/i18n";
import { LocalizedPanelError, type Phase } from "./panelError";
import type { PendingAction } from "./types";

type ResolvedComputerSelection = {
  botId: string;
  threadId: string;
  computer: Bot["computer"];
  cloudBackend: CloudBackend;
};

/** The panel's long-running lifecycle moves: opening the desktop viewer,
 * sleeping/provisioning a Box, and creating/replacing/deleting the per-bot
 * VM or VPS computer. */
export function useComputerActions({
  bot,
  viewerConnectionKey,
  viewerConnection,
  cloudPreviewReady,
  cloudBackend,
  threadPath,
  vmViewerUrl,
  control,
  transitionControl,
  vmReadinessAttempts,
  setControlPending,
  setPending,
  setError,
  setPhase,
  setBoxState,
  setVmStatus,
  setVpsStatus,
  setResolvedComputerSelection,
  setRetry,
}: {
  bot: Bot;
  viewerConnectionKey: string;
  viewerConnection: { current: string };
  cloudPreviewReady: boolean;
  cloudBackend: CloudBackend;
  threadPath: (suffix: string) => string;
  vmViewerUrl: string | null;
  control: { held: boolean; helpReason: string | null };
  transitionControl: (action: ComputerControlAction) => Promise<unknown>;
  vmReadinessAttempts: { current: number };
  setControlPending: Dispatch<SetStateAction<boolean>>;
  setPending: Dispatch<SetStateAction<PendingAction>>;
  setError: Dispatch<SetStateAction<Error | string | null>>;
  setPhase: Dispatch<SetStateAction<Phase>>;
  setBoxState: Dispatch<SetStateAction<string | null>>;
  setVmStatus: Dispatch<SetStateAction<LocalVmStatus | null>>;
  setVpsStatus: Dispatch<SetStateAction<VpsComputerStatus | null>>;
  setResolvedComputerSelection: Dispatch<SetStateAction<ResolvedComputerSelection | null>>;
  setRetry: Dispatch<SetStateAction<number>>;
}) {
  const desktopJoin = useRef<AbortController | null>(null);
  useEffect(() => () => desktopJoin.current?.abort(), [viewerConnectionKey]);
  const ownsActiveConnection = () => viewerConnection.current === viewerConnectionKey;

  const openDesktop = async () => {
    const controller = new AbortController();
    desktopJoin.current = controller;
    const ownsConnection = () => !controller.signal.aborted && viewerConnection.current === viewerConnectionKey;
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    // A plain-web development session still needs a synchronous blank tab;
    // the packaged app uses the reliable Electron viewer window below.
    let fallbackTab: Window | null = null;
    if (!window.ogb?.desktopViewer && !window.ogb?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await transitionControl("take");
        tookControl = true;
      }
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");

      let viewerUrl = vmViewerUrl;
      if (cloudPreviewReady) {
        const result = await api(threadPath("computer/join"), { method: "POST", signal: controller.signal });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");
      if (!viewerUrl) throw new LocalizedPanelError("computer.err.noDesktopLink");

      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, t("computer.viewerTitle", { name: bot.name }), bot.id);
        if (!opened) throw new LocalizedPanelError("computer.err.openDesktop");
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.ogb?.openExternal) {
        const opened = await window.ogb.openExternal(viewerUrl);
        if (!opened) throw new LocalizedPanelError("computer.err.openDesktopLink");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new LocalizedPanelError("computer.err.popupBlocked");
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the bot before waiting on best-effort tunnel cleanup. A sick
      // SSH process must never leave the agent paused indefinitely.
      if (tookControl) await transitionControl("release").catch(() => {});
      if (cloudPreviewReady && cloudBackend === "vps") {
        await api(threadPath("computer/viewer-close"), { method: "POST", body: "{}" }).catch(() => {});
      }
      if (ownsConnection()) setError(e instanceof Error ? e : String(e));
    } finally {
      if (desktopJoin.current === controller) {
        desktopJoin.current = null;
        setPending(null);
        setControlPending(false);
      }
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
  api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
    .then((result) => {
      if (!ownsActiveConnection()) return;
      if (kind === "provision") {
          setBoxState(result.container ?? null);
          if (result.ready) {
            if (bot.computer === "cloud") {
              setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
            }
            setPhase("ready");
          }
          else {
            setError(result.problem ?? new LocalizedPanelError("computer.err.vpsNotReady"));
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setResolvedComputerSelection(null);
          setBoxState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
        }
    })
    .catch((e) => {
      if (!ownsActiveConnection()) return;
      setError(e.message);
    })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-create" | "vm-recreate" | "vm-delete") => {
    if (
      (action === "vm-recreate" || action === "vm-delete") &&
      !window.confirm(
        action === "vm-delete"
          ? t("computer.confirm.deleteVm", { name: bot.name })
          : t("computer.confirm.replaceVm", { name: bot.name }),
      )
    ) return;
    setPending(action);
    setError(null);
    setVmStatus(null);
    vmReadinessAttempts.current = 0;
    try {
      if (action !== "vm-create") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, {
          method: "POST",
          body: "{}",
        });
        if (!ownsActiveConnection()) return;
      }
      if (action !== "vm-delete") {
        const status: LocalVmStatus = await api(`/api/bots/${bot.id}/local-computer/run`, {
          method: "POST",
          body: "{}",
        });
        if (!ownsActiveConnection()) return;
        setVmStatus(status);
        setPhase(status.ready ? "vm" : "checking");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
    } catch (e) {
      if (!ownsActiveConnection()) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("vm-unavailable");
    } finally {
      setPending(null);
      if (ownsActiveConnection()) setRetry((n) => n + 1);
    }
  };

  const replaceVpsComputer = async () => {
    if (!window.confirm(t("computer.confirm.replaceVps", { name: bot.name }))) return;
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      if (!ownsActiveConnection()) return;
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      if (!ownsActiveConnection()) return;
      setVpsStatus(result);
      setBoxState(result.container ?? null);
      if (result.ready && bot.computer === "cloud") {
        setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
      }
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError(result.problem ?? new LocalizedPanelError("computer.err.vpsReplaceNotReady"));
    } catch (e) {
      if (!ownsActiveConnection()) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setPending(null);
      if (ownsActiveConnection()) setRetry((n) => n + 1);
    }
  };

  return { openDesktop, run, runVmAction, replaceVpsComputer };
}
