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
        const text = await readTableResponse(response, controller.signal, MARKDOWN_PREVIEW_MAX_BYTES);
        if (!controller.signal.aborted) setSource(text);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error && reason.message === "size" ? "size" : "load");
      }
    })();
    return () => controller.abort();
  }, [path, message.threadId, message.messageId, attempt]);
  const retry = <button type="button" className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button>;
  const saveFailed = save.state === "failed" && <p role="alert" className="mt-2 text-[12px] text-danger">{save.reason}</p>;
  if (error) return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t(error === "size" ? "markdown.tooLarge" : "markdown.loadFailed")}</p><div className="flex justify-center gap-2"><button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-2 hover:bg-raised" disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} />{t("attach.saveAria", { name })}</button>{retry}</div>{saveFailed}</div>;
  if (source === null) return <div role="status" className="p-12 text-center text-sm text-ink-secondary"><span className="inline-flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" />{t("markdown.loading")}</span>{saveFailed}</div>;
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
