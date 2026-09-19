import { Columns2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { ApiKeyRow } from "../ApiKeys";
import type { Bot } from "@/state/store";
import type { LocalVmStatus } from "@/lib/computer-panel-phase";
import type { Phase } from "./panelError";
import type { PendingAction } from "./types";

/** The slim strips beneath the preview: the error banner and the cards that
 * walk the person through configuring a Box key, a VPS alias, or opening a
 * second window for the VM workspace. */
export function PanelBanners({
  bot,
  phase,
  vmStatus,
  pending,
  errorText,
  onApiKeySaved,
  onOpenConnectionSettings,
  onOpenVmWorkspace,
}: {
  bot: Bot;
  phase: Phase;
  vmStatus: LocalVmStatus | null;
  pending: PendingAction;
  errorText: string | null;
  onApiKeySaved: (configured: boolean) => void;
  onOpenConnectionSettings: () => void;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  return (
    <>
        {errorText && (
          <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {errorText}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("computer.addBoxKey")}
            </div>
            <ApiKeyRow
              section="box"
              onSaved={onApiKeySaved}
            />
          </div>
        )}
        {phase === "vps-unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("computer.vpsAliasHint")}
            </div>
            <button
              onClick={onOpenConnectionSettings}
              className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              {t("computer.openVpsSettings")}
            </button>
          </div>
        )}

        {phase === "vm" &&
          vmStatus?.mode === "per-bot" &&
          window.ogb?.desktopWorkspace &&
          onOpenVmWorkspace && (
            <button
              type="button"
              onClick={() => onOpenVmWorkspace(bot.id)}
              disabled={pending !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 py-2 text-[13px] font-medium text-ink hover:bg-accent/15 disabled:opacity-50"
              title={t("computer.twoDesktopsTitle")}
            >
              <Columns2 size={14} />
              {t("computer.twoDesktops")}
            </button>
          )}
    </>
  );
}
