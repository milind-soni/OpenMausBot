import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AudioLines, Check, GraduationCap, ListChecks, Paperclip, Phone, Plus, Target, X } from "lucide-react";
import { approvalModeFor } from "../../shared/approval-mode";
import {
  approvalModeOptions,
  approvalModeOptionsFor,
  approvalModeSelectionRequiresLocalDesktop,
  shownApprovalMode,
  simpleApprovalName,
} from "@/lib/approval-mode-options";
import { useAdvancedMode } from "@/lib/interface-mode";
import { CALL_MODES, effectiveCallMode, useCallMode } from "@/lib/call-mode";
import { callCapabilityHelp } from "@/lib/call-capability";
import { requestCallStart } from "@/lib/call-start-request";
import { useOnCall } from "@/lib/call";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { liveLineHeldElsewhere } from "./LiveCallBar";
import { useMenuMotion } from "./MenuMotion";
import { nextMenuIndex, SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import type { ApprovalChoice } from "./thread-approval";
import { SIMPLE_CONTROL } from "./composer-simple";

/** Finish together: the room (or, `solo`, the one bot) keeps working until the goal is done. The chip turns accent while it is on.
 * `compact` is Simple mode's chip, shown only while the mode is on: its name and a × that turns it off. */
export function GoalToggle({ on, onToggle, solo = false, compact = false }: { on: boolean; onToggle: () => void; solo?: boolean; compact?: boolean }) {
  if (compact) {
    const off = t(solo ? "composer.goal.offSolo" : "composer.goal.off");
    return (
      <button
        type="button"
        data-goal-chip
        aria-label={off}
        title={off}
        onClick={onToggle}
        className="flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-accent/35 bg-accent/10 px-2.5 text-[13px] text-accent transition-colors hover:bg-accent/15"
      >
        {t(solo ? "composer.goal.soloAria" : "composer.goal.aria")}
        <X size={12} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={t(solo ? "composer.goal.soloAria" : "composer.goal.aria")}
      title={t(solo ? "composer.goal.soloTitle" : "composer.goal.title")}
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap rounded-full border text-[13px] transition-colors",
        compact ? "h-7 px-2.5" : "h-8 px-3",
        on
          ? "border-accent/35 bg-accent/10 text-accent"
          : "border-hairline/20 bg-transparent text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      <Target size={14} aria-hidden="true" />
      {on ? "/goal" : t("composer.goal.chip")}
    </button>
  );
}

const check = <Check size={15} className="shrink-0 text-accent" aria-hidden="true" />;

/** The thread's approval level, the same choices the Advanced composer's shield offers: the level shown and its menu.
 * Simple mode names the levels as the bot panel does. */
function approvalMenu(choice: ApprovalChoice, simple: boolean) {
  const trusted = choice.trustedModesAvailable ?? true;
  const mode = shownApprovalMode(choice.driverKind, approvalModeFor({ approvalMode: choice.approvalMode, autoApprove: choice.autoApprove }));
  const all = approvalModeOptions();
  const shown = approvalModeOptionsFor(choice.driverKind).find((option) => option.mode === mode)
    ?? all.find((option) => option.mode === mode)
    ?? all[0];
  const name = (option: typeof shown) => simple ? simpleApprovalName(option.mode, choice.driverKind) : option.label;
  const current = simple ? { ...shown, label: name(shown), chip: name(shown) } : shown;
  const localOnly = approvalModeSelectionRequiresLocalDesktop(mode, trusted);
  return {
    current,
    note: localOnly ? t("approvalMode.customLocalOnlyDot") : choice.busy ? t("approvalMode.whileWorking") : undefined,
    items: [
      ...approvalModeOptionsFor(choice.driverKind, trusted).map((option): SidebarMenuItem => {
        const Icon = option.Icon;
        return {
          key: `approval:${option.mode}`,
          label: name(option),
          note: option.description,
          icon: <Icon size={16} />,
          active: option.mode === mode,
          trailing: option.mode === mode ? check : undefined,
          disabled: localOnly,
          onSelect: () => choice.onSelect(option.mode),
        };
      }),
      ...(choice.onManageCommandAllowlist ? [{
        key: "approval:allowlist",
        separatorBefore: true,
        label: t("commandAllowlist.title"),
        icon: <ListChecks size={16} />,
        onSelect: choice.onManageCommandAllowlist,
      } satisfies SidebarMenuItem] : []),
    ],
  };
}

function approvalItem(name: string, choice: ApprovalChoice, simple: boolean): SidebarMenuItem {
  const { current, note, items } = approvalMenu(choice, simple);
  const CurrentIcon = current.Icon;
  return {
    key: "approval",
    separatorBefore: true,
    label: t("botSettings.simple.beforeActs", { name }),
    subtitle: current.label,
    note,
    icon: <CurrentIcon size={16} />,
    onSelect: () => {},
    submenu: items,
  };
}

/** The thread's approval level as a small pill that opens its choices: in the Simple composer while it is not the
 * default, and on the bot panel's Details. */
export function ApprovalChip({ choice, quiet = false }: { choice: ApprovalChoice; quiet?: boolean }) {
  const { current, note, items } = approvalMenu(choice, !useAdvancedMode());
  const CurrentIcon = current.Icon;
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("approvalMode.triggerAria", { mode: current.label, provider: choice.providerName })}
      triggerClassName="flex shrink-0 rounded-full"
      triggerTitle={note ? `${current.label} · ${note}` : current.label}
      renderTrigger={({ open }) => (
        <span
          data-approval-chip={current.mode}
          className={cn(
            "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] transition-colors",
            open ? "bg-ink/[0.11] text-ink" : quiet ? "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink" : "bg-ink/[0.06] text-ink-secondary hover:bg-ink/[0.11] hover:text-ink",
          )}
        >
          <CurrentIcon size={14} aria-hidden="true" />
          {current.chip}
        </span>
      )}
    />
  );
}

