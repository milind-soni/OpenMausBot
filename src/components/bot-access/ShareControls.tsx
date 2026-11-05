import { AtSign, Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { TeamPerson } from "@/state/team-people";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";
import { PersonFace } from "../TeamOwner";

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

/** What can change for a person added: someone else looking after the bot, and taking their access away. */
export function PersonMenu({ disabled = false, label, onRemove, onMakeOwner, makeOwnerLabel }: {
  disabled?: boolean; label: string; onRemove: () => void; onMakeOwner?: () => void; makeOwnerLabel?: string;
}) {
  const items: SidebarMenuItem[] = [];
  if (onMakeOwner) items.push({ key: "owner", label: makeOwnerLabel ?? "", icon: gutter(false), disabled, onSelect: onMakeOwner });
  items.push({ key: "remove", label: t("botAccess.remove"), icon: gutter(false), separatorBefore: Boolean(onMakeOwner), disabled, onSelect: onRemove });
  return <QuietMenu label={label} shown={t("botAccess.added")} items={items} />;
}

/** A person's face, or a plain sign for an address nobody on the team has (an `@domain` entry). */
export function EntryFace({ person, size }: { person: TeamPerson | null; size: number }) {
  return person ? <PersonFace person={person} size={size} /> : (
    <span aria-hidden="true" style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-ink-secondary">
      <AtSign size={Math.round(size / 2)} />
    </span>
  );
}
