import { useEffect, useRef, useState } from "react";
import { Check, Hand, Settings, ShieldAlert, ShieldCheck } from "lucide-react";

import { approvalModeFor, hasNativeAutoReview, supportsApprovalMode, type ApprovalMode } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { APPROVAL_LEVELS_URL, openExternalLink } from "@/lib/app-links";

export const APPROVAL_MODE_OPTIONS: ReadonlyArray<{
  mode: ApprovalMode;
  label: string;
  chip: string;
  description: string;
  Icon: typeof Hand;
}> = [
  {
    mode: "ask",
    label: "Ask for approval",
    chip: "Ask",
    description: "Always ask to edit external files and use the internet",
    Icon: Hand,
  },
  {
    mode: "auto",
    label: "Approve for me",
    chip: "Auto",
    description: "The provider reviews routine actions and asks about others; unattended turns always ask",
    Icon: ShieldCheck,
  },
  {
    mode: "full",
    label: "Full access",
    chip: "Full access",
    description: "Full computer access (elevated risk)",
    Icon: ShieldAlert,
  },
  {
    mode: "custom",
    label: "Custom (config.toml)",
    chip: "Custom",
    description: "Uses permissions defined in config.toml",
    Icon: Settings,
  },
];

export function approvalModeOptionsFor(driverKind: string, trustedModesAvailable = true) {
  return APPROVAL_MODE_OPTIONS
    .filter((option) => supportsApprovalMode(driverKind, option.mode)
      && (trustedModesAvailable || option.mode === "ask" || option.mode === "auto"))
    .map((option) => option.mode === "auto" && !hasNativeAutoReview(driverKind)
      ? { ...option, description: "This provider has no automatic review; behaves like Ask" }
      : option);
}

export function approvalModeSelectionRequiresLocalDesktop(
  currentMode: ApprovalMode,
  trustedModesAvailable: boolean,
) {
  // A persisted bot can temporarily lose its provider instance. Custom still
  // cannot leave through HTTP in that state, so the lock follows the durable
  // mode rather than today's provider lookup.
  return currentMode === "custom" && !trustedModesAvailable;
}

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
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mode = approvalModeFor({ approvalMode, autoApprove });
  const current = APPROVAL_MODE_OPTIONS.find((option) => option.mode === mode) ?? APPROVAL_MODE_OPTIONS[0];
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
  return (
    <div className={cn("relative flex items-center", wide && "w-full")} ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current.label} for ${providerName}`}
        disabled={disabled}
        title={disabled ? "Stop this bot's turn before changing its approval level" : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline/20 bg-transparent px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
          wide && "h-10 w-full justify-between rounded-lg border-hairline/40 bg-inset px-3.5 text-ink",
          disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-ink-secondary",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <CurrentIcon size={14} className="shrink-0 opacity-70" />
          <span className="truncate">{wide ? current.label : current.chip}</span>
        </span>
        {wide && <span aria-hidden className="text-[11px] text-ink-secondary">⌄</span>}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Approval mode for ${providerName}`}
          className={cn(
            "absolute z-40 w-[340px] overflow-hidden rounded-2xl border border-hairline/40 bg-raised shadow-2xl",
            menuDirection === "up" ? "bottom-full mb-2" : "top-full mt-2",
            align === "right" ? "right-0" : "left-0",
            wide && "w-full min-w-[340px]",
          )}
        >
          <div className="border-b border-hairline/20 px-4 py-3">
            <div className="text-[14px] font-medium text-ink">
              How should {providerName} actions be approved?
            </div>
            <button
              type="button"
              onClick={() => void openExternalLink(APPROVAL_LEVELS_URL)}
              className="mt-1 text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink"
            >
              Learn more
            </button>
          </div>
          <div className="flex flex-col py-1.5">
            {visibleOptions.map((option) => {
              const selected = option.mode === mode;
              const Icon = option.Icon;
              return (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={requiresLocalDesktop}
                  title={
                    requiresLocalDesktop
                      ? "Custom approval must be changed in the local packaged desktop app"
                      : undefined
                  }
                  onClick={() => {
                    onSelect(option.mode);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover",
                    requiresLocalDesktop && "cursor-not-allowed opacity-45 hover:bg-transparent",
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
              );
            })}
            {!trustedModesAvailable && (driverKind === "codex" || requiresLocalDesktop) && (
              <div className="border-t border-hairline/20 px-4 py-2.5 text-[11.5px] leading-snug text-ink-secondary">
                {requiresLocalDesktop
                  ? "Custom approval must be changed in the local packaged desktop app."
                  : "Full and Custom are available in the packaged desktop app."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