/**
 * The composer's round +: attach files, Work until done (Finish together in a group) and Teach a task. A phone's + also
 * holds what its narrow composer has no room for: the thread's approval level, the call mode and where the bot works,
 * each running the handler its Advanced button runs. With attaching the only choice, the + opens the file picker.
 */
export function ComposerPlusMenu({ onAttach, goal, teach, approval, callBotId, extraItems = [], circle = false }: {
  onAttach: () => void;
  /** Starts a /learn draft in the field, where the composer offers /learn. */
  teach?: () => void;
  /** Entries a phone composer moves here from its hidden buttons, such as where the bot works. */
  extraItems?: SidebarMenuItem[];
  /** The phone dock: a round button of its own beside the field, not a small chip inside it. */
  circle?: boolean;
  goal?: { on: boolean; onToggle: () => void; solo?: boolean };
  approval?: { name: string; choice: ApprovalChoice };
  /** The bot whose call button the call mode starts, as that button's own mode menu did. */
  callBotId?: string;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const storedMode = useCallMode();
  const onCall = useOnCall();
  const media = useLiveMedia();
  const turnsHere = !ready || capabilities.dictation.available;
  const callMode = effectiveCallMode(storedMode, { turnsHere, canLive: true });
  const turnsHelp = turnsHere ? null : callCapabilityHelp(capabilities, Boolean(window.ogb?.speechStart));
  const { state } = useStore();
  // As the call button, which hides while Live is the mode and its line is held on another device.
  const lineHeldElsewhere = callMode === "live" && liveLineHeldElsewhere(media, state.liveCall);
  const calling = callBotId !== undefined && (onCall === callBotId || isLiveCallRunning(media.phase) || lineHeldElsewhere);
  const simple = !useAdvancedMode();
  const items: SidebarMenuItem[] = [
    { key: "attach", label: t("composer.attachFiles"), icon: <Paperclip size={16} />, onSelect: onAttach },
    ...(goal ? [{
      key: "goal",
      label: t(goal.solo ? "composer.goal.soloAria" : "composer.goal.aria"),
      icon: <Target size={16} />,
      active: goal.on,
      trailing: goal.on ? check : undefined,
      onSelect: goal.onToggle,
    } satisfies SidebarMenuItem] : []),
    ...(teach ? [{ key: "teach", label: t("composer.teachTask"), icon: <GraduationCap size={16} />, onSelect: teach } satisfies SidebarMenuItem] : []),
    ...extraItems,
    ...(approval ? [approvalItem(approval.name, approval.choice, simple)] : []),
    ...(callBotId === undefined ? [] : CALL_MODES.map((entry, index): SidebarMenuItem => {
      const unavailable = entry.id === "turns" ? turnsHelp : null;
      return {
        key: `call:${entry.id}`,
        heading: index === 0 ? t("call.mode.menu") : undefined,
        separatorBefore: index === 0,
        label: t(entry.label),
        // Only a reason it can't be used: the modes' long hints would make the + menu a page.
        note: unavailable ? `${unavailable.label}. ${unavailable.reason}` : undefined,
        icon: entry.id === "live" ? <Phone size={16} /> : <AudioLines size={16} />,
        trailing: callMode === entry.id ? check : undefined,
        disabled: calling || Boolean(unavailable),
        onSelect: () => requestCallStart(callBotId, entry.id),
      };
    })),
  ];
  const trigger = (open: boolean) => circle ? (
    <span
      data-composer-plus
      className={cn(
        "flex size-11 items-center justify-center rounded-full bg-composer text-ink ring-1 ring-composer-ring transition-colors",
        // An ink tint, not a fill token: in some skins the control fill is the composer's own colour.
        open ? "bg-ink/[0.12]" : "bg-ink/[0.05] hover:bg-ink/[0.1]",
      )}
    >
      <Plus size={22} aria-hidden="true" />
    </span>
  ) : (
    <span data-composer-plus className={cn("flex items-center justify-center transition-colors", SIMPLE_CONTROL, open && "bg-ink/[0.09] text-ink")}>
      <Plus size={20} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
    </span>
  );
  if (!circle && items.length === 1) {
    return (
      <button type="button" onClick={onAttach} aria-label={t("composer.attachFiles")} title={t("composer.attachFiles")} className="flex shrink-0 rounded-full">
        {trigger(false)}
      </button>
    );
  }
  if (!circle) return <ComposerMenu items={items} renderTrigger={trigger} />;
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("common.add")}
      triggerTitle={t("common.add")}
      triggerClassName="flex shrink-0 rounded-full"
      renderTrigger={({ open }) => trigger(open)}
    />
  );
}

