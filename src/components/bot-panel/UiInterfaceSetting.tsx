import type { ReactNode } from "react";
import { BookOpenText, Check, Grid2x2Plus, LayoutDashboard } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import type { UiInterfaceLayout } from "../../../shared/wire";

export function UiInterfaceSetting({ bot }: { bot: Bot }) {
  const dispatch = useStoreDispatch();
  const ownerOrAdmin = useOwnerOrAdmin();
  const canEdit = ownerOrAdmin || bot.yourAccess === "edit";
  const selectLayout = (layout: UiInterfaceLayout) => dispatch({
    type: "updateBot",
    botId: bot.id,
    patch: { uiInterfaceLayout: bot.uiInterfaceLayout === layout ? null : layout },
  });
  return (
    <div className="grid grid-cols-2 gap-3 px-3.5 py-4 max-sm:grid-cols-1" role="group" aria-label={t("botPanel.uiInterface.templates")}>
      <TemplateTile
        title={t("botPanel.uiInterface.dashboard")}
        selected={bot.uiInterfaceLayout === "dashboard"}
        disabled={!canEdit}
        onClick={() => selectLayout("dashboard")}
      >
        <div className="flex h-full flex-col items-center justify-center gap-2 bg-inset text-ink-secondary">
          <LayoutDashboard size={36} strokeWidth={1.4} aria-hidden="true" />
        </div>
      </TemplateTile>
      <TemplateTile
        title={t("botPanel.uiInterface.cheatSheet")}
        selected={bot.uiInterfaceLayout === "cheat-sheet"}
        disabled={!canEdit}
        onClick={() => selectLayout("cheat-sheet")}
      >
        <div className="flex h-full flex-col items-center justify-center gap-2 bg-inset text-ink-tertiary">
          <BookOpenText size={36} strokeWidth={1.4} aria-hidden="true" />
        </div>
      </TemplateTile>
      <TemplateTile
        title={t("botPanel.uiInterface.custom")}
        selected={bot.uiInterfaceLayout === "custom"}
        disabled={!canEdit}
        onClick={() => selectLayout("custom")}
      >
        <div className="flex h-full items-center justify-center bg-inset text-ink-secondary">
          <Grid2x2Plus size={36} strokeWidth={1.4} aria-hidden="true" />
        </div>
      </TemplateTile>
    </div>
  );
}

function TemplateTile({ title, selected, disabled, onClick, children }: {
  title: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group min-w-0 overflow-hidden rounded-[12px] border bg-card text-left transition-[border-color,box-shadow,transform] duration-150 enabled:hover:-translate-y-0.5 enabled:hover:border-accent-border enabled:hover:shadow-md enabled:active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transform-none motion-reduce:transition-none",
        selected ? "border-accent ring-2 ring-accent/25" : "border-hairline",
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-inset">
        {children}
        <span className={cn(
          "absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-accent text-accent-ink transition-[opacity,transform] duration-150 motion-reduce:transition-none",
          selected ? "scale-100 opacity-100" : "scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100",
        )}>
          <Check size={14} aria-hidden="true" />
        </span>
      </div>
      <span className="block px-3 py-2.5 text-[13px] font-medium text-ink">{title}</span>
    </button>
  );
}
