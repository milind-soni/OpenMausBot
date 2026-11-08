import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, Code2, Download, ExternalLink, Eye, LoaderCircle, RotateCcw } from "lucide-react";
import { requestMessageFile, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { TableDialog } from "./RichTable";
import { readTableResponse } from "./TableFilePreview";
import { t } from "@/lib/i18n";

export const HTML_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Security: the frame may draw what the file carries inline, and fetch nothing at all. */
export const HTML_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";

export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

// Lazy, so the chat's Markdown renderer (which uses this file's chips) is not imported back into it.
const MarkdownFileContent = lazy(() => import("./MarkdownFilePreview"));

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

/** The preview dialog for an HTML or Markdown file in a message, opened by the eye button or by the file's name. */
export function useHtmlPreview(path: string, name: string, message?: MessageAttachmentContext) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const kind = message === undefined ? null
    : isHtmlFile(name) || isHtmlFile(path) ? "html"
      : isMarkdownFile(name) || isMarkdownFile(path) ? "markdown" : null;
  const key = message ? `${message.threadId}:${message.messageId}:${path}` : "";
  return {
    opens: kind !== null,
    label: t(kind === "markdown" ? "markdown.preview" : "html.preview", { name }),
    show: (event: { currentTarget: HTMLElement }) => {
      opener.current = event.currentTarget;
      setOpen(true);
    },
    dialog: kind && open && message
      ? <TableDialog title={name} returnFocus={opener.current} onClose={() => setOpen(false)}>
        {kind === "html"
          ? <HtmlFileContent key={key} path={path} name={name} message={message} />
          : <Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("markdown.loading")}</div>}><MarkdownFileContent key={key} path={path} name={name} message={message} /></Suspense>}
      </TableDialog>
      : null,
  };
}

export function HtmlFileButton({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const preview = useHtmlPreview(path, name, message);
  return <>
    <button type="button" className="table-action" title={preview.label} aria-label={preview.label} onClick={preview.show}><Eye size={14} /></button>
    {preview.dialog}
  </>;
}

/** A file chip's name button: an HTML or Markdown file's name opens its preview, any other file's name saves it. */
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

function HtmlFileContent({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<"size" | "load" | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [openFailed, setOpenFailed] = useState("");
  const save = useLocalFileSave(path, name, message);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setSource(null);
    void (async () => {
      try {
        const response = await requestMessageFile(path, message, controller.signal);
        const text = await readTableResponse(response, controller.signal, HTML_PREVIEW_MAX_BYTES);
        if (!controller.signal.aborted) setSource(text);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error && reason.message === "size" ? "size" : "load");
      }
    })();
    return () => controller.abort();
  }, [path, message.threadId, message.messageId, attempt]);
  if (error) return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t(error === "size" ? "html.tooLarge" : "html.loadFailed")}</p><button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button></div>;
  if (source === null) return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("html.loading")}</div>;
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-end gap-1">
      <button type="button" className="table-action" aria-pressed={showSource} aria-label={t(showSource ? "html.rendered" : "html.source")} title={t(showSource ? "html.rendered" : "html.source")} onClick={() => setShowSource(!showSource)}>{showSource ? <Eye size={14} /> : <Code2 size={14} />}</button>
      <button type="button" className="table-action" aria-label={t("html.reload")} title={t("html.reload")} onClick={() => setAttempt(attempt + 1)}><RotateCcw size={14} /></button>
      <OpenInBrowserButton source={source} name={name} onError={setOpenFailed} />
      <button type="button" className="table-action" aria-label={t("attach.saveAria", { name })} title={t("attach.saveAria", { name })} disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} /></button>
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    {openFailed && <p role="alert" className="text-end text-[12px] text-danger">{openFailed}</p>}
    {showSource
      ? <pre className="h-[72dvh] overflow-auto rounded-lg border border-hairline/40 bg-inset p-3 text-[12px] leading-5 whitespace-pre-wrap break-words text-ink">{source}</pre>
      : <HtmlPreviewFrame source={source} name={name} />}
  </div>;
}

export function HtmlPreviewFrame({ source, name }: { source: string; name: string }) {
  return <iframe sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(source)} title={t("html.frameTitle", { name })} className="h-[72dvh] w-full rounded-lg border border-hairline/40 bg-white" />;
}
