import { useEffect, useState } from "react";
import { Code2, Download, Eye, LoaderCircle, RotateCcw } from "lucide-react";
import { requestMessageFile, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { ChatMarkdown } from "./ChatMarkdown";
import { readTableResponse } from "./TableFilePreview";
import { t } from "@/lib/i18n";

export const MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** A Markdown file in a message, drawn the way the chat draws a reply. Security: no message context is passed on, so
 * paths written in the file stay plain text instead of becoming links that fetch other files. */
export default function MarkdownFileContent({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<"size" | "load" | "encoding" | { reason: string } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const save = useLocalFileSave(path, name, message);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setSource(null);
    void (async () => {
      let answered = false;
      try {
        const response = await requestMessageFile(path, message, controller.signal);
        answered = true;
        // Notes saved by Windows apps are often Windows-1252, not UTF-8.
        const text = await readTableResponse(response, controller.signal, MARKDOWN_PREVIEW_MAX_BYTES, "windows-1252");
        if (!controller.signal.aborted) setSource(text);
      } catch (reason) {
        if (controller.signal.aborted) return;
        // A refusal from the server says why; only a request that got no answer (TypeError) is the connection.
        if (!answered && reason instanceof Error && !(reason instanceof TypeError)) setError({ reason: reason.message });
        else setError(reason instanceof Error && (reason.message === "size" || reason.message === "encoding") ? reason.message : "load");
      }
    })();
    return () => controller.abort();
  }, [path, message.threadId, message.messageId, attempt]);
  // Save and Retry stay on screen while loading too, so a stalled request never leaves only a spinner; they wrap so a long name can't push Retry off a narrow dialog.
  const recovery = <><div className="mt-3 flex flex-wrap justify-center gap-2"><button type="button" className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-hairline px-3 py-2 hover:bg-raised" disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} className="shrink-0" /><span className="min-w-0 break-all">{t("attach.saveAria", { name })}</span></button><button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button></div>{save.state === "failed" && <p role="alert" className="mt-2 text-[12px] text-danger">{save.reason}</p>}</>;
  if (error) return <div className="p-8 text-center text-sm"><p role="alert" className="text-ink-secondary">{typeof error === "object" ? t("markdown.refused", { reason: error.reason }) : t(error === "size" ? "markdown.tooLarge" : error === "encoding" ? "markdown.notText" : "markdown.loadFailed")}</p>{recovery}</div>;
  if (source === null) return <div className="p-12 text-center text-sm text-ink-secondary"><span role="status" className="inline-flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" />{t("markdown.loading")}</span>{recovery}</div>;
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-end gap-1">
      <button type="button" className="table-action" aria-pressed={showSource} aria-label={t(showSource ? "markdown.rendered" : "html.source")} title={t(showSource ? "markdown.rendered" : "html.source")} onClick={() => setShowSource(!showSource)}>{showSource ? <Eye size={14} /> : <Code2 size={14} />}</button>
      <button type="button" className="table-action" aria-label={t("html.reload")} title={t("html.reload")} onClick={() => setAttempt(attempt + 1)}><RotateCcw size={14} /></button>
      <button type="button" className="table-action" aria-label={t("attach.saveAria", { name })} title={t("attach.saveAria", { name })} disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} /></button>
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    <MarkdownFileView source={source} showSource={showSource} />
  </div>;
}

/** The file itself: drawn as Markdown, or its raw text. */
export function MarkdownFileView({ source, showSource }: { source: string; showSource: boolean }) {
  return showSource
    ? <pre className="h-[72dvh] overflow-auto rounded-lg border border-hairline/40 bg-inset p-3 text-[12px] leading-5 whitespace-pre-wrap break-words text-ink">{source}</pre>
    : <div data-markdown-file className="h-[72dvh] overflow-auto rounded-lg border border-hairline/40 bg-panel px-5 py-4 text-[14px] leading-6 text-ink"><ChatMarkdown text={source} /></div>;
}
