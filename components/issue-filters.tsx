"use client";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import { Check, ChevronLeft, ChevronRight, CircleDot, Columns3, List, ListFilter, Search, SlidersHorizontal, Tag, UserRound, X } from "lucide-react";
import { DISPLAY_PROPERTIES, GROUPINGS, NO_LABEL, ORDERINGS, PRIORITY_ORDER, UNASSIGNED, activeFilterCount, toggleFilter, type FilterKey, type IssueFilters, type IssueViewState } from "@/lib/issue-view";
import { filterCommands } from "@/lib/command-menu";
import { useAnchoredPopover } from "./use-anchored-popover";
import { PriorityIcon, StatusIcon } from "./issue-icons";
import { UserAvatar } from "./user-avatar";
import { LabelDot } from "./issue-labels";
import { IssueSelect } from "./issue-select";

export type FilterOption = { value: string; label: string; icon: ReactNode };
export type FilterSources = { statuses: FilterOption[]; assignees: FilterOption[]; labels: FilterOption[] };
const CATEGORIES: { key: FilterKey; label: string; icon: ReactNode }[] = [
  { key: "statuses", label: "Status", icon: <CircleDot size={14} /> },
  { key: "priorities", label: "Priority", icon: <PriorityIcon priority="high" /> },
  { key: "assignees", label: "Assignee", icon: <UserRound size={14} /> },
  { key: "labels", label: "Labels", icon: <Tag size={14} /> },
];

/** Builds the filter choices from what the board shows: its lanes, the people on it and the workspace's labels. */
export function filterSources({ statuses, people, labels }: { statuses: { id: string; title: string }[]; people: { email: string; name?: string; avatarUrl?: string | null }[]; labels: { name: string; color: string }[] }): FilterSources {
  return {
    statuses: statuses.map(status => ({ value: status.id, label: status.title, icon: <StatusIcon title={status.title} /> })),
    assignees: [{ value: UNASSIGNED, label: "No assignee", icon: <span className="task-menu-no-assignee"><UserRound size={12} /></span> }, ...people.map(person => ({ value: person.email, label: person.name || person.email, icon: <UserAvatar user={person} size="small" /> }))],
    labels: [...labels.map(label => ({ value: label.name.toLowerCase(), label: label.name, icon: <LabelDot color={label.color} /> })), { value: NO_LABEL, label: "No labels", icon: <Tag size={13} /> }],
  };
}

const priorityOptions: FilterOption[] = PRIORITY_ORDER.map(priority => ({ value: priority, label: priority[0]!.toUpperCase() + priority.slice(1), icon: <PriorityIcon priority={priority} /> }));
const optionsFor = (key: FilterKey, sources: FilterSources) => key === "priorities" ? priorityOptions : sources[key];

function usePopover(width: number) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), focus = useRef<HTMLElement>(null);
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useAnchoredPopover(open, trigger, menu, focus, { width, maxHeight: 420, onDismiss: restore => close(restore) });
  return { open, setOpen, close, trigger, menu, focus };
}

/** Linear's Filter menu: pick a property, then tick values. Several values of one property match any of them. */
export function FilterMenu({ filters, sources, onChange }: { filters: IssueFilters; sources: FilterSources; onChange: (filters: IssueFilters) => void }) {
  const { open: shown, setOpen, close, trigger, menu, focus } = usePopover(260);
  const [category, setCategory] = useState<FilterKey | null>(null);
  const [query, setQuery] = useState("");
  const count = activeFilterCount(filters);
  const options = category ? filterCommands(optionsFor(category, sources), query) : filterCommands(CATEGORIES.map(item => ({ ...item, label: item.label })), query);
  const open = (next: FilterKey | null) => { setCategory(next); setQuery(""); requestAnimationFrame(() => menu.current?.querySelector<HTMLInputElement>("input")?.focus()); };
  const move = (event: ReactKeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitemcheckbox], [role=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (category) open(null); else close(); }
    else if (event.key === "ArrowLeft" && category && index >= 0) { event.preventDefault(); open(null); }
    else if (event.key === "Tab") setOpen(false);
  };
  return <div className="view-control">
    <button ref={trigger} type="button" className={clsx("ghost-button compact view-control-trigger", count > 0 && "is-active")} aria-haspopup="menu" aria-expanded={shown} title="Filter" onClick={() => { if (shown) close(false); else { setCategory(null); setQuery(""); setOpen(true); } }}>
      <ListFilter size={14} /><span>Filter</span>{count > 0 && <small>{count}</small>}
    </button>
    {shown && <div ref={menu} popover="manual" role="menu" aria-label="Filter issues" className="origin-dropdown view-popover filter-popover" onKeyDown={move}>
      <div className="issue-select-search">
        {category ? <button type="button" className="icon-button" aria-label="Back to filters" onClick={() => open(null)}><ChevronLeft size={14} /></button> : <Search size={14} />}
        <input ref={focus as RefObject<HTMLInputElement>} placeholder={category ? `Filter by ${CATEGORIES.find(item => item.key === category)!.label.toLowerCase()}…` : "Add filter…"} aria-label="Search filters" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); menu.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus(); } else if (event.key === "Enter") { event.preventDefault(); menu.current?.querySelector<HTMLElement>("[role^=menuitem]")?.click(); } }} />
      </div>
      <div className="view-popover-list">
        {category
          ? (options as FilterOption[]).map(option => {
            const checked = (filters[category] as string[]).includes(option.value);
            return <button key={`${option.value}:${option.label}`} type="button" role="menuitemcheckbox" aria-checked={checked} onClick={() => onChange(toggleFilter(filters, category, option.value))}>
              <span className={clsx("label-check", checked && "is-checked")} aria-hidden="true">{checked && <Check size={10} strokeWidth={3} />}</span>{option.icon}<span>{option.label}</span>
            </button>;
          })
          : (options as typeof CATEGORIES).map(item => <button key={item.key} type="button" role="menuitem" aria-haspopup="menu" onClick={() => open(item.key)}>
            {item.icon}<span>{item.label}</span>{(filters[item.key] as string[]).length > 0 && <small>{(filters[item.key] as string[]).length}</small>}<ChevronRight size={13} />
          </button>)}
        {!options.length && <p>No matches</p>}
      </div>
    </div>}
  </div>;
}

