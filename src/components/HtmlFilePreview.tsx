import { useEffect, useRef, useState } from "react";
import { Code2, Download, Eye, LoaderCircle, RotateCcw } from "lucide-react";
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

/** Security: `<base target="_blank">` turns every link into a popup, which the empty sandbox blocks, so the frame never navigates. */
export function htmlPreviewDocument(source: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><base target="_blank">${source}`;
}

export function HtmlFileButton({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="table-action" title={t("html.preview", { name })} aria-label={t("html.preview", { name })} onClick={() => setOpen(true)}><Eye size={14} /></button>
    {open && <TableDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}><HtmlFileContent key={`${message.threadId}:${message.messageId}:${path}`} path={path} name={name} message={message} /></TableDialog>}
  </>;
}

function HtmlFileContent({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<"size" | "load" | null>(null);
  const [showSource, setShowSource] = useState(false);
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
      <button type="button" className="table-action" aria-label={t("attach.saveAria", { name })} title={t("attach.saveAria", { name })} disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} /></button>
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    {showSource
      ? <pre className="h-[72dvh] overflow-auto rounded-lg border border-hairline/40 bg-inset p-3 text-[12px] leading-5 whitespace-pre-wrap break-words text-ink">{source}</pre>
      : <HtmlPreviewFrame source={source} name={name} />}
  </div>;
}

export function HtmlPreviewFrame({ source, name }: { source: string; name: string }) {
  return <iframe sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(source)} title={t("html.frameTitle", { name })} className="h-[72dvh] w-full rounded-lg border border-hairline/40 bg-white" />;
}
