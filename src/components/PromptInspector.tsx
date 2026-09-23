import { t } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Braces, X } from "lucide-react";
import type { PromptCapture } from "../../shared/prompt-inspector";
import { promptDifference, promptInput } from "@/lib/prompt-inspector";

export function PromptInspectorButton({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => setOpen(false), [threadId]);
  return <><button type="button" aria-label={t("promptInspector.title")} title={t("promptInspector.title")} onClick={() => setOpen(true)} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><Braces size={18} /></button>
    {open && <PromptInspector key={threadId} threadId={threadId} onClose={close} />}</>;
}
export function PromptInspector({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), abort = useRef<AbortController | null>(null);
  const [records, setRecords] = useState<PromptCapture[]>([]), [selected, setSelected] = useState(0);
  const [view, setView] = useState("input"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [matchAt, setMatchAt] = useState(-1);
  const match = useRef<HTMLElement>(null);
  const [wrap, setWrap] = useState(true), [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller; setBusy(true);
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/prompt-inspector`, { signal: controller.signal });
      if (!response.ok) throw new Error(t("promptInspector.loadFailed", { status: response.status }));
      const data = await response.json() as { records: PromptCapture[] };
      if (!controller.signal.aborted) { setRecords(data.records); setSelected(0); setError(""); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [threadId]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); void load();
    return () => { abort.current?.abort(); if (opener?.isConnected) opener.focus(); };
  }, [load]);
  const row = records[selected];
  const previous = row && records.slice(selected + 1).find(candidate => candidate.kind === row.kind && candidate.provider === row.provider);
  const input = row ? JSON.stringify(promptInput(row), null, 2) : "";
  const value = !row ? t("promptInspector.empty") : row.omitted && view !== "diagnostics" ? t("promptInspector.omitted") :
    view === "input" ? input : view === "changes" ? previous ? promptDifference(JSON.stringify(promptInput(previous), null, 2), input) : t("promptInspector.noPrevious") :
      JSON.stringify(view === "diagnostics" ? { provider: row.provider, kind: row.kind, sentAt: row.sentAt, status: row.status, endpoint: row.endpoint, httpStatus: row.httpStatus, responseHeaders: row.responseHeaders, usage: row.usage, durationMs: row.durationMs, error: row.error } : row.body, null, 2);
  const preview = value.slice(0, 750_000);
  const find = (next = false) => {
    const start = next && matchAt >= 0 ? matchAt + query.length : 0;
    const lower = preview.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
    const index = needle ? lower.indexOf(needle, start) : -1;
    setMatchAt(index < 0 && needle ? lower.indexOf(needle) : index);
  };
  useEffect(() => { setMatchAt(-1); }, [query, value]);
  useEffect(() => { match.current?.scrollIntoView({ block: "nearest" }); }, [matchAt]);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setError(t("promptInspector.copyFailed")); } };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "prompt-inspector.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const number = (n: number | null | undefined) => typeof n === "number" ? n.toLocaleString() : "—";
  return createPortal(<dialog ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="prompt-inspector-title" className="m-auto h-[80vh] w-[min(94vw,1100px)] max-w-none rounded-2xl border border-hairline bg-panel p-0 text-ink backdrop:bg-black/55">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between px-6 py-4"><h2 id="prompt-inspector-title" className="text-lg font-semibold">{t("promptInspector.title")}</h2><button autoFocus type="button" aria-label={t("promptInspector.close")} onClick={onClose} className="rounded p-1.5 hover:bg-raised"><X size={18} /></button></header>
      <div className="px-6 pb-3">
        <select aria-label={t("promptInspector.selection")} value={selected} onChange={event => { setSelected(Number(event.target.value)); setCopied(false); }} className="max-w-full rounded border border-hairline bg-inset p-2 text-sm">
          {!records.length && <option value={0}>{t("promptInspector.none")}</option>}
          {records.map((item, index) => <option key={item.id} value={index}>{item.provider} · {new Date(item.sentAt).toLocaleTimeString()} · {item.kind === "api-request" ? t("promptInspector.api") : t("promptInspector.agent")} · {item.status}</option>)}
        </select>
        <div className="mt-3 grid grid-cols-3 gap-4 text-sm">{[[t("promptInspector.uncached"), row?.usage?.uncached], [t("promptInspector.cached"), row?.usage?.cached], [t("promptInspector.output"), row?.usage?.output]].map(([label, count]) => <div key={String(label)}><div className="text-ink-secondary">{label}</div><div className="text-lg tabular-nums">{number(count as number | null | undefined)}</div></div>)}</div>
        <p className="mt-2 text-xs text-ink-secondary">{row?.kind === "api-request" ? t("promptInspector.apiHint") : t("promptInspector.agentHint")}</p>
      </div>
      <nav aria-label={t("promptInspector.view")} className="flex gap-4 border-y border-hairline px-6 text-sm">{[["input", row?.kind === "api-request" ? t("promptInspector.model") : t("promptInspector.agent")], ["request", t("promptInspector.full")], ["changes", t("promptInspector.changes")], ["diagnostics", t("promptInspector.diagnostics")]].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} className={"py-3 " + (view === key ? "border-b-2 border-accent text-accent" : "text-ink-secondary")} onClick={() => { setView(key); setCopied(false); }}>{label}</button>)}</nav>
      <form className="flex items-center gap-2 px-6 pt-3 text-sm" onSubmit={event => { event.preventDefault(); find(true); }}>
        <input aria-label={t("promptInspector.find")} placeholder={t("promptInspector.find")} value={query} onChange={event => setQuery(event.target.value)} className="rounded border border-hairline bg-inset px-2 py-1" />
        <button type="submit" disabled={!query}>{t("promptInspector.next")}</button>
      </form>
      {error && <p role="alert" className="px-6 py-2 text-danger">{error}</p>}
      <pre tabIndex={0} aria-label={t("promptInspector.content")} className={"min-h-0 flex-1 overflow-auto p-6 text-xs " + (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>{matchAt >= 0 ? <>{preview.slice(0, matchAt)}<mark ref={match}>{preview.slice(matchAt, matchAt + query.length)}</mark>{preview.slice(matchAt + query.length)}</> : preview}{value.length > 750_000 ? "\n" + t("promptInspector.previewLimit") : ""}</pre>
      <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-hairline px-6 py-3 text-sm"><label className="mr-auto"><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} /> {t("promptInspector.wrap")}</label><button type="button" disabled={busy} onClick={() => void load()}>{busy ? t("promptInspector.loading") : t("promptInspector.refresh")}</button><button type="button" disabled={!row} onClick={download}>{t("promptInspector.download")}</button><button type="button" disabled={!row} onClick={() => void copy()}>{copied ? t("promptInspector.copied") : t("promptInspector.copy")}</button></footer>
    </div>
  </dialog>, document.body);
}
