import { Fragment, useEffect, useRef, useState } from "react";
import { Check, FilePen, Hand, ListChecks, Settings, ShieldAlert, ShieldCheck } from "lucide-react";

import { approvalModeFor, hasNativeAutoReview, supportsApprovalMode, type ApprovalMode } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { APPROVAL_LEVELS_URL, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** Keys, not labels — these are the words the held notes quote back to the
 * reader ("… so Approve for me stopped to ask"), and a label resolved in this
 * module-scope array would freeze the language the app booted in. */
const APPROVAL_MODE_KEYS: ReadonlyArray<{
  mode: ApprovalMode;
  labelKey: LocaleKey;
  chipKey: LocaleKey;
  descriptionKey: LocaleKey;
  Icon: typeof Hand;
}> = [
  { mode: "ask", labelKey: "approvalMode.ask.label", chipKey: "approvalMode.ask.chip", descriptionKey: "approvalMode.ask.desc", Icon: Hand },
  { mode: "edits", labelKey: "approvalMode.edits.label", chipKey: "approvalMode.edits.chip", descriptionKey: "approvalMode.edits.desc", Icon: FilePen },
  { mode: "auto", labelKey: "approvalMode.auto.label", chipKey: "approvalMode.auto.chip", descriptionKey: "approvalMode.auto.desc", Icon: ShieldCheck },
  { mode: "full", labelKey: "approvalMode.full.label", chipKey: "approvalMode.full.chip", descriptionKey: "approvalMode.full.desc", Icon: ShieldAlert },
  { mode: "custom", labelKey: "approvalMode.custom.label", chipKey: "approvalMode.custom.chip", descriptionKey: "approvalMode.custom.desc", Icon: Settings },
];

export interface ApprovalModeOption {
  mode: ApprovalMode;
  label: string;
  chip: string;
  description: string;
  Icon: typeof Hand;
}

/** The levels, in the reader's language. A function rather than a
 * constant: it has to answer to the language in effect when it is called. */
export function approvalModeOptions(): ApprovalModeOption[] {
  return APPROVAL_MODE_KEYS.map(({ mode, labelKey, chipKey, descriptionKey, Icon }) => ({
    mode,
    label: t(labelKey),
    chip: t(chipKey),
    description: t(descriptionKey),
    Icon,
  }));
}

export function approvalModeOptionsFor(driverKind: string, trustedModesAvailable = true) {
  return approvalModeOptions()
    .filter((option) => supportsApprovalMode(driverKind, option.mode)
      // Antigravity has no native reviewer. Offer its explicit full-access
      // grant as Auto instead of a second choice that actually behaves as Ask.
      && (driverKind !== "antigravityAgent" || option.mode !== "auto")
      && (trustedModesAvailable || option.mode === "ask" || option.mode === "edits" || option.mode === "auto"))
    .map((option) => {
      if (driverKind === "antigravityAgent" && option.mode === "full") {
        return {
          ...option,
          label: t("approvalMode.antigravity.label"),
          chip: t("approvalMode.auto.chip"),
          description: t("approvalMode.antigravity.desc"),
        };
      }
      return option.mode === "auto" && !hasNativeAutoReview(driverKind)
        ? { ...option, description: t("approvalMode.noNativeReview") }
        : option;
    });
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

/** How much this bot may do on its own, shown beside the composer with the
 * current mode as its icon. Opens a menu that lists every available mode with
 * its label and description and returns the chosen mode to the caller. Compact
 * (icon-only) by default; `wide` renders the labeled variant used on bot
 * settings. */
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const savedMode = approvalModeFor({ approvalMode, autoApprove });
  // Old Antigravity Auto settings still ask. Do not display or silently grant
  // the new Auto/full-access behavior until the user explicitly selects it.
  const mode = driverKind === "antigravityAgent" && savedMode === "auto" ? "ask" : savedMode;
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

      {open && (
        <div
          role="menu"
          aria-label={t("approvalMode.menuAria", { provider: providerName })}
          className={cn(
            "absolute z-40 w-[340px] overflow-hidden rounded-2xl border border-hairline/40 bg-raised shadow-2xl",
            menuDirection === "up" ? "bottom-full mb-2" : "top-full mt-2",
            align === "right" ? "right-0" : "left-0",
            wide && "w-full min-w-[340px]",
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
            {!trustedModesAvailable && (trustedModesNotice || driverKind === "codex" || driverKind === "antigravityAgent" || requiresLocalDesktop) && (
              <div className="border-t border-hairline/20 px-4 py-2.5 text-[11.5px] leading-snug text-ink-secondary">
                {trustedModesNotice ?? (requiresLocalDesktop
                  ? t("approvalMode.customLocalOnlyDot")
                  : driverKind === "antigravityAgent"
                    ? t("approvalMode.antigravityLocalOnly")
                    : t("approvalMode.trustedLocalOnly"))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
