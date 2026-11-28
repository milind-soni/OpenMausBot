import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Code2, Download, ExternalLink, Eye, LoaderCircle, RotateCcw } from "lucide-react";
import { requestMessageFile, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { OutsideWorkspacePreview, canOpenOutsideWorkspace, refusedAsOutsideWorkspace } from "./OutsideWorkspacePreview";
import { TableDialog } from "./RichTable";
import { readResponseBytes, readTableResponse, TableFileContent } from "./TableFilePreview";
import { cn } from "@/lib/cn";
import { useFileBesideChat, type FilePreview } from "@/lib/file-preview";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { tableDelimiter } from "@/lib/table-data";
import { PREVIEW_MAX_BYTES } from "../../shared/upload-limits";

/** Security: the frame may draw what the file carries inline, and fetch nothing at all. */
export const HTML_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";

export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

export function isPlainTextFile(name: string): boolean {
  return /\.(txt|text|log)$/i.test(name);
}

export function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** False where the browser downloads PDFs instead of showing them (Android, or the viewer turned off): there a PDF's
 * name keeps saving it. */
const showsPdf = () => typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;

// Lazy, so the chat's Markdown renderer (which uses this file's chips) is not imported back into it.
const MarkdownFileContent = lazy(() => import("./MarkdownFilePreview"));
const WhatChangedContent = lazy(() => import("./WhatChangedView"));

// React 19 caches a rejected lazy import until the page reloads; without a boundary it would replace the whole message.
class MarkdownPreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t("markdown.loadFailed")}</p><button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => location.reload()}>{t("page.broken.reload")}</button></div>;
  }
}

