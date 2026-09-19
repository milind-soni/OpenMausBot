import { Loader2, Maximize2, Monitor, Power } from "lucide-react";
import { t } from "@/lib/i18n";
import { CloudScreenPreview } from "../CloudScreenPreview";
import type { Bot } from "@/state/store";
import type { CloudBackend } from "../../../shared/wire";
import type { LocalVmStatus, VpsComputerStatus } from "@/lib/computer-panel-phase";
import type { ComputerPanelView } from "@/lib/computer-panel-view";
import { panelErrorText, type Phase } from "./panelError";
import type { PendingAction } from "./types";

/** The screen area of the Computer tab: the live preview (cloud, VM, or
 * local) or the empty state that explains the phase and offers the action
 * that moves it forward. */
export function ScreenPreview({
  bot,
  phase,
  isLinux,
  currentTeamComputer,
  boxState,
  cloudPreviewReady,
  frameSrc,
  previewOpensDesktop,
  previewError,
  previewRefreshing,
  previewRetry,
  pending,
  controlPending,
  localMisses,
  vmStatus,
  vpsStatus,
  canManageVm,
  canManageCloud,
  computerStatusCurrent,
  cloudBackend,
  browserEnabled,
  localDisabledReason,
  onOpenDesktop,
  onRetry,
  selectPanelView,
  updateComputerSelection,
  run,
  runVmAction,
  replaceVpsComputer,
  openVmSettings,
  openConnectionSettings,
  onShowTeamMap,
  onRefreshStatus,
}: {
  bot: Bot;
  phase: Phase;
  isLinux: boolean;
  currentTeamComputer: { id: string; name: string; botId: string; section: string } | null;
  boxState: string | null;
  cloudPreviewReady: boolean;
  frameSrc: string | null;
  previewOpensDesktop: boolean;
  previewError: Error | string | null;
  previewRefreshing: boolean;
  previewRetry: number;
  pending: PendingAction;
  controlPending: boolean;
  localMisses: number;
  vmStatus: LocalVmStatus | null;
  vpsStatus: VpsComputerStatus | null;
  canManageVm: boolean;
  canManageCloud: boolean;
  computerStatusCurrent: boolean;
  cloudBackend: CloudBackend;
  browserEnabled: boolean;
  localDisabledReason: string | null;
  onOpenDesktop: () => void;
  onRetry: (discardFrame: boolean) => void;
  selectPanelView: (view: ComputerPanelView) => void;
  updateComputerSelection: (patch: {
    computer?: Bot["computer"] | null;
    cloudBackend?: CloudBackend;
    browser?: boolean;
    acknowledgeLocalAuto?: boolean;
  }) => void;
  run: (kind: "sleep" | "provision") => void;
  runVmAction: (action: "vm-create" | "vm-recreate" | "vm-delete") => void;
  replaceVpsComputer: () => void;
  openVmSettings: () => void;
  openConnectionSettings: () => void;
  onShowTeamMap: () => void;
  onRefreshStatus: () => void;
}) {
  const emptyState = {
    checking: t("computer.phase.checking"),
    starting: t("computer.phase.starting"),
    "busy-box": t("computer.phase.busyBox"),
    unconfigured: t("computer.phase.unconfigured"),
    "auto-unavailable": t("computer.phase.autoUnavailable"),
    "team-box": t("computer.phase.teamBox"),
    "show-ready-box": t("computer.phase.showReadyBox"),
    "show-sleeping-box": t("computer.phase.showSleepingBox"),
    "show-pending-box": t("computer.phase.showPendingBox"),
    "vps-unconfigured": t("computer.phase.vpsUnconfigured"),
    "vps-incompatible": t("computer.phase.vpsIncompatible"),
    "vps-stopped": t("computer.phase.vpsStopped"),
    "local-unavailable": localDisabledReason ?? t("computer.phase.localUnavailable"),
    "vm-unavailable": t("computer.phase.vmUnavailable"),
    browser: t("computer.phase.browser"),
    off: t("computer.phase.off"),
    error: t("computer.phase.error"),
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  return (
    <>
          {/* Screen preview */}
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{t("computer.screenOf", { name: bot.name })}</span>
            {currentTeamComputer && <span className="text-[11px]">{t("computer.badge.teamDefault")}</span>}
            {phase === "local" && <span className="text-[11px]">{t("computer.badge.local")}</span>}
            {phase === "vm" && <span className="text-[11px]">{t("vm.dest.vm")}</span>}
            {(phase === "show-ready-box" || phase === "show-sleeping-box" || phase === "show-pending-box") && (
              <span className="text-[11px]">{t("computer.badge.autoBox")}</span>
            )}
            {computerStatusCurrent && bot.computer === "cloud" && cloudBackend === "vps" && (phase === "ready" || phase === "starting") && <span className="text-[11px]">{t("computer.badge.vps")}</span>}
        </div>
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {cloudPreviewReady || (bot.computer === "cloud" && phase === "starting") ? (
            <CloudScreenPreview
              key={`${bot.id}:${bot.threadId}:${bot.computer}:${cloudBackend}`}
              src={frameSrc}
              name={bot.name}
              error={panelErrorText(previewError)}
              refreshing={previewRefreshing}
              retry={previewRetry}
              starting={phase === "starting"}
              opening={pending === "join"}
              disabled={controlPending}
              onOpen={() => void onOpenDesktop()}
              onRetry={onRetry}
            />
          ) : frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void onOpenDesktop()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={t("computer.openLiveDesktopAria", { name: bot.name })}
              title={t("computer.openLiveDesktop")}
            >
              <img
                src={frameSrc}
                alt={t("computer.screenOf", { name: bot.name })}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                {t("computer.open")}
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={t("computer.screenOf", { name: bot.name })}
              className="h-full w-full object-contain"
              title={phase === "vm" ? t("computer.watchOnly") : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "busy-box" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {currentTeamComputer
                  ? `${currentTeamComputer.name} · ${boxState ?? t("computer.badge.unavailable")}`
                  : cloudPreviewReady
                  ? t("computer.waitingFrame")
                  : phase === "ready"
                    ? t("computer.autoChooseCloudOpen")
                  : phase === "vm"
                    ? t("computer.capturingVm")
                  : phase === "local"
                    ? isLinux
                      ? t("computer.linuxReady")
                      : localMisses >= 3
                      ? t("computer.needsScreenPerm")
                      : t("computer.capturingLocal")
                    : emptyState[phase]}
              </span>
              {currentTeamComputer && <>
                <p className="text-[12px]">{t("computer.teamSharedNote")}</p>
                <button type="button" onClick={onShowTeamMap}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">{t("computer.openTeamMap")}</button>
                <button type="button" onClick={onRefreshStatus}
                  className="text-[11px] text-ink-secondary hover:text-ink">{t("computer.refreshTeamStatus")}</button>
              </>}
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openSettings")}
                </button>
              )}
              {phase === "browser" && browserEnabled && (
                <button
                  onClick={() => selectPanelView("browser")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openBrowserTab")}
                </button>
              )}
              {(phase === "show-ready-box" || phase === "show-sleeping-box" || phase === "show-pending-box") && (
                <button
                  type="button"
                  onClick={() => updateComputerSelection({ computer: "cloud" })}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {phase === "show-sleeping-box"
                    ? t("computer.chooseCloudWake")
                    : phase === "show-ready-box"
                      ? t("computer.chooseCloudOpen")
                      : t("computer.chooseCloudManage")}
                </button>
              )}
              {phase === "vm-unavailable" && (
                canManageVm && vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={pending !== null}
                    className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline animate-spin" />
                    )}
                    {vmStatus.container === "missing"
                      ? t("computer.createVm", { name: bot.name })
                      : t("computer.replaceVm", { name: bot.name })}
                  </button>
                ) : (
                  <button
                    onClick={openVmSettings}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    {t("computer.openVmSetup")}
                  </button>
                )
              )}
              {computerStatusCurrent && (phase === "vps-unconfigured" || phase === "vps-stopped") && (
                <button
                  onClick={openConnectionSettings}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openVpsSettings")}
                </button>
              )}
              {computerStatusCurrent && (phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                canManageCloud && (
                <button
                  onClick={() => run("provision")}
                  disabled={pending === "provision"}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {phase === "vps-stopped" ? t("computer.startVps") : t("computer.prepareVps")}
                </button>
              )}
              {computerStatusCurrent && phase === "vps-incompatible" && vpsStatus?.managed &&
                canManageCloud && (
                <button
                  onClick={() => void replaceVpsComputer()}
                  disabled={pending === "vps-replace"}
                  className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {pending === "vps-replace" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {t("computer.replaceVps")}
                </button>
              )}
            </div>
          )}
        </div>
    </>
  );
}
