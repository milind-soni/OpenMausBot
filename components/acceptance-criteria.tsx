"use client";
import { useRef, useState, type CSSProperties } from "react";
import { useMutation } from "convex/react";
import { ChevronDown, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { MAX_CRITERION_LENGTH, type Criterion } from "@/lib/acceptance-criteria";

type Props = { projectId: Id<"projects">; taskId: Id<"tasks">; sessionToken: string; canEdit: boolean; items: readonly Criterion[] };
type Edit = { index: number; match: string; text?: string; checked?: boolean; remove?: boolean };

/**
 * The issue's acceptance criteria under its description: a checklist with progress, editable in place. Edits name the
 * item by index and text, so a change an agent made meanwhile fails instead of hitting the wrong item.
 */
export function AcceptanceCriteria({ projectId, taskId, sessionToken, canEdit, items }: Props) {
  const update = useMutation(api.tasks.updateAcceptanceCriteria).withOptimisticUpdate((store, args) => {
    const scope = { projectId, sessionToken, taskId };
    const details = store.getQuery(api.tasks.details, scope);
    if (!details || !args.edits) return;
    const removed = new Set(args.edits.filter(edit => edit.remove).map(edit => edit.index));
    const criteria = (details.task.acceptanceCriteria ?? []).map((item, index) => {
      const edit = args.edits!.find(change => change.index === index);
      return edit ? { text: edit.text ?? item.text, checked: edit.checked ?? item.checked } : item;
    }).filter((_, index) => !removed.has(index));
    store.setQuery(api.tasks.details, scope, { ...details, task: { ...details.task, acceptanceCriteria: criteria } });
  });
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);

  const run = async (call: () => Promise<unknown>, fallback: string) => {
    setError("");
    try { await call(); return true; } catch (cause) { setError(errorText(cause, fallback)); return false; }
  };
  const edit = (change: Edit) => run(() => update({ projectId, sessionToken, taskId, edits: [change] }), "Could not update acceptance criteria");
  const add = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    if (await run(() => update({ projectId, sessionToken, taskId, add: [draft] }), "Could not add acceptance criterion")) setDraft("");
    setBusy(false);
  };
  const saveEdit = () => {
    if (!editing) return;
    const item = items[editing.index];
    setEditing(null);
    if (item && editing.text.trim() && editing.text.trim() !== item.text) void edit({ index: editing.index, match: item.text, text: editing.text });
  };
  const stopAdding = () => { setAdding(false); setDraft(""); requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true })); };

  if (!items.length && !canEdit) return null;
  const done = items.filter(item => item.checked).length;
  return <section className="sub-issues acceptance-criteria" aria-label="Acceptance criteria">
    {items.length > 0 ? <header className="sub-issues-head">
      <button type="button" className="sub-issues-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>Acceptance criteria</span></button>
      <span className="sub-issues-progress" aria-label={`${done} of ${items.length} met`}><span className="sub-issues-ring" style={{ "--progress": `${Math.round((done / items.length) * 100)}%` } as CSSProperties} />{done}/{items.length}</span>
      {canEdit && <button type="button" className="icon-button" aria-label="Add acceptance criterion" title="Add acceptance criterion" onClick={() => { setOpen(true); setAdding(true); }}><Plus size={14} /></button>}
    </header> : !adding && <button ref={addButton} type="button" className="issue-add-row" onClick={() => setAdding(true)}><Plus size={14} />Add acceptance criteria</button>}
    {open && items.length > 0 && <ul className="sub-issue-list criteria-list">{items.map((item, index) => <li key={`${index}:${item.text}`} className="criterion-row">
      <input type="checkbox" checked={item.checked} disabled={!canEdit} aria-label={item.text} onChange={event => void edit({ index, match: item.text, checked: event.target.checked })} />
      {editing?.index === index
        ? <input className="criterion-input" autoFocus aria-label="Acceptance criterion" maxLength={MAX_CRITERION_LENGTH} value={editing.text} onChange={event => setEditing({ index, text: event.target.value })} onBlur={saveEdit}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); saveEdit(); }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
          }} />
        : canEdit
          ? <button type="button" className={item.checked ? "criterion-text is-done" : "criterion-text"} title="Edit" onClick={() => setEditing({ index, text: item.text })}>{item.text}</button>
          : <span className={item.checked ? "criterion-text is-done" : "criterion-text"}>{item.text}</span>}
      {canEdit && editing?.index !== index && <button type="button" className="icon-button criterion-remove" aria-label={`Remove ${item.text}`} title="Remove" onClick={() => void edit({ index, match: item.text, remove: true })}><X size={14} /></button>}
    </li>)}</ul>}
    {adding && <form className="sub-issue-add" onSubmit={event => { event.preventDefault(); void add(); }}>
      {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
      <input autoFocus aria-label="Acceptance criterion" placeholder="Acceptance criterion" maxLength={MAX_CRITERION_LENGTH} value={draft} readOnly={busy} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stopAdding(); } }}
        onBlur={() => { if (!draft.trim() && !busy) setAdding(false); }} />
      <button type="submit" className="ghost-button compact" disabled={!draft.trim() || busy}>Add</button>
    </form>}
    {error && <p className="issue-field-error" role="alert">{error}</p>}
  </section>;
}
