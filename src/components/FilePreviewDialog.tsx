import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";

import { attachmentBasename } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  requestMessageFile,
  useLocalFileSave,
  type MessageAttachmentContext,
} from "./AttachmentPreview";

export function FilePreviewDialog({
  filePath,
  fileName,
  file,
  message,
  onClose,
}: {
  filePath?: string;
  fileName?: string;
  file?: { path: string; name?: string };
  message?: MessageAttachmentContext;
  onClose: () => void;
}) {
  const resolvedPath = file?.path ?? filePath ?? "";
  const resolvedName = file?.name ?? fileName ?? attachmentBasename(resolvedPath);

  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const save = useLocalFileSave(resolvedPath, resolvedName, message);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!message) {
      setError(t("attach.unavailableOld"));
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    requestMessageFile(resolvedPath, message, controller.signal)
      .then(async (res) => {
        const text = await res.text();
        if (!controller.signal.aborted) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : t("attach.downloadFailed"));
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [resolvedPath, message?.threadId, message?.messageId, attempt]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, []);

  const copyToClipboard = async () => {
    if (content === null) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failure
    }
  };

  const isMarkdown = /\.(?:md|markdown|mdown|mkdn)$/i.test(resolvedName || resolvedPath);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("attach.previewAria", { name: resolvedName })}
        tabIndex={-1}
        className="animate-pop-in flex h-full max-h-[900px] w-full max-w-[1000px] flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-panel text-ink shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline/30 bg-raised/50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={17} className="shrink-0 text-accent" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-ink" title={resolvedName}>
                {resolvedName}
              </div>
              <div className="text-[10.5px] text-ink-secondary">
                {isMarkdown ? "Markdown document" : "Document"}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {content !== null && (
              <button
                type="button"
                onClick={() => void copyToClipboard()}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-hairline/40 bg-panel px-2.5 text-[11.5px] font-medium text-ink hover:bg-raised"
                aria-label={copied ? "Copied" : "Copy content"}
                title="Copy content"
              >
                {copied ? (
                  <>
                    <Check size={13} className="text-success" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={13} />
                    <span>Copy</span>
                  </>
                )}
              </button>
            )}
            {save.state === "failed" && save.reason && (
              <span role="alert" className="max-w-[160px] truncate text-[11px] text-danger" title={save.reason}>
                {save.reason}
              </span>
            )}
            <button
              type="button"
              onClick={() => void save.save()}
              disabled={save.state === "saving"}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg border border-hairline/40 bg-panel px-2.5 text-[11.5px] font-medium text-ink hover:bg-raised disabled:cursor-wait",
                save.state === "failed" && "border-danger/40 text-danger",
              )}
              aria-label={
                save.state === "failed"
                  ? (t("attach.retrySaveAria", { name: resolvedName }) ?? `Retry saving ${resolvedName}`)
                  : t("attach.saveAria", { name: resolvedName })
              }
              title={t("attach.download")}
            >
              {save.state === "saving" ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : save.state === "saved" ? (
                <Check size={13} className="text-success" />
              ) : save.state === "failed" ? (
                <RotateCcw size={13} className="text-danger" />
              ) : (
                <Download size={13} />
              )}
              <span>
                {save.state === "saving"
                  ? "Saving…"
                  : save.state === "saved"
                    ? "Saved"
                    : save.state === "failed"
                      ? "Retry"
                      : "Save"}
              </span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
              aria-label={t("attach.close")}
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-inset/20">
          {loading && (
            <div className="flex flex-1 items-center justify-center p-8" role="status">
              <span className="flex items-center gap-2 text-[13px] text-ink-secondary">
                <LoaderCircle size={18} className="animate-spin text-accent" />
                <span>Loading {resolvedName}…</span>
              </span>
            </div>
          )}

          {error && !loading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-ink-secondary" role="alert">
              <FileText size={32} className="text-danger" />
              <span className="text-[13px] text-danger">{error}</span>
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-panel px-3 py-1.5 text-[12px] text-ink hover:bg-raised"
              >
                <RotateCcw size={13} /> Retry
              </button>
            </div>
          )}

          {content !== null && !loading && !error && (
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              {isMarkdown ? (
                <div className="chat-md prose prose-sm max-w-none text-ink [&>*+*]:mt-3">
                  <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
                </div>
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-hairline/30 bg-inset/60 p-4 font-mono text-[12.5px] leading-relaxed text-ink">
                  {content}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
