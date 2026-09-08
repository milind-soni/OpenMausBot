import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Download, FileText, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { t } from "@/lib/i18n";
import "./document-workspace.css";

type Selection = { path: string; message: MessageAttachmentContext; opener: HTMLElement | null };
type Preview = { name: string; bytes: number; kind: "markdown" | "text" | "download"; text?: string; truncated: boolean };
const DocumentContext = createContext<((path: string, message: MessageAttachmentContext) => void) | null>(null);
/** Return the enclosing task's preview opener, or null for download-only hosts. */
export const useDocumentPreview = () => useContext(DocumentContext);

/** The scope check is synchronous: a task switch cannot expose an old
 * document even for the render before effects run. The chat stays mounted. */
export function DocumentWorkspace({ scope, children }: { scope: string; children: ReactNode }) {
  const [selected, setSelected] = useState<(Selection & { scope: string }) | null>(null);
  const [narrow, setNarrow] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 0) < 900));
    if (workspace.current) observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const open = useCallback((path: string, message: MessageAttachmentContext) => {
    setSelected({ path, message, scope, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, [scope]);
  const close = useCallback(() => setSelected(null), []);
  useEffect(() => setSelected(null), [scope]);
  const current = selected?.scope === scope ? selected : null;
  return <DocumentContext.Provider value={open}>
    <div ref={workspace} className="document-workspace">
      {children}
      {current && <DocumentPanel key={`${current.message.threadId}:${current.message.messageId}:${current.path}`} selection={current} onClose={close} narrow={narrow} />}
    </div>
  </DocumentContext.Provider>;
}

/** Load a message-authorized preview with cancellable requests and keyboard
 * focus ownership; narrow layouts trap focus until the reader is dismissed. */
function DocumentPanel({ selection, onClose, narrow }: { selection: Selection; onClose: () => void; narrow: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const save = useLocalFileSave(selection.path, preview?.name, selection.message);
  const name = preview?.name ?? selection.path.split(/[\\/]/).at(-1) ?? t("document.title");

  useEffect(() => {
    closeButton.current?.focus();
    return () => { if (selection.opener?.isConnected) selection.opener.focus(); };
  }, [selection.opener]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (narrow || panel.current?.contains(document.activeElement))) { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !narrow) return;
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']") ?? [])];
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const focus = (event: FocusEvent) => {
      if (narrow && !panel.current?.contains(event.target as Node)) closeButton.current?.focus();
    };
    if (narrow && !panel.current?.contains(document.activeElement)) closeButton.current?.focus();
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("focusin", focus); };
  }, [narrow, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError("");
    void (async () => {
      try {
        const { threadId, messageId } = selection.message;
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/file`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: selection.path, preview: true }), signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(response.status === 403 ? t("document.denied") : response.status === 404 ? t("document.missing") : response.status === 413 ? t("document.tooLarge") : t("document.failed"));
        }
        const body = await response.json() as Preview;
        if (!controller.signal.aborted) setPreview(body);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("document.failed"));
      }
    })();
    return () => controller.abort();
  }, [selection.path, selection.message.threadId, selection.message.messageId, attempt]);

  /** Copy only the bounded preview; saving remains the route to the complete file. */
  const copy = async () => {
    try { await navigator.clipboard.writeText(preview?.text ?? ""); setCopyStatus(t("document.copied")); }
    catch { setCopyStatus(t("document.copyFailed")); }
  };

  return <>
    {narrow && <div className="document-backdrop" aria-hidden="true" onClick={onClose} />}
    <aside ref={panel} className="document-panel" data-overlay={narrow} role={narrow ? "dialog" : "region"} aria-modal={narrow || undefined} aria-label={t("document.title")}>
      <header className="document-header">
        <FileText size={18} aria-hidden="true" />
        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold" title={name}>{name}</h2>
          <p className="text-xs text-ink-secondary">{t("document.readOnly")}{preview ? ` · ${Math.ceil(preview.bytes / 1024)} KB` : ""}</p>
        </div>
        <button ref={closeButton} type="button" onClick={onClose} aria-label={t("document.close")} title={t("document.close")}><X size={18} /></button>
      </header>
      <div className="document-toolbar">
        <button type="button" disabled={preview?.text === undefined} onClick={() => void copy()}><Copy size={14} />{t("document.copy")}</button>
        <button type="button" disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} />{save.state === "saving" ? t("document.saving") : t("document.save")}</button>
        <span className="text-xs text-ink-secondary" role="status">{copyStatus || (save.state === "saved" ? t("document.saved") : "")}</span>
      </div>
      {save.state === "failed" && <p role="alert" className="px-5 py-2 text-sm text-danger">{save.reason}</p>}
      <div className="document-body" tabIndex={0} aria-label={t("document.content")}>
        {error ? <div className="document-state" role="alert"><FileText size={28} /><p>{error}</p>
          <code className="break-all text-xs text-ink-secondary">{selection.path}</code>
          <button type="button" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={14} />{t("document.retry")}</button>
        </div> : !preview ? <div className="document-state" role="status"><LoaderCircle className="animate-spin" size={24} />{t("document.loading")}</div>
          : preview.kind === "download" ? <div className="document-state"><FileText size={32} /><p>{t("document.unsupported")}</p>
            <button type="button" onClick={() => void save.save()} disabled={save.state === "saving"}><Download size={14} />{t("document.save")}</button>
          </div> : <>
            {preview.truncated && <p role="status" className="mb-5 rounded bg-inset p-3 text-sm text-ink-secondary">{t("document.truncated")}</p>}
            {preview.text === "" ? <p className="text-ink-secondary">{t("document.empty")}</p> : preview.kind === "markdown" ?
              <article className="document-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
                // Reading a document never fetches its nested resources or
                // grants its untrusted links a stored-message capability.
                img: ({ alt }) => <span className="text-ink-secondary">[{alt || t("document.image")}]</span>,
                a: ({ children }) => <span>{children}</span>,
                table: ({ children }) => <div className="document-table"><table>{children}</table></div>,
              }}>{preview.text}</Markdown></article> : <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6">{preview.text}</pre>}
          </>}
      </div>
    </aside>
  </>;
}
