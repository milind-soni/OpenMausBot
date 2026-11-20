import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AudioLines, Camera, Check, Image, GraduationCap, ListChecks, Paperclip, Phone, Plus, Target } from "lucide-react";
import { approvalModeFor } from "../../shared/approval-mode";
import {
  approvalModeOptions, approvalModeOptionsFor, approvalModeSelectionRequiresLocalDesktop, shownApprovalMode,
} from "@/lib/approval-mode-options";
import { CALL_MODES, effectiveCallMode, useCallMode } from "@/lib/call-mode";
import { callCapabilityHelp } from "@/lib/call-capability";
import { listensHere, missingListenKey, speechBridge } from "@/lib/speech";
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

/** Finish together: the room (or, `solo`, the one bot) keeps working until the goal is done. The chip turns accent while it is on. */
export function GoalToggle({ on, onToggle, solo = false }: { on: boolean; onToggle: () => void; solo?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={t(solo ? "composer.goal.soloAria" : "composer.goal.aria")}
      title={t(solo ? "composer.goal.soloTitle" : "composer.goal.title")}
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap rounded-full border text-[13px] transition-colors",
        "h-8 px-3",
        on
          ? "border-accent/35 bg-accent/10 text-accent"
          : "border-hairline/20 bg-transparent text-ink-secondary interaction:bg-raised/50 hover:text-ink",
      )}
    >
      <Target size={14} aria-hidden="true" />
      {on ? "/goal" : t("composer.goal.chip")}
    </button>
  );
}

const check = <Check size={15} className="shrink-0 text-accent" aria-hidden="true" />;

/** The current approval level and its choices. */
function approvalMenu(choice: ApprovalChoice) {
  const trusted = choice.trustedModesAvailable ?? true;
  const mode = shownApprovalMode(choice.driverKind, approvalModeFor({ approvalMode: choice.approvalMode, autoApprove: choice.autoApprove }));
  const all = approvalModeOptions();
  const shown = approvalModeOptionsFor(choice.driverKind).find((option) => option.mode === mode)
    ?? all.find((option) => option.mode === mode)
    ?? all[0];
  const name = (option: typeof shown) => option.label;
  const current = shown;
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

function approvalItem(name: string, choice: ApprovalChoice): SidebarMenuItem {
  const { current, note, items } = approvalMenu(choice);
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
export function TeachTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("composer.teachTask")}
      title={t("composer.teachTask")}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary interaction:bg-raised/50 hover:text-ink"
    >
      <GraduationCap size={16} strokeWidth={1.75} absoluteStrokeWidth />
    </button>
  );
}

/**
 * The composer's round +: attach files, Work until done (Finish together in a group) and Teach a task. A phone's + also
 * holds what its narrow composer has no room for: the thread's approval level, the call mode and where the bot works,
 * each running the handler its Advanced button runs. With attaching the only choice, the + opens the file picker.
 */
export function ComposerPlusMenu({ onAttach, onChoosePhoto, onTakePhoto, goal, teach, approval, callBotId, extraItems = [], circle = false }: {
  onAttach: () => void;
  onChoosePhoto?: () => void;
  onTakePhoto?: () => void;
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
  const { state } = useStore();
  const storedMode = useCallMode();
  const onCall = useOnCall();
  const media = useLiveMedia();
  const turnsHere = !ready || listensHere(capabilities, state.config);
  const callMode = effectiveCallMode(storedMode, { turnsHere, canLive: true });
  const turnsHelp = turnsHere ? null : callCapabilityHelp(capabilities, Boolean(speechBridge(state.config)?.speechStart), missingListenKey(capabilities, state.config));
  // As the call button, which hides while Live is the mode and its line is held on another device.
  const lineHeldElsewhere = callMode === "live" && liveLineHeldElsewhere(media, state.liveCall);
  const calling = callBotId !== undefined && (onCall === callBotId || isLiveCallRunning(media.phase) || lineHeldElsewhere);

  const items: SidebarMenuItem[] = [
    ...(onTakePhoto ? [{ key: "take-photo", label: t("composer.takePhoto"), icon: <Camera size={16} />, onSelect: onTakePhoto }] : []),
    ...(onChoosePhoto ? [{ key: "choose-photo", label: t("settings.profile.avatar.choose"), icon: <Image size={16} />, onSelect: onChoosePhoto }] : []),
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
    ...(approval ? [approvalItem(approval.name, approval.choice)] : []),
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
  const trigger = (
    <span data-composer-plus className={cn("flex items-center justify-center text-ink", circle ? "size-9" : "size-7")}>
      <Plus size={18} aria-hidden="true" />
    </span>
  );
  if (!circle && items.length === 1) {
    return (
      <button type="button" onClick={onAttach} aria-label={t("composer.attachFiles")} title={t("composer.attachFiles")} className="flex shrink-0 bg-transparent">
        {trigger}
      </button>
    );
  }
  if (!circle) return <ComposerMenu items={items} trigger={trigger} />;
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("common.add")}
      triggerTitle={t("common.add")}
      triggerClassName="flex shrink-0 bg-transparent"
      renderTrigger={() => trigger}
    />
  );
}

/** The composer's own + menu: a short list just above the +, in the app's large menu style. Escape or a click
 * elsewhere closes it and hands focus back to the +. */
function ComposerMenu({ items, trigger }: { items: SidebarMenuItem[]; trigger: ReactNode }) {
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
        className="flex shrink-0 bg-transparent"
      >
        {trigger}
      </button>
      {motion.shown && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu" data-look="menu"
          aria-label={t("common.add")}
          data-composer-menu
          {...motion.exitProps}
          className={cn(
            "popover-surface absolute bottom-full start-0 z-40 mb-2 w-max min-w-[200px] max-w-[280px] origin-bottom-left rounded-[12px] border-[0.5px] border-ink/10 bg-menu p-1",
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
              className="flex h-[34px] w-full items-center gap-2 rounded-[8px] px-3 text-start text-[15px] text-ink transition-colors interaction:bg-raised/50 focus-visible:bg-raised/50 focus-visible:outline-none disabled:opacity-50"
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
