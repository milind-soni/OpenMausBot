import { Hand, Loader2, Monitor, Moon, Power } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { CloudBackend } from "../../../shared/wire";
import type { ComputerControlAction } from "@/lib/computer-control";
import type { LocalVmStatus } from "@/lib/computer-panel-phase";
import type { Phase } from "./panelError";
import type { PendingAction } from "./types";

/** Who-is-driving banners and the control surfaces that follow them: take
 * the wheel, open the live desktop, hand it back, sleep the Box, or delete
 * the per-bot VM. */
export function ControlActions({
  bot,
  profileBotBusy,
  phase,
  control,
  controlPending,
  pending,
  cloudPreviewReady,
  cloudBackend,
  boxState,
  vmViewerUrl,
  vmStatus,
  canManageVm,
  canManageCloud,
  currentTeamComputer,
  onOpenDesktop,
  onControlAction,
  onRunVmAction,
  onRun,
}: {
  bot: Bot;
  profileBotBusy: boolean | undefined;
  phase: Phase;
  control: { held: boolean; helpReason: string | null };
  controlPending: boolean;
  pending: PendingAction;
  cloudPreviewReady: boolean;
  cloudBackend: CloudBackend;
  boxState: string | null;
  vmViewerUrl: string | null;
  vmStatus: LocalVmStatus | null;
  canManageVm: boolean;
  canManageCloud: boolean;
  currentTeamComputer: { id: string; name: string; botId: string; section: string } | null;
  onOpenDesktop: () => void;
  onControlAction: (action: ComputerControlAction) => void;
  onRunVmAction: (action: "vm-create" | "vm-recreate" | "vm-delete") => void;
  onRun: (kind: "sleep" | "provision") => void;
}) {
  return (
    <>
        {/* Who is driving — take the wheel / hand it back */}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4">
            <div className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> {t("computer.askedHands")} {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "vm" || cloudPreviewReady ? void onOpenDesktop() : onControlAction("take")
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
              <button
                onClick={() => onControlAction("dismiss-help")}
                disabled={controlPending}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {t("computer.dismiss")}
              </button>
            </div>
          </div>
        )}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}
              {cloudPreviewReady && ` ${t("computer.useOpenDesktop")}`}
              {phase === "vm" && ` ${t("computer.useOpenDesktopVm")}`}
            </div>
            <button
              onClick={() => {
                onControlAction("release");
                void window.ogb?.desktopViewer?.close(bot.id);
              }}
              disabled={controlPending}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              {t("computer.handBack")}
            </button>
          </div>
        )}
        {phase === "vm" && vmViewerUrl && control.held && (
          <button
            onClick={() => void onOpenDesktop()}
            disabled={pending === "join"}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={t("computer.openVmDesktopTitle")}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
            {t("computer.openLiveDesktop")}
          </button>
        )}
        {phase === "vm" && !control.held && !control.helpReason && (
          <button
            onClick={() => void onOpenDesktop()}
            disabled={controlPending || pending === "join" || !vmViewerUrl}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={t("computer.takeControlVmTitle")}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            {t("computer.takeControl")}
          </button>
        )}
        {canManageVm && phase === "vm" && vmStatus?.mode === "per-bot" && (
          <button
            onClick={() => void onRunVmAction("vm-delete")}
            disabled={pending !== null || profileBotBusy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={profileBotBusy ? t("computer.deleteVmBlocked") : t("computer.deleteVmTitle", { name: bot.name })}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {t("computer.deleteVm")}
          </button>
        )}
        {/* Cloud-only actions */}
        {cloudPreviewReady && (
          <div className="mt-3 flex gap-2">
            {!control.held && !control.helpReason && (
              <button
                onClick={() =>
                  void onOpenDesktop()
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.takeControlTitle")}
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
            )}
            {control.held && (
              <button
                onClick={() => void onOpenDesktop()}
                disabled={pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                {t("computer.openLiveDesktop")}
              </button>
            )}
            {canManageCloud && (cloudBackend === "vps" || boxState !== "archived") && (
              <button
                onClick={() => onRun("sleep")}
                // the server refuses sleep while a turn owns the box (409)
                disabled={pending !== null || profileBotBusy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.sleepTitle")}
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                {t("vm.cloud.sleep")}
              </button>
            )}
          </div>
        )}
    </>
  );
}
