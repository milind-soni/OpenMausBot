import type { CSSProperties } from "react";
import { ArrowUp, ChevronUp, Clock, CornerDownRight, RotateCcw } from "lucide-react";

import type { FollowUp } from "../../shared/follow-up";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

const FOLLOW_UP_ICON = { steer: CornerDownRight, queue: Clock, restart: RotateCcw } as const;

export interface FollowUpMenu {
  /** What Enter does first, then the other one where the turn can be steered, then restart. */
  choices: FollowUp[];
  name: string;
  sendKey: string;
  alternateKey: string;
}

/** The composer's round Send button. While a one-to-one bot works, a click does what Enter does and a Ctrl/⌘-click the
 * other one; the chevron beside it lists every way this message can meet the running turn. */
export function ComposerSendButton({ compact, waits, label, title, look, disabled, onSend, menu, onChoose }: {
  compact: boolean;
  /** The message will wait for the running turn: a clock on a quiet button instead of the bot's colour. */
  waits: boolean;
  label: string;
  title: string;
  look: { className: string; style?: CSSProperties };
  disabled: boolean;
  onSend: (alternate: boolean) => void;
  menu?: FollowUpMenu;
  onChoose: (followUp: FollowUp) => void;
}) {
  const alternate = menu?.choices[1] !== "restart" ? menu?.choices[1] : undefined;
  const button = (
    <button
      onClick={(event) => onSend(event.metaKey || event.ctrlKey)}
      disabled={disabled}
      aria-label={label}
      title={menu && alternate ? t("composer.followUp.buttonTitle", { title, key: menu.alternateKey, alternate: t(`composer.followUp.${alternate}`) }) : title}
      style={waits ? undefined : look.style}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full disabled:cursor-default",
        compact ? "size-7 animate-[slot-fade-in_120ms_ease-out]" : "size-8",
        waits ? "bg-raised text-ink-secondary hover:bg-raised-hover" : look.className,
      )}
    >
      {waits ? <Clock size={compact ? 14 : 15} /> : <ArrowUp size={16} strokeWidth={1.75} absoluteStrokeWidth />}
    </button>
  );
  if (!menu) return button;
  const items = menu.choices.map((choice, index): SidebarMenuItem => {
    const Icon = FOLLOW_UP_ICON[choice];
    return {
      key: choice,
      label: t(`composer.followUp.${choice}`),
      subtitle: t(`composer.followUp.${choice}Hint`, { name: menu.name }),
      icon: <Icon size={16} aria-hidden="true" />,
      active: index === 0,
      value: index === 0 ? menu.sendKey : choice === alternate ? menu.alternateKey : undefined,
      disabled,
      onSelect: () => onChoose(choice),
    };
  });
  return (
    <div data-composer-follow-up className="flex shrink-0 items-center">
      <SidebarPopoverMenu
        items={items}
        ariaLabel={t("composer.followUp.menu")}
        triggerTitle={t("composer.followUp.menu")}
        triggerClassName={cn(
          "flex shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink",
          compact ? "h-7 w-5" : "h-8 w-6",
        )}
        renderTrigger={() => <ChevronUp size={14} aria-hidden="true" />}
      />
      {button}
    </div>
  );
}
