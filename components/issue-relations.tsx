"use client";
import { errorText } from "@/lib/error-text";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, Circle, Link2, Plus, Tag, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LinkIssuePicker, type RelationKind } from "./feature-issue-picker";
import { LabelDot, LabelPicker, useLabelColors } from "./issue-labels";

/** Related issues, listed only when there are some, plus one quiet "Link issue" entry that opens the picker. */
export function IssueRelations({ sessionToken, projectId, taskId, canEdit, onOpen, hideSubIssues = false }: { sessionToken: string; projectId: Id<"projects">; taskId: Id<"tasks">; canEdit: boolean; onOpen: (projectId: Id<"projects">, taskId: Id<"tasks">) => void; /** The issue page lists sub-issues in their own section. */ hideSubIssues?: boolean }) {
  const data = useQuery(api.issueRelations.list, { sessionToken, taskId });
  const connect = useMutation(api.issueRelations.connect), disconnect = useMutation(api.issueRelations.disconnect);
  const [linking, setLinking] = useState(false); const [kind, setKind] = useState<RelationKind>("blocks"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const linkButton = useRef<HTMLButtonElement>(null), pending = useRef(false);
  const stopLinking = (restoreFocus = true) => { setLinking(false); if (restoreFocus) linkButton.current?.focus({ preventScroll: true }); };
  const attempt = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (error) { setError(errorText(error, "Could not update issue")); } finally { setBusy(false); } };
  const relations = (data?.relations || []).filter(row => !(hideSubIssues && row.kind === "parent" && row.outgoing));
  if (!canEdit && !relations.length) return null;
  return <section className="issue-relations" aria-label="Related issues">
    {!!relations.length && <div className="related-issue-list">{relations.map(row => <div key={row._id}>
      <small>{row.kind === "parent" ? row.outgoing ? "Sub-issue" : "Parent" : row.outgoing ? "Blocks" : "Blocked by"}</small>
      <button type="button" onClick={() => onOpen(row.projectId, row.taskId)}>{row.done ? <CheckCircle2 size={14} className="done" /> : <Circle size={14} />}<span>{row.title}</span></button>
      {canEdit && <button type="button" className="icon-button" aria-label={`Unlink ${row.title}`} title="Unlink" disabled={busy} onClick={event => {
        const hadFocus = document.activeElement === event.currentTarget;
        void attempt(async () => { await disconnect({ sessionToken, id: row._id }); if (hadFocus) linkButton.current?.focus({ preventScroll: true }); });
      }}><X size={13} /></button>}
    </div>)}</div>}
    {canEdit && <button ref={linkButton} type="button" className="issue-add-row" aria-haspopup="dialog" aria-expanded={linking} onClick={() => { if (linking) stopLinking(false); else setLinking(true); }}><Link2 size={14} />Link issue</button>}
    {linking && <LinkIssuePicker sessionToken={sessionToken} anchor={linkButton} projectId={projectId} exclude={taskId} linked={relations.map(row => row.taskId)} kind={kind} onKind={setKind} onClose={stopLinking} onSelect={other => {
      if (pending.current) return;
      pending.current = true;
      stopLinking();
      void attempt(async () => { const reverse = kind === "blocked" || kind === "child"; await connect({ sessionToken, fromTaskId: reverse ? other : taskId, toTaskId: reverse ? taskId : other, kind: kind === "parent" || kind === "child" ? "parent" : "blocks" }); }).finally(() => { pending.current = false; });
    }} />}
    {error && <p className="issue-field-error" role="alert">{error}</p>}
  </section>;
}

/** The issue's labels as color-dot chips plus the searchable label picker (L). */
export function IssueLabels({ sessionToken, taskId, canEdit, suggestions }: { sessionToken: string; taskId: Id<"tasks">; projectId?: Id<"projects">; canEdit: boolean; suggestions?: readonly string[] }) {
  const data = useQuery(api.issueRelations.list, { sessionToken, taskId });
  const save = useMutation(api.issueRelations.labels);
  const [pending, setPending] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const color = useLabelColors();
  const labels = pending ?? data?.labels ?? [];
  // Toggles apply at once and save in order; the server's list takes over when the last one lands.
  const change = (next: string[]) => {
    setPending(next); setError("");
    const run = () => save({ sessionToken, taskId, labels: next });
    const done = queue.current = queue.current.then(run, run);
    done.then(() => { if (queue.current === done) setPending(null); }, cause => { if (queue.current === done) setPending(null); setError(errorText(cause, "Could not update labels")); });
  };
  return <div className="issue-labels-field">
    <div className="issue-labels">
      {labels.map(value => <span key={value} className="label-chip"><LabelDot color={color(value)} /><span>{value}</span>{canEdit && <button type="button" aria-label={`Remove label ${value}`} onClick={() => change(labels.filter(item => item !== value))}><X size={11} /></button>}</span>)}
      {canEdit && <LabelPicker value={labels} onChange={change} suggestions={suggestions} trigger={() => labels.length ? <Plus size={13} /> : <><Tag size={13} /><span>Add label</span></>} className={labels.length ? "is-compact" : undefined} />}
      {!canEdit && !labels.length && <span className="issue-empty-value">None</span>}
    </div>
    {error && <small className="issue-field-error" role="alert">{error}</small>}
  </div>;
}
