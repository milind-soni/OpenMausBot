"use client";
import { useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import { ArrowUpDown, Check, ChevronLeft, ChevronRight, CircleDot, Columns3, List, ListFilter, Rows3, Search, SlidersHorizontal, Tag, UserRound, X } from "lucide-react";
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

/** Lets a keyboard shortcut of the view (F, Shift+V) open a popover as its button would. */
export type PopoverOpener = { open: () => void };

/** Linear's Filter menu: pick a property, then tick values. Several values of one property match any of them. */
export function FilterMenu({ filters, sources, onChange, opener }: { filters: IssueFilters; sources: FilterSources; onChange: (filters: IssueFilters) => void; opener?: Ref<PopoverOpener> }) {
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
  useImperativeHandle(opener, () => ({ open: () => { setCategory(null); setQuery(""); setOpen(true); } }), [setOpen]);
  return <div className="view-control">
    <button ref={trigger} type="button" className={clsx("view-button view-control-trigger", count > 0 && "is-active")} aria-haspopup="menu" aria-expanded={shown} aria-keyshortcuts="F" title="Filter (F)" onClick={() => { if (shown) close(false); else { setCategory(null); setQuery(""); setOpen(true); } }}>
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

/**
 * The filter bar under the header, as Linear draws it: one formula chip per property ("Labels | is any of | Bug,
 * Feature | ×"), a button to add another, and how the filters combine on the right.
 */
export function FilterChips({ filters, sources, onChange, onAdd }: { filters: IssueFilters; sources: FilterSources; onChange: (filters: IssueFilters) => void; onAdd?: () => void }) {
  if (!activeFilterCount(filters)) return null;
  return <div className="filter-bar" role="group" aria-label="Active filters">
    <div className="filter-chips">
      {CATEGORIES.filter(item => (filters[item.key] as string[]).length).map(item => {
        const values = filters[item.key] as string[];
        const options = values.map(value => optionsFor(item.key, sources).find(option => option.value === value) ?? { value, label: value, icon: null });
        return <span key={item.key} className="filter-chip" data-filter={item.key}>
          <span className="filter-chip-part filter-chip-key">{item.icon}<strong>{item.label}</strong></span>
          <span className="filter-chip-part filter-chip-op">{values.length > 1 ? (item.key === "labels" ? "include any of" : "is any of") : (item.key === "labels" ? "include" : "is")}</span>
          <span className="filter-chip-part filter-chip-values">{values.length > 2
            ? <>{options.slice(0, 1).map(option => <span key={option.value} className="filter-chip-value">{option.icon}{option.label}</span>)}<span className="filter-chip-more">+{values.length - 1}</span></>
            : options.map((option, index) => <span key={option.value} className="filter-chip-value">{index > 0 && <span className="filter-chip-comma">, </span>}{option.icon}{option.label}</span>)}</span>
          <button type="button" className="filter-chip-remove" aria-label={`Remove ${item.label.toLowerCase()} filter`} onClick={() => onChange({ ...filters, [item.key]: [] })}><X size={12} /></button>
        </span>;
      })}
      {onAdd && <button type="button" className="icon-button filter-add" aria-label="Add filter" title="Add filter (F)" onClick={onAdd}><ListFilter size={14} /></button>}
    </div>
    <span className="filter-bar-mode">Match all filters</span>
    <button type="button" className="filter-clear" onClick={() => onChange({ statuses: [], priorities: [], assignees: [], labels: [] })}>Clear</button>
  </div>;
}

/**
 * Display options, after Linear's: List / Board tiles, grouping and ordering, then what shows (completed issues in All
 * issues, sub-issues, empty groups) and which properties rows and cards carry. Shift+V opens it.
 */
export function DisplayOptions({ view, onChange, archive, opener }: { view: IssueViewState; onChange: (view: IssueViewState) => void; archive: boolean; opener?: Ref<PopoverOpener> }) {
  const { open, setOpen, close, trigger, menu, focus } = usePopover(320);
  const set = (patch: Partial<IssueViewState>) => onChange({ ...view, ...patch });
  useImperativeHandle(opener, () => ({ open: () => setOpen(true) }), [setOpen]);
  const board = view.layout === "board";
  return <div className="view-control">
    <button ref={trigger} type="button" className="view-button view-control-trigger" aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Shift+V" title="Display options (Shift V)" onClick={() => open ? close(false) : setOpen(true)}>
      <SlidersHorizontal size={14} /><span>Display</span>
    </button>
    {open && <div ref={menu} popover="manual" role="dialog" aria-label="Display options" className="origin-dropdown view-popover display-popover" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="display-section">
        <div className="display-layout" role="group" aria-label="Layout">
          <button ref={focus as RefObject<HTMLButtonElement>} type="button" aria-pressed={view.layout === "list"} disabled={archive} onClick={() => set({ layout: "list" })}><List size={16} /><span>List</span></button>
          <button type="button" aria-pressed={board} disabled={archive} onClick={() => set({ layout: "board" })}><Columns3 size={16} /><span>Board</span></button>
        </div>
        <div className="display-row"><span className="display-label"><Rows3 size={14} />{board ? "Columns" : "Grouping"}</span>{board ? <span className="display-fixed">Status</span> : <IssueSelect label="Grouping" caption="Grouping" value={view.grouping} onChange={value => set({ grouping: value as IssueViewState["grouping"] })} options={GROUPINGS.map(option => ({ value: option.value, label: option.label }))} />}</div>
        <div className="display-row"><span className="display-label"><ArrowUpDown size={14} />Ordering</span><IssueSelect label="Ordering" caption="Ordering" value={view.ordering} onChange={value => set({ ordering: value as IssueViewState["ordering"] })} options={ORDERINGS.map(option => ({ value: option.value, label: option.label }))} /></div>
      </div>
      <div className="display-section">
        {view.tab === "all" && <Switch label="Show completed issues" checked={view.showCompleted} onChange={showCompleted => set({ showCompleted })} />}
        <Switch label="Show sub-issues" checked={view.showSubIssues} onChange={showSubIssues => set({ showSubIssues })} />
        <Switch label={board ? "Show empty columns" : "Show empty groups"} checked={view.showEmptyGroups} onChange={showEmptyGroups => set({ showEmptyGroups })} />
      </div>
      <div className="display-section display-properties">
        <span>Display properties</span>
        <div>{DISPLAY_PROPERTIES.map(property => {
          const on = view.properties.includes(property.value);
          return <button key={property.value} type="button" aria-pressed={on} onClick={() => set({ properties: on ? view.properties.filter(item => item !== property.value) : [...view.properties, property.value] })}>{property.label}</button>;
        })}</div>
      </div>
    </div>}
  </div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="display-row display-switch"><span>{label}</span><input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} /></label>;
}
