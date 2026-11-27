import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, CalendarDays, Check, Columns3, Hash, ListFilter, Search, ToggleLeft, Type } from "lucide-react";
import type { DataColumn } from "../../../shared/data-surface";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { t } from "@/lib/i18n";
import { isNumericType, isTemporalType } from "./data-format";

export interface DataFilterValue { column?: string; text: string }

export function DataFilter({ columns, value, onChange }: { columns: DataColumn[]; value: DataFilterValue; onChange: (value: DataFilterValue) => void }) {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(true);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const active = Boolean(value.text.trim());
  const selected = value.column ?? t("data.filter.allColumns");
  const matches = columns.filter((column) => column.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  usePopoverDismiss(open, root, () => setOpen(false));
  useEffect(() => { if (open) input.current?.focus(); }, [open, choosing]);
  const choose = (column?: string) => { onChange({ ...value, column }); setChoosing(false); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    } else if (choosing && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-filter-option]")];
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
      event.preventDefault();
      if (next < 0) input.current?.focus();
      else options[Math.min(next, options.length - 1)]?.focus();
    }
  };
  return <div ref={root} className="relative min-w-0" onBlur={(event) => {
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-label={t("data.filter.button")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={active ? `${selected}: ${value.text}` : t("data.filter.button")} data-active={active}
      onClick={() => { setChoosing(!active); setSearch(""); setOpen(!open); }}
      className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${active ? "border-accent/40 bg-accent/10 text-accent" : "border-hairline/50 text-ink-secondary hover:bg-inset hover:text-ink"}`}>
      <ListFilter size={14} aria-hidden="true" /><span>{t("data.filter.button")}</span>
      {active && <span className="max-w-40 truncate text-[11px]">· {selected}</span>}
    </button>
    {open && <div id={id} role="dialog" aria-label={t("data.grid.filter")} data-testid="data-filter-popover" onKeyDown={onKeyDown}
      className="absolute left-0 top-full z-40 mt-1 flex max-h-[min(20rem,calc(100cqh-5.5rem))] w-64 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-hairline/60 bg-menu text-ink shadow-xl">
      {choosing ? <>
        <label className="flex shrink-0 items-center gap-2 border-b border-hairline/40 px-3 py-2 text-ink-secondary">
          <Search size={14} aria-hidden="true" />
          <input ref={input} value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t("data.filter.searchColumns")} placeholder={t("data.filter.searchColumns")}
            className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-tertiary" />
        </label>
        <div className="min-h-0 overflow-y-auto p-1">
          <button type="button" data-filter-option className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-inset focus-visible:bg-inset focus-visible:outline-none" onClick={() => choose()}>
            <Columns3 size={14} className="text-ink-tertiary" aria-hidden="true" /><span className="flex-1">{t("data.filter.allColumns")}</span>{value.column === undefined && <Check size={13} aria-hidden="true" />}
          </button>
          {matches.map((column) => {
            const Icon = isNumericType(column.type) ? Hash : isTemporalType(column.type) ? CalendarDays : /^BOOLEAN$/i.test(column.type) ? ToggleLeft : Type;
            return <button key={column.name} type="button" data-filter-option aria-label={column.name} title={`${column.name} · ${column.type}`} onClick={() => choose(column.name)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-inset focus-visible:bg-inset focus-visible:outline-none">
              <Icon size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{column.name}</span>{value.column === column.name && <Check size={13} aria-hidden="true" />}
            </button>;
          })}
          {matches.length === 0 && <p className="px-2 py-2 text-xs text-ink-tertiary">{t("data.filter.noColumns")}</p>}
        </div>
      </> : <>
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline/40 px-2 py-1.5">
          <button type="button" aria-label={t("data.filter.chooseColumn")} title={t("data.filter.chooseColumn")} className="rounded-md p-1 text-ink-secondary hover:bg-inset" onClick={() => { setChoosing(true); setSearch(""); }}><ArrowLeft size={14} aria-hidden="true" /></button>
          <span className="truncate text-xs" title={selected}>{selected}</span>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <label className="flex flex-col gap-1.5 text-[11px] text-ink-secondary">{t("data.filter.contains")}
            <input ref={input} value={value.text} onChange={(event) => onChange({ ...value, text: event.target.value })} aria-label={t("data.filter.value")} placeholder={t("data.filter.value")}
              className="w-full rounded-md border border-hairline/50 bg-inset px-2 py-1.5 text-xs text-ink outline-none focus-visible:ring-1 focus-visible:ring-accent" />
          </label>
          <button type="button" disabled={!value.text && value.column === undefined} className="mt-2 rounded-md px-1 py-1 text-xs text-ink-secondary hover:text-ink disabled:opacity-40" onClick={() => { onChange({ text: "" }); setChoosing(true); setSearch(""); }}>{t("data.filter.clear")}</button>
        </div>
      </>}
    </div>}
  </div>;
}
