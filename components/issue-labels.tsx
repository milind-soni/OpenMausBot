"use client";
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import { Check, Plus, Tag } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { MAX_LABEL_LENGTH, colorForLabel } from "@/convex/lib/labels";
import { filterCommands } from "@/lib/command-menu";
import { useAnchoredPopover } from "./use-anchored-popover";

export type WorkspaceLabel = FunctionReturnType<typeof api.labels.list>["labels"][number];
export type WorkspaceLabels = FunctionReturnType<typeof api.labels.list>;

/** The workspace's labels, loaded once by the workspace shell for every picker, row and filter. */
export const WorkspaceLabelsContext = createContext<WorkspaceLabels | undefined>(undefined);
export const useWorkspaceLabels = () => useContext(WorkspaceLabelsContext);

/** Color for a label name: the registry's, else the color it will get once registered. */
export function useLabelColors() {
  const labels = useWorkspaceLabels();
  return useMemo(() => {
    const colors = new Map((labels?.labels ?? []).map(label => [label.name.toLowerCase(), label.color]));
    return (name: string) => colors.get(name.toLowerCase()) ?? colorForLabel(name);
  }, [labels]);
}

export function LabelDot({ color }: { color: string }) {
  return <span className="label-dot" style={{ background: color }} aria-hidden="true" />;
}

/** The label color as a CSS variable; chips tint their background, border and text from it. */
export const labelStyle = (color: string) => ({ "--label": color }) as CSSProperties;

/** Colored chips: a dot plus the name on a tint of the label's color; `max` folds the rest into "+n". */
export function LabelChips({ labels, max = 3, className }: { labels?: readonly string[]; max?: number; className?: string }) {
  const color = useLabelColors();
  if (!labels?.length) return null;
  const rest = labels.length - max;
  return <span className={clsx("label-chips", className)} aria-label={`Labels: ${labels.join(", ")}`}>
    {labels.slice(0, max).map(label => <span key={label} className="label-chip" style={labelStyle(color(label))} aria-hidden="true"><LabelDot color={color(label)} /><span>{label}</span></span>)}
    {rest > 0 && <span className="label-chip label-chip-more" aria-hidden="true">+{rest}</span>}
  </span>;
}

/** Labels offered as one-press toggles above the label list: the kinds of work most issues are. */
export const QUICK_LABELS = ["Bug", "Feature", "Improvement"] as const;

type Row = { kind: "label"; name: string; color: string; group?: string; section: string } | { kind: "create"; name: string; section: string };

/**
 * Searchable multi-select over the workspace's labels, as in Linear: applied labels first, then suggestions (from the
 * issue text), then the rest of the workspace; typing a new name offers to create it. Enter toggles, Escape closes.
 */
export function LabelList({ selected, onToggle, suggestions = [], canCreate = true, onEscape, autoFocus = true, shortcut, inputRef }: {
  selected: readonly string[];
  onToggle: (name: string) => void;
  suggestions?: readonly string[];
  canCreate?: boolean;
  onEscape?: () => void;
  autoFocus?: boolean;
  /** Key shown in the search field ("L"). */
  shortcut?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const workspace = useWorkspaceLabels();
  const color = useLabelColors();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const groups = new Map((workspace?.groups ?? []).map(group => [group._id as string, group.name]));
  const chosen = new Set(selected.map(name => name.toLowerCase()));
  const available = (workspace?.labels ?? []).filter(label => !label.archived);
  const known = new Set(available.map(label => label.name.toLowerCase()));
  const all: { name: string; color: string; section: string; group?: string }[] = [
    ...selected.map(name => ({ name, color: color(name), section: "" })),
    ...suggestions.filter(name => !chosen.has(name.toLowerCase())).map(name => ({ name: available.find(label => label.name.toLowerCase() === name.toLowerCase())?.name ?? name, color: color(name), section: "Suggestions" })),
    ...available.filter(label => !chosen.has(label.name.toLowerCase()) && !suggestions.some(name => name.toLowerCase() === label.name.toLowerCase()))
      .map(label => ({ name: label.name, color: label.color, group: label.groupId ? groups.get(label.groupId) : undefined, section: "Workspace labels" })),
  ];
  const trimmed = query.trim().replace(/\s+/g, " ");
  const matches: Row[] = filterCommands(all.map(row => ({ ...row, label: row.name, keywords: row.group })), trimmed).map(row => ({ kind: "label" as const, ...row, section: trimmed ? "" : row.section }));
  if (canCreate && trimmed && trimmed.length <= MAX_LABEL_LENGTH && !known.has(trimmed.toLowerCase()) && !chosen.has(trimmed.toLowerCase())) matches.push({ kind: "create", name: trimmed, section: "" });
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const quick = trimmed ? [] : QUICK_LABELS.map(name => available.find(label => label.name.toLowerCase() === name.toLowerCase())).filter(label => label !== undefined);
  const choose = (row: Row | undefined) => {
    if (!row) return;
    onToggle(row.name);
    if (row.kind === "create") { setQuery(""); setActive(0); }
  };
  return <div className="label-list">
    <div className="issue-select-search">
      <Tag size={14} />
      <input ref={inputRef} autoFocus={autoFocus} data-initial-focus role="combobox" aria-expanded="true" aria-controls={id} aria-activedescendant={matches[current] ? `${id}-${current}` : undefined} aria-label="Change or add labels" placeholder="Change or add labels…" value={query} maxLength={MAX_LABEL_LENGTH + 8}
        onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!matches.length) return;
            const next = (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            setActive(next);
            list.current?.querySelector(`#${CSS.escape(`${id}-${next}`)}`)?.scrollIntoView({ block: "nearest" });
          } else if (event.key === "Enter") { event.preventDefault(); choose(matches[current]); }
          else if (event.key === "Escape" && onEscape) { event.preventDefault(); event.stopPropagation(); onEscape(); }
        }} />
      {shortcut && <kbd className="shortcut-key">{shortcut}</kbd>}
    </div>
    {quick.length > 0 && <div className="label-quick" role="group" aria-label="Type">
      {quick.map(label => {
        const on = chosen.has(label.name.toLowerCase());
        return <button key={label.name} type="button" tabIndex={-1} className="label-quick-chip" style={labelStyle(label.color)} aria-pressed={on} onMouseDown={event => event.preventDefault()} onClick={() => onToggle(label.name)}>
          <LabelDot color={label.color} /><span>{label.name}</span>{on && <Check size={11} strokeWidth={2.5} aria-hidden="true" />}
        </button>;
      })}
    </div>}
    <div ref={list} role="listbox" id={id} aria-multiselectable="true" aria-label="Labels" className="label-list-options">
      {matches.map((row, index) => <LabelOption key={`${row.kind}:${row.name}`} id={`${id}-${index}`} row={row} heading={row.section && row.section !== matches[index - 1]?.section ? row.section : undefined}
        checked={row.kind === "label" && chosen.has(row.name.toLowerCase())} highlighted={index === current} onHover={() => setActive(index)} onChoose={() => choose(row)} />)}
      {!matches.length && <p>{workspace ? "No labels" : "Loading labels…"}</p>}
    </div>
  </div>;
}

