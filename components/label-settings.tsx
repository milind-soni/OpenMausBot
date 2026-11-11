"use client";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Archive, ArchiveRestore, Loader2, PencilLine, Plus, Search } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LABEL_COLORS, MAX_LABEL_DESCRIPTION, MAX_LABEL_LENGTH, colorForLabel } from "@/convex/lib/labels";
import { errorText } from "@/lib/error-text";
import { formatRelative } from "@/lib/format";
import { useWorkspace } from "./workspace-context";
import { LabelDot, type WorkspaceLabel } from "./issue-labels";
import { FormStatus, type FormNotice } from "./settings-controls";

type Draft = { mode: "label"; label: WorkspaceLabel | null; name: string; color: string; description: string; groupId: string } | { mode: "group"; name: string };

/** Settings › Labels: the workspace's issue labels with color, group, description and usage; create, edit, archive. */
export function LabelSettings({ sessionToken }: { sessionToken: string }) {
  const workspace = useWorkspace();
  const data = useQuery(api.labels.list, { sessionToken, teamId: workspace._id });
  const usage = useQuery(api.labels.usage, { sessionToken, teamId: workspace._id });
  const create = useMutation(api.labels.create), update = useMutation(api.labels.update);
  const createGroup = useMutation(api.labels.createGroup), updateGroup = useMutation(api.labels.updateGroup);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<FormNotice>(null);
  const editable = workspace.role !== "viewer";
  const counts = new Map((usage ?? []).map(row => [row.key, row]));
  const attempt = async (run: () => Promise<unknown>, fallback: string, done?: string) => {
    setBusy(true); setNotice(null);
    try { await run(); setDraft(null); if (done) setNotice({ tone: "success", text: done }); }
    catch (error) { setNotice({ tone: "danger", text: errorText(error, fallback) }); }
    finally { setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy || !draft.name.trim()) return;
    if (draft.mode === "group") { void attempt(() => createGroup({ sessionToken, teamId: workspace._id, name: draft.name }), "Could not create group"); return; }
    const groupId = (draft.groupId || undefined) as Id<"issueLabelGroups"> | undefined;
    void attempt(() => draft.label
      ? update({ sessionToken, teamId: workspace._id, labelId: draft.label._id, currentName: draft.label.name, name: draft.name, color: draft.color, description: draft.description, groupId: groupId ?? null })
      : create({ sessionToken, teamId: workspace._id, name: draft.name, color: draft.color, description: draft.description, ...(groupId ? { groupId } : {}) }), "Could not save label");
  };
  const edit = (label: WorkspaceLabel | null) => setDraft({ mode: "label", label, name: label?.name ?? "", color: label?.color ?? LABEL_COLORS[1], description: label?.description ?? "", groupId: label?.groupId ?? "" });
  const matches = (data?.labels ?? []).filter(label => label.name.toLowerCase().includes(query.trim().toLowerCase()));
  const sections = [
    ...(data?.groups ?? []).map(group => ({ id: group._id as string, name: group.name, labels: matches.filter(label => label.groupId === group._id && !label.archived) })),
    { id: "", name: "", labels: matches.filter(label => !label.groupId && !label.archived) },
    { id: "archived", name: "Archived", labels: matches.filter(label => label.archived) },
  ].filter(section => section.labels.length || (section.id && section.id !== "archived" && !query));

  return <section className="settings-group labels-settings">
    <div className="labels-settings-head">
      <label className="shortcuts-search labels-filter"><Search size={14} /><input placeholder="Filter by name…" aria-label="Filter labels by name" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {editable && <button type="button" className="ghost-button compact" onClick={() => setDraft({ mode: "group", name: "" })}>New group</button>}
      {editable && <button type="button" className="primary-button compact" onClick={() => edit(null)}><Plus size={14} />New label</button>}
    </div>
    {draft && <form className="label-editor" onSubmit={save} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(null); } }}>
      {draft.mode === "group"
        ? <div className="label-editor-row"><label>Group name<input autoFocus value={draft.name} maxLength={MAX_LABEL_LENGTH} placeholder="Area, Type, Platform…" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label></div>
        : <>
          <div className="label-editor-row">
            <label>Name<input autoFocus value={draft.name} maxLength={MAX_LABEL_LENGTH} placeholder="Label name" onChange={event => setDraft({ ...draft, name: event.target.value, ...(draft.label ? {} : { color: draft.name ? draft.color : colorForLabel(event.target.value) }) })} /></label>
            <label>Group<select value={draft.groupId} onChange={event => setDraft({ ...draft, groupId: event.target.value })}><option value="">No group</option>{data?.groups.map(group => <option key={group._id} value={group._id}>{group.name}</option>)}</select></label>
          </div>
          <label className="label-editor-row"><span className="sr-only">Description</span><input value={draft.description} maxLength={MAX_LABEL_DESCRIPTION} placeholder="Description (optional)" aria-label="Description" onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
          <div className="label-colors" role="radiogroup" aria-label="Color">{LABEL_COLORS.map(color => <button key={color} type="button" role="radio" aria-checked={draft.color === color} aria-label={color} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}</div>
        </>}
      <div className="label-editor-actions">
        <button type="button" className="ghost-button compact" onClick={() => setDraft(null)}>Cancel</button>
        <button type="submit" className="primary-button compact" disabled={busy || !draft.name.trim()}>{busy && <Loader2 size={14} className="spin" />}{draft.mode === "group" ? "Create group" : draft.label ? "Save label" : "Create label"}</button>
      </div>
    </form>}
    <FormStatus notice={notice} />
    {data === undefined ? <p className="muted">Loading labels…</p> : <table className="labels-table">
      <thead><tr><th scope="col">Name</th><th scope="col">Description</th><th scope="col">Issues</th><th scope="col">Last applied</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      {sections.map(section => <tbody key={section.id || "ungrouped"}>
        {section.name && <tr className="label-group-row"><td colSpan={4}>{section.name}</td><td className="labels-actions">{editable && section.id !== "archived" && <button type="button" className="icon-button" aria-label={`Archive group ${section.name}`} title="Archive group (keeps its labels)" onClick={() => void attempt(() => updateGroup({ sessionToken, teamId: workspace._id, groupId: section.id as Id<"issueLabelGroups">, archived: true }), "Could not archive group")}><Archive size={14} /></button>}</td></tr>}
        {section.labels.map(label => {
          const used = counts.get(label.name.toLowerCase());
          return <tr key={label._id ?? label.name} className={label.archived ? "is-archived" : undefined}>
            <td><span className="label-name-cell"><LabelDot color={label.color} />{label.name}</span></td>
            <td>{label.description}</td>
            <td className="labels-count">{used?.count ?? 0}</td>
            <td>{used ? formatRelative(used.lastUsedAt) : ""}</td>
            <td className="labels-actions">{editable && <>
              {!label.archived && <button type="button" className="icon-button" aria-label={`Edit ${label.name}`} title="Edit" onClick={() => edit(label)}><PencilLine size={14} /></button>}
              <button type="button" className="icon-button" aria-label={`${label.archived ? "Restore" : "Archive"} ${label.name}`} title={label.archived ? "Restore" : "Archive (issues keep it)"} disabled={busy} onClick={() => void attempt(() => update({ sessionToken, teamId: workspace._id, labelId: label._id, currentName: label.name, archived: !label.archived }), "Could not update label")}>{label.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>
            </>}</td>
          </tr>;
        })}
        {!section.labels.length && <tr><td colSpan={5} className="muted">No labels in this group</td></tr>}
      </tbody>)}
    </table>}
  </section>;
}
