import { AtSign, Check, ChevronDown } from "lucide-react";

import { atLeast, GRANTED_LEVELS, type BotAccessLevel, type GrantedLevel } from "../../../shared/bot-access";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { TeamPerson } from "@/state/team-people";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";
import { PersonFace } from "../TeamOwner";
import { levelHint, levelLabel } from "./access";

const gutter = (checked: boolean) => (checked ? <Check size={14} aria-hidden="true" /> : <span aria-hidden="true" />);

/** A choice shown as plain text with a chevron until it is opened. */
export function QuietMenu({ label, shown, items, align = "end", className }: {
  label: string; shown: string; items: SidebarMenuItem[]; align?: "start" | "end"; className?: string;
}) {
  return (
    <SidebarPopoverMenu items={items} ariaLabel={label} align={align}
      triggerClassName={cn("flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-[13px] leading-[18px] hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.06]", className ?? "text-ink-secondary hover:text-ink")}
      renderTrigger={() => <><span className="truncate">{shown}</span><ChevronDown size={14} aria-hidden="true" className="shrink-0 opacity-70" /></>} />
  );
}

export const choiceItem = (key: string, name: string, chosen: boolean, onSelect: () => void, more: Partial<SidebarMenuItem> = {}): SidebarMenuItem =>
  ({ key, label: name, checked: chosen, icon: gutter(chosen), onSelect, ...more });

/** A level to choose, each with what it allows; what everyone already gets is the lowest on offer. `onChange(null)` takes
 * the person's own access away, offered only when `removable`. */
export function LevelMenu({ value, floor = "none", removable = false, disabled = false, label, onChange, onMakeOwner }: {
  value: GrantedLevel; floor?: BotAccessLevel; removable?: boolean; disabled?: boolean; label: string;
  onChange: (level: GrantedLevel | null) => void; onMakeOwner?: () => void;
}) {
  const shown = atLeast(value, floor) ? value : (floor as GrantedLevel);
  const items: SidebarMenuItem[] = GRANTED_LEVELS.map((level) => choiceItem(level, levelLabel(level), level === shown,
    () => { if (level !== shown) onChange(level); }, { subtitle: levelHint(level), disabled: disabled || !atLeast(level, floor) }));
  if (onMakeOwner) items.push({ key: "owner", label: t("botAccess.makeOwner"), icon: gutter(false), separatorBefore: true, disabled, onSelect: onMakeOwner });
  if (removable) items.push({ key: "remove", label: t("botAccess.remove"), icon: gutter(false), separatorBefore: !onMakeOwner, disabled, onSelect: () => onChange(null) });
  return <QuietMenu label={label} shown={levelLabel(shown)} items={items} />;
}

/** A person's face, or a plain sign for an address nobody on the team has (an `@domain` entry). */
export function EntryFace({ person, size }: { person: TeamPerson | null; size: number }) {
  return person ? <PersonFace person={person} size={size} /> : (
    <span aria-hidden="true" style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-ink-secondary">
      <AtSign size={Math.round(size / 2)} />
    </span>
  );
}