function LabelOption({ id, row, heading, checked, highlighted, onHover, onChoose }: { id: string; row: Row; heading?: string; checked: boolean; highlighted: boolean; onHover: () => void; onChoose: () => void }) {
  return <>
    {heading && <div className="label-list-heading" role="presentation">{heading}</div>}
    <button id={id} type="button" tabIndex={-1} role="option" aria-selected={checked} data-highlighted={highlighted} onMouseEnter={onHover} onMouseDown={event => event.preventDefault()} onClick={onChoose}>
      {row.kind === "create"
        ? <><Plus size={14} /><span>Create label “{row.name}”</span></>
        : <><span className={clsx("label-check", checked && "is-checked")} aria-hidden="true">{checked && <Check size={10} strokeWidth={3} />}</span><LabelDot color={row.color} /><span>{row.name}</span>{row.group && <small>{row.group}</small>}</>}
    </button>
  </>;
}

/** A trigger plus the label list in a popover (a bottom sheet on phones). */
export function LabelPicker({ value, onChange, suggestions, disabled, trigger, className }: {
  value: readonly string[];
  onChange: (labels: string[]) => void;
  suggestions?: readonly string[];
  disabled?: boolean;
  /** Renders the trigger's content; the picker supplies the button. */
  trigger: (open: boolean) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), focus = useRef<HTMLInputElement>(null);
  const close = (restore = true) => { setOpen(false); if (restore) button.current?.focus({ preventScroll: true }); };
  useAnchoredPopover(open, button, menu, focus, { width: 260, maxHeight: 360, onDismiss: restore => close(restore) });
  const toggle = (name: string) => {
    const lower = name.toLowerCase();
    onChange(value.some(label => label.toLowerCase() === lower) ? value.filter(label => label.toLowerCase() !== lower) : [...value, name]);
  };
  return <div className={clsx("label-picker", className)}>
    <button ref={button} type="button" className="label-picker-trigger" aria-label={value.length ? `Labels: ${value.join(", ")}` : "Add labels"} aria-haspopup="listbox" aria-expanded={open} aria-keyshortcuts="L" disabled={disabled} onClick={() => open ? close(false) : setOpen(true)} onKeyDown={event => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}>
      {trigger(open)}
    </button>
    {open && <div ref={menu} popover="manual" className="issue-select-popover label-picker-popover" onKeyDown={event => { if (event.key === "Tab") setOpen(false); }}>
      <LabelList selected={value} onToggle={toggle} suggestions={suggestions} onEscape={() => close()} shortcut="L" autoFocus={false} inputRef={focus} />
    </div>}
  </div>;
}


/**
 * The label list in a popover anchored to an element that is already on screen (a card's label chips or the card).
 * Toggles apply at once; Escape, Tab or a press outside closes it.
 */
export function LabelPopover({ anchor, value, onChange, suggestions, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  value: readonly string[];
  onChange: (labels: string[]) => void;
  suggestions?: readonly string[];
  onClose: (restoreFocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), focus = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useAnchoredPopover(true, anchor, menu, focus, { width: 260, maxHeight: 380, onDismiss: restore => closeRef.current(restore) });
  const toggle = (name: string) => {
    const lower = name.toLowerCase();
    onChange(value.some(label => label.toLowerCase() === lower) ? value.filter(label => label.toLowerCase() !== lower) : [...value, name]);
  };
  return <div ref={menu} popover="manual" className="issue-select-popover label-picker-popover" onKeyDown={event => { if (event.key === "Tab") { event.preventDefault(); onClose(true); } }}>
    <LabelList selected={value} onToggle={toggle} suggestions={suggestions} onEscape={() => onClose(true)} shortcut="L" autoFocus={false} inputRef={focus} />
  </div>;
}