/** The active filters as removable chips under the toolbar ("Labels: Bug, Feature ×"). */
export function FilterChips({ filters, sources, onChange }: { filters: IssueFilters; sources: FilterSources; onChange: (filters: IssueFilters) => void }) {
  if (!activeFilterCount(filters)) return null;
  return <div className="filter-chips" aria-label="Active filters">
    {CATEGORIES.filter(item => (filters[item.key] as string[]).length).map(item => {
      const values = filters[item.key] as string[];
      const options = values.map(value => optionsFor(item.key, sources).find(option => option.value === value) ?? { value, label: value, icon: null });
      return <span key={item.key} className="filter-chip" data-filter={item.key}>
        {item.icon}<span><strong>{item.label}</strong> {values.length > 1 ? "is any of" : "is"} {item.key === "labels"
          ? options.map((option, index) => <span key={option.value} className="filter-chip-value">{index > 0 && ", "}{option.icon}{option.label}</span>)
          : options.map(option => option.label).join(", ")}</span>
        <button type="button" aria-label={`Remove ${item.label.toLowerCase()} filter`} onClick={() => onChange({ ...filters, [item.key]: [] })}><X size={12} /></button>
      </span>;
    })}
    <button type="button" className="filter-clear" onClick={() => onChange({ statuses: [], priorities: [], assignees: [], labels: [] })}>Clear</button>
  </div>;
}

/** Display options: layout, grouping and ordering, empty groups, sub-issues, and which properties rows and cards show. */
export function DisplayOptions({ view, onChange, archive }: { view: IssueViewState; onChange: (view: IssueViewState) => void; archive: boolean }) {
  const { open, setOpen, close, trigger, menu, focus } = usePopover(300);
  const set = (patch: Partial<IssueViewState>) => onChange({ ...view, ...patch });
  return <div className="view-control">
    <button ref={trigger} type="button" className="ghost-button compact view-control-trigger" aria-haspopup="dialog" aria-expanded={open} title="Display options" onClick={() => open ? close(false) : setOpen(true)}>
      <SlidersHorizontal size={14} /><span>Display</span>
    </button>
    {open && <div ref={menu} popover="manual" role="dialog" aria-label="Display options" className="origin-dropdown view-popover display-popover" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="display-layout" role="group" aria-label="Layout">
        <button ref={focus as RefObject<HTMLButtonElement>} type="button" aria-pressed={view.layout === "list"} disabled={archive} onClick={() => set({ layout: "list" })}><List size={14} />List</button>
        <button type="button" aria-pressed={view.layout === "board"} disabled={archive} onClick={() => set({ layout: "board" })}><Columns3 size={14} />Board</button>
      </div>
      <div className="display-row"><span>Grouping</span>{view.layout === "board" ? <span className="display-fixed">Status</span> : <IssueSelect label="Grouping" caption="Grouping" value={view.grouping} onChange={value => set({ grouping: value as IssueViewState["grouping"] })} options={GROUPINGS.map(option => ({ value: option.value, label: option.label }))} />}</div>
      <div className="display-row"><span>Ordering</span><IssueSelect label="Ordering" caption="Ordering" value={view.ordering} onChange={value => set({ ordering: value as IssueViewState["ordering"] })} options={ORDERINGS.map(option => ({ value: option.value, label: option.label }))} /></div>
      <label className="display-row display-switch"><span>{view.layout === "board" ? "Show empty columns" : "Show empty groups"}</span><input type="checkbox" role="switch" checked={view.showEmptyGroups} onChange={event => set({ showEmptyGroups: event.target.checked })} /></label>
      <label className="display-row display-switch"><span>Show sub-issues</span><input type="checkbox" role="switch" checked={view.showSubIssues} onChange={event => set({ showSubIssues: event.target.checked })} /></label>
      <div className="display-properties">
        <span>Display properties</span>
        <div>{DISPLAY_PROPERTIES.map(property => {
          const on = view.properties.includes(property.value);
          return <button key={property.value} type="button" aria-pressed={on} onClick={() => set({ properties: on ? view.properties.filter(item => item !== property.value) : [...view.properties, property.value] })}>{property.label}</button>;
        })}</div>
      </div>
    </div>}
  </div>;
}
