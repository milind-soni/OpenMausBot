"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Search, Users, UserRound } from "lucide-react";
import { displayName } from "@/lib/format";
import { UserAvatar, type AvatarIdentity } from "./user-avatar";
import { shouldFocusSearch, useAnchoredPopover } from "./use-anchored-popover";
import { SheetHeader } from "./sheet-header";

type Person = AvatarIdentity & { email: string };
type Option = { value: string; label: string; detail?: string; person?: Person; kind: "all" | "none" | "person" };

const SEARCH_THRESHOLD = 7;

/**
 * Picks a project member by email. Names are shown in full; the current user comes first, marked "You". `allLabel` adds an "everyone" option (filters), `noneLabel` an empty option (unassigned).
 */
export function MemberPicker({ members, value, onChange, label, disabled, allLabel, noneLabel, currentEmail, placeholder, caption }: {
  members: Person[]; value: string; onChange: (value: string) => void; label: string;
  disabled?: boolean; allLabel?: string; noneLabel?: string; currentEmail?: string; placeholder?: string;
  /** Title of the phone sheet. */
  caption?: string;
  /** @deprecated Assignees are optional; kept so older callers still type-check. */
  required?: boolean;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0), [focusSearch, setFocusSearch] = useState(false);
  const selected = members.find(member => member.email === value);
  const selectedLabel = selected ? displayName(selected) : value ? displayName({ email: value }) : allLabel || placeholder || label;
  // The accessible name says the empty value ("Unassigned") when the chip only shows its own label (the composer's
  // "Assignee" placeholder), as the issue view does.
  const accessibleValue = value || allLabel || (placeholder && placeholder !== label) ? selectedLabel : noneLabel || "none";
  const ordered = [...members].sort((a, b) => Number(b.email === currentEmail) - Number(a.email === currentEmail));
  const needle = query.trim().toLowerCase();
  const people = ordered.filter(member => !needle || `${displayName(member)} ${member.username || ""} ${member.email} ${member.email === currentEmail ? "you me" : ""}`.toLowerCase().includes(needle));
  const options: Option[] = [
    ...(allLabel && !needle ? [{ value: "", label: allLabel, kind: "all" as const }] : []),
    ...(noneLabel && !allLabel && !needle ? [{ value: "", label: noneLabel, kind: "none" as const }] : []),
    // Same row everywhere (the board's card menu too): the full name, with "You" as the only secondary text.
    ...people.map(person => ({ value: person.email, label: displayName(person), detail: person.email === currentEmail ? "You" : undefined, person, kind: "person" as const })),
  ];
  const searchable = members.length + (allLabel || noneLabel ? 1 : 0) > SEARCH_THRESHOLD;
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const choose = (option: Option) => { if (option.value !== value) onChange(option.value); close(); };
  const show = () => { setQuery(""); setActive(Math.max(0, options.findIndex(option => option.value === value))); setFocusSearch(searchable && shouldFocusSearch(members.length)); setOpen(true); };
  useAnchoredPopover(open, trigger, menu, focusSearch ? search : list, { width: 260, onDismiss: close });
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, id, open]);
  return <div className="member-picker" onKeyDown={event => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(index => event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, options.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length));
    }
    else if (event.key === "Enter" || (event.key === " " && event.target !== search.current)) { event.preventDefault(); const option = options[active]; if (option) choose(option); }
    else if (event.key === "Tab") close();
  }}>
    <button ref={trigger} type="button" className="member-picker-trigger" data-empty={!value || undefined} aria-label={`${label}: ${accessibleValue}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => { if (open) close(false); else show(); }} onKeyDown={event => {
      if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); show(); }
    }}>
      {selected ? <UserAvatar user={selected} size="small" /> : allLabel && !value ? <Users size={14} /> : <UserRound size={14} />}
      <span>{selectedLabel}</span><ChevronDown size={12} />
    </button>
    {open && <div ref={menu} popover="manual" className="member-picker-popover">
      <SheetHeader caption={caption} />
      {searchable && <div className="member-picker-search"><Search size={14} /><input ref={search} aria-label={`Search ${label.toLowerCase()}`} placeholder="Search..." role="combobox" aria-expanded="true" aria-controls={id} aria-activedescendant={options[active] ? `${id}-${active}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} /></div>}
      <div ref={list} tabIndex={-1} role="listbox" id={id} aria-label={label} aria-activedescendant={options[active] ? `${id}-${active}` : undefined}>{options.map((option, index) => <button id={`${id}-${index}`} key={`${option.kind}:${option.value}`} type="button" tabIndex={-1} role="option" aria-selected={value === option.value} data-highlighted={active === index} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
        {option.person ? <UserAvatar user={option.person} size="small" /> : option.kind === "all" ? <Users size={16} /> : <span className="avatar-empty" aria-hidden="true"><UserRound size={12} /></span>}<span>{option.label}</span>{option.detail && <small>{option.detail}</small>}{value === option.value && <Check size={14} />}
      </button>)}{!options.length && <p>No members found</p>}</div>
    </div>}
  </div>;
}