/** Security: `<base target="_blank">` turns every link into a popup, which the empty sandbox blocks, so the frame never navigates. */
export function htmlPreviewDocument(source: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><base target="_blank">${source}`;
}

/** The desktop app opens a copy of the page in this computer's default browser. Security: never on the web or in the
 * Cloud app, where a page would have to run on the app's own origin, nor while the window shows another computer. */
export function htmlBrowserBridge(): ((source: string, name: string) => Promise<unknown>) | undefined {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return ogb?.remoteClient?.active ? undefined : ogb?.openHtmlInBrowser;
}

/** The preview for an HTML, Markdown or PDF file in a message, opened by the eye button or by the file's name: beside the chat
 * when the window has room for it, else in a dialog. plainText: a plain text file opens it too. */
export function useHtmlPreview(path: string, name: string, message?: MessageAttachmentContext, shownPath = path, plainText = false) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const beside = useFileBesideChat();
  const kind = message === undefined ? null
    : isHtmlFile(name) || isHtmlFile(path) ? "html"
      : isMarkdownFile(name) || isMarkdownFile(path) ? "markdown"
        : (isPdfFile(name) || isPdfFile(path)) && showsPdf() ? "pdf"
        : plainText && (isPlainTextFile(name) || isPlainTextFile(path)) ? "text" : null;
  return {
    opens: kind !== null,
    label: t(kind === "html" ? "html.preview" : "markdown.preview", { name }),
    show: (event: { currentTarget: HTMLElement }) => {
      opener.current = event.currentTarget;
      if (kind && message && beside({ kind, path, shownPath, name, message, opener: event.currentTarget })) return;
      setOpen(true);
    },
    dialog: kind && open && message
      ? <TableDialog title={name} returnFocus={opener.current} onClose={() => setOpen(false)}>
        <FilePreviewContent kind={kind} path={path} shownPath={shownPath} name={name} message={message} />
      </TableDialog>
      : null,
  };
}

/** A file's preview, in the dialog or in the pane beside the chat, which it fills. */
export function FilePreviewContent({ kind, path, shownPath = path, name, message, original, fill = false }: Pick<FilePreview, "kind" | "path" | "shownPath" | "name" | "message" | "original"> & { fill?: boolean }) {
  const key = `${message.threadId}:${message.messageId}:${path}`;
  if (kind === "changes") return original ? <MarkdownPreviewBoundary><Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("changes.loading")}</div>}><WhatChangedContent key={`${key}:${original.path}`} edited={{ path, name, message }} original={{ path: original.path, name: original.name, message: { threadId: message.threadId, messageId: original.messageId } }} fill={fill} /></Suspense></MarkdownPreviewBoundary> : null;
  if (kind === "html") return <HtmlFileContent key={key} path={path} shownPath={shownPath} name={name} message={message} fill={fill} />;
  if (kind === "pdf") return <PdfFileContent key={key} path={path} shownPath={shownPath} name={name} message={message} fill={fill} />;
  if (kind === "table") {
    const delimiter = tableDelimiter(name) ?? tableDelimiter(path);
    return delimiter && <TableFileContent key={key} path={path} shownPath={shownPath} name={name} message={message} delimiter={delimiter} />;
  }
  return <MarkdownPreviewBoundary><Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("markdown.loading")}</div>}><MarkdownFileContent key={key} path={path} shownPath={shownPath} name={name} message={message} fill={fill} plain={kind === "text"} /></Suspense></MarkdownPreviewBoundary>;
}

export function HtmlFileButton({ path, shownPath, name, message }: { path: string; shownPath?: string; name: string; message: MessageAttachmentContext }) {
  const preview = useHtmlPreview(path, name, message, shownPath);
  return <>
    <button type="button" className="table-action" title={preview.label} aria-label={preview.label} onClick={preview.show}><Eye size={14} /></button>
    {preview.dialog}
  </>;
}

/** A file chip's name button: an HTML, Markdown or PDF file's name opens its preview, any other file's name saves it. */
export function chipNameAction(preview: ReturnType<typeof useHtmlPreview>, save: ReturnType<typeof useLocalFileSave>, name: string, retryable: boolean) {
  if (preview.opens) return { onClick: preview.show, disabled: false, "aria-label": preview.label };
  return { onClick: () => void save.save(), disabled: save.state === "saving", "aria-label": retryable ? t("attach.retrySaveAria", { name }) : t("attach.saveAria", { name }) };
}

/** Saves a file whose name opens its preview instead. */
export function SaveIconButton({ name, save, retryable }: { name: string; save: ReturnType<typeof useLocalFileSave>; retryable: boolean }) {
  const label = retryable ? t("attach.retrySaveAria", { name }) : t("attach.saveAria", { name });
  return (
    <button type="button" className="table-action" aria-label={label} title={label} disabled={save.state === "saving"} onClick={() => void save.save()}>
      {save.state === "saving" ? (
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      ) : save.state === "saved" ? (
        <Check size={14} className="text-success" aria-hidden="true" />
      ) : retryable ? (
        <RotateCcw size={14} className="text-danger" aria-hidden="true" />
      ) : (
        <Download size={14} aria-hidden="true" />
      )}
    </button>
  );
}

export function OpenInBrowserButton({ source, name, onError }: { source: string; name: string; onError: (reason: string) => void }) {
  const open = htmlBrowserBridge();
  if (!open) return null;
  const label = t("html.openInBrowser", { name });
  return <button type="button" className="table-action" aria-label={label} title={label} onClick={() => {
    onError("");
    open(source, name).catch((reason: unknown) => onError(reason instanceof Error && reason.message ? reason.message : t("html.openFailed")));
  }}><ExternalLink size={14} /></button>;
}

type PreviewError = "size" | "load" | "outside" | { reason: string };

const readHtml = (response: Response, signal: AbortSignal) => readTableResponse(response, signal, PREVIEW_MAX_BYTES);
// Security: the type is always PDF, so a file named .pdf that holds a page opens in the PDF viewer, never as a page
// on the app's own origin.
const readPdf = async (response: Response, signal: AbortSignal) => new Blob([await readResponseBytes(response, signal, PREVIEW_MAX_BYTES) as BlobPart], { type: "application/pdf" });

/** Loads a message's file for its preview, again on each retry, and from outside the chat's folder once the person
 * allows it. */
function usePreviewFile<T>(path: string, message: MessageAttachmentContext, read: (response: Response, signal: AbortSignal) => Promise<T>) {
  const fileKey = `${message.threadId}:${message.messageId}:${path}`;
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [canOpenOutside, setCanOpenOutside] = useState(false);
  const [allowOutsideFor, setAllowOutsideFor] = useState<string | null>(null);
  const allowOutside = allowOutsideFor === fileKey;
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setCanOpenOutside(false);
    setValue(null);
    void (async () => {
      let answered = false;
      try {
        const response = await requestMessageFile(path, message, controller.signal, allowOutside ? { allowOutsideWorkspace: true } : undefined);
        answered = true;
        const loaded = await read(response, controller.signal);
        if (!controller.signal.aborted) setValue(loaded);
      } catch (reason) {
        if (controller.signal.aborted) return;
        // A refusal from the server says why; only a request that got no answer (TypeError) is the connection.
        if (refusedAsOutsideWorkspace(reason)) {
          setCanOpenOutside(canOpenOutsideWorkspace(reason));
          setError("outside");
        }
        else if (!answered && reason instanceof Error && !(reason instanceof TypeError)) setError({ reason: reason.message });
        else setError(reason instanceof Error && reason.message === "size" ? "size" : "load");
      }
    })();
    return () => controller.abort();
  }, [path, message.threadId, message.messageId, attempt, allowOutside, read]);
  return { value, error, canOpenOutside, allowOutside, openOutside: () => setAllowOutsideFor(fileKey), retry: () => setAttempt(attempt + 1) };
}

/** What the preview shows instead of the file while it loads or after it failed; null once the file is there. */
function previewStatus(file: ReturnType<typeof usePreviewFile<unknown>>, shownPath: string, words: { refused: LocaleKey; failed: LocaleKey; loading: LocaleKey }) {
  const { error } = file;
  if (error === "outside") return <OutsideWorkspacePreview filePath={shownPath} onOpenOutside={file.canOpenOutside ? file.openOutside : undefined} />;
  if (error) return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{typeof error === "object" ? t(words.refused, { reason: error.reason }) : t(error === "size" ? "attach.fileTooLarge" : words.failed)}</p><button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={file.retry}>{t("chat.retry")}</button></div>;
  if (file.value === null) return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t(words.loading)}</div>;
  return null;
}

function HtmlFileContent({ path, shownPath, name, message, fill }: { path: string; shownPath: string; name: string; message: MessageAttachmentContext; fill: boolean }) {
  const file = usePreviewFile(path, message, readHtml);
  const [showSource, setShowSource] = useState(false);
  const [openFailed, setOpenFailed] = useState("");
  const save = useLocalFileSave(path, name, message);
  const status = previewStatus(file, shownPath, { refused: "html.refused", failed: "html.loadFailed", loading: "html.loading" });
  const { value: source, allowOutside } = file;
  if (status || source === null) return status;
  return <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
    <div className="flex items-center justify-end gap-1">
      <button type="button" className="table-action" aria-pressed={showSource} aria-label={t(showSource ? "html.rendered" : "html.source")} title={t(showSource ? "html.rendered" : "html.source")} onClick={() => setShowSource(!showSource)}>{showSource ? <Eye size={14} /> : <Code2 size={14} />}</button>
      <button type="button" className="table-action" aria-label={t("html.reload")} title={t("html.reload")} onClick={file.retry}><RotateCcw size={14} /></button>
      <OpenInBrowserButton source={source} name={name} onError={setOpenFailed} />
      <button type="button" className="table-action" aria-label={t("attach.saveAria", { name })} title={t("attach.saveAria", { name })} disabled={save.state === "saving"} onClick={() => void save.save(allowOutside ? { allowOutsideWorkspace: true } : undefined)}><Download size={14} /></button>
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    {openFailed && <p role="alert" className="text-end text-[12px] text-danger">{openFailed}</p>}
    {showSource
      ? <pre className={cn(previewHeight(fill), "overflow-auto rounded-lg border border-hairline/40 bg-inset p-3 text-[12px] leading-5 whitespace-pre-wrap break-words text-ink")}>{source}</pre>
      : <HtmlPreviewFrame source={source} name={name} fill={fill} />}
  </div>;
}

/** A dialog's file view has a fixed height; the pane beside the chat gives its view the room under the toolbar. */
export const previewHeight = (fill = false) => fill ? "min-h-0 flex-1" : "h-[72dvh]";

export function HtmlPreviewFrame({ source, name, fill }: { source: string; name: string; fill?: boolean }) {
  return <iframe sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(source)} title={t("html.frameTitle", { name })} className={cn(previewHeight(fill), "w-full rounded-lg border border-hairline/40 bg-white")} />;
}

/** Security: the PDF opens from a blob of this window only, typed as PDF, in the browser's own PDF viewer. */
function PdfFileContent({ path, shownPath, name, message, fill }: { path: string; shownPath: string; name: string; message: MessageAttachmentContext; fill: boolean }) {
  const file = usePreviewFile(path, message, readPdf);
  const [url, setUrl] = useState<string | null>(null);
  const save = useLocalFileSave(path, name, message);
  useEffect(() => {
    if (!file.value) {
      setUrl(null);
      return;
    }
    const made = URL.createObjectURL(file.value);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file.value]);
  const status = previewStatus(file, shownPath, { refused: "pdf.refused", failed: "pdf.loadFailed", loading: "markdown.loading" });
  if (status || url === null) return status;
  return <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
    <div className="flex items-center justify-end gap-1">
      <button type="button" className="table-action" aria-label={t("html.reload")} title={t("html.reload")} onClick={file.retry}><RotateCcw size={14} /></button>
      <button type="button" className="table-action" aria-label={t("attach.saveAria", { name })} title={t("attach.saveAria", { name })} disabled={save.state === "saving"} onClick={() => void save.save(file.allowOutside ? { allowOutsideWorkspace: true } : undefined)}><Download size={14} /></button>
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    <iframe src={url} referrerPolicy="no-referrer" title={t("html.frameTitle", { name })} className={cn(previewHeight(fill), "w-full rounded-lg border border-hairline/40 bg-white")} />
  </div>;
}