/** The composer's own + menu: a short list just above the +, in the app's large menu style. Escape or a click
 * elsewhere closes it and hands focus back to the +. */
function ComposerMenu({ items, renderTrigger }: { items: SidebarMenuItem[]; renderTrigger: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const rows = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const list = rows();
    const next = nextMenuIndex(event.key, list.indexOf(document.activeElement as HTMLButtonElement), list.length);
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  };
  return (
    <div ref={rootRef} className="relative flex shrink-0" onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("common.add")}
        title={t("common.add")}
        onClick={(event) => {
          const opening = !open;
          setOpen(opening);
          // A keyboard press lands on the first row, as every menu here does.
          if (opening && event.detail === 0) requestAnimationFrame(() => rows()[0]?.focus());
        }}
        className="flex shrink-0 rounded-full"
      >
        {renderTrigger(open)}
      </button>
      {motion.shown && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t("common.add")}
          data-composer-menu
          {...motion.exitProps}
          className={cn(
            "popover-surface absolute bottom-full start-0 z-40 mb-2 w-max min-w-[200px] max-w-[280px] origin-bottom-left rounded-[14px] border-[0.5px] border-ink/10 bg-menu p-1",
            motion.className,
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              data-menu-key={item.key}
              disabled={item.disabled}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              className="flex h-[34px] w-full items-center gap-2 rounded-[9px] px-3 text-start text-[15px] text-ink transition-colors hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:outline-none disabled:opacity-50"
            >
              <span className={cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5 [&_svg]:stroke-[1.5]", item.active ? "text-accent" : "text-ink-secondary")} aria-hidden="true">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.trailing}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
