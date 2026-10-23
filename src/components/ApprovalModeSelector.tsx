import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ListChecks } from "lucide-react";

import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { APPROVAL_LEVELS_URL, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import {
  approvalModeOptions,
  approvalModeOptionsFor,
  approvalModeSelectionRequiresLocalDesktop,
  shownApprovalMode,
} from "@/lib/approval-mode-options";

export {
  approvalModeOptions,
  approvalModeOptionsFor,
  approvalModeSelectionRequiresLocalDesktop,
  type ApprovalModeOption,
} from "@/lib/approval-mode-options";

 export function ApprovalModeSelector({
  approvalMode,
  autoApprove,
  providerName,
  driverKind,
  onSelect,
  align = "left",
  menuDirection = "up",
  wide = false,
  disabled = false,
  trustedModesAvailable = true,
  trustedModesNotice,
  onManageCommandAllowlist,
}: {
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  providerName: string;
  driverKind: string;
  onSelect: (mode: ApprovalMode) => void;
  align?: "left" | "right";
  menuDirection?: "up" | "down";
  wide?: boolean;
  disabled?: boolean;
  trustedModesAvailable?: boolean;
  trustedModesNotice?: string;
  onManageCommandAllowlist?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mode = shownApprovalMode(driverKind, approvalModeFor({ approvalMode, autoApprove }));
  const allOptions = approvalModeOptions();
  const current = approvalModeOptionsFor(driverKind).find((option) => option.mode === mode)
    ?? allOptions.find((option) => option.mode === mode)
    ?? allOptions[0];
  const visibleOptions = approvalModeOptionsFor(driverKind, trustedModesAvailable);
  const requiresLocalDesktop = approvalModeSelectionRequiresLocalDesktop(
    mode,
    trustedModesAvailable,
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const CurrentIcon = current.Icon;
  const triggerDisabled = disabled && !onManageCommandAllowlist;
  const modesDisabled = disabled || requiresLocalDesktop;
  const allowlistAction = onManageCommandAllowlist && (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        triggerRef.current?.focus();
        onManageCommandAllowlist();
      }}
      className="flex items-center gap-3 border-t border-hairline/20 px-4 py-3 text-left text-[14px] text-ink hover:bg-raised-hover"
    >
      <ListChecks size={18} className="shrink-0 opacity-80" />
      {t("commandAllowlist.title")}
    </button>
  );
  return (
    <div className={cn("relative flex items-center", wide && "w-full")} ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("approvalMode.triggerAria", { mode: current.label, provider: providerName })}
        disabled={triggerDisabled}
        title={disabled ? t("approvalMode.busy") : wide ? undefined : current.chip}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          wide
            ? "flex h-10 w-full items-center justify-between rounded-lg border border-hairline/40 bg-inset px-3.5 text-[13px] text-ink hover:bg-raised"
            : "flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink",
          triggerDisabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-ink-secondary",
        )}
      >
        {wide ? (
          <span className="flex min-w-0 items-center gap-2">
            <CurrentIcon size={14} className="shrink-0 opacity-70" />
            <span className="truncate">{current.label}</span>
          </span>
        ) : (
          <CurrentIcon size={16} className="shrink-0 opacity-80" />
        )}
        {wide && <span aria-hidden className="text-[11px] text-ink-secondary">⌄</span>}
      </button>

      {motion.shown && (
        <div
          role="menu"
          aria-label={t("approvalMode.menuAria", { provider: providerName })}
          {...motion.exitProps}
          className={cn(
            "absolute z-40 w-[340px] overflow-hidden rounded-2xl border border-hairline/40 bg-raised shadow-2xl",
            menuDirection === "up" ? "bottom-full mb-2" : "top-full mt-2",
            align === "right" ? "right-0" : "left-0",
            wide && "w-full min-w-[340px]",
            motion.className,
          )}
        >
          <div className="border-b border-hairline/20 px-4 py-3">
            <div className="text-[14px] font-medium text-ink">
              {t("approvalMode.question", { provider: providerName })}
            </div>
            <button
              type="button"
              onClick={() => void openExternalLink(APPROVAL_LEVELS_URL)}
              className="mt-1 text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink"
            >
              {t("approvalMode.learnMore")}
            </button>
          </div>
          <div className="flex flex-col py-1.5">
            {visibleOptions.map((option) => {
              const selected = option.mode === mode;
              const Icon = option.Icon;
              return (
                <Fragment key={option.mode}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={modesDisabled}
                    title={
                      disabled ? t("approvalMode.busy") : requiresLocalDesktop ? t("approvalMode.customLocalOnly") : undefined
                    }
                    onClick={() => {
                      if (modesDisabled) return;
                      onSelect(option.mode);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover",
                      modesDisabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
                    )}
                  >
                    <Icon size={18} className="mt-0.5 shrink-0 opacity-80" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center justify-between gap-3 text-[14px] text-ink">
                        {option.label}
                        {selected && <Check size={15} className="shrink-0" />}
                      </span>
                      <span className="text-[12.5px] leading-snug text-ink-secondary">
                        {option.description}
                      </span>
                    </span>
                  </button>
                  {option.mode === "full" && allowlistAction}
                </Fragment>
              );
            })}
            {!visibleOptions.some((option) => option.mode === "full") && allowlistAction}
            {!trustedModesAvailable && (trustedModesNotice || driverKind === "codex" || requiresLocalDesktop) && (
              <div className="border-t border-hairline/20 px-4 py-2.5 text-[11.5px] leading-snug text-ink-secondary">
                {trustedModesNotice ?? t("approvalMode.customLocalOnlyDot")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
