// A compact message-level gallery. Image pixels keep the existing attachment
// path validation; local files and videos only load after an explicit action
// through the server's exact-message file authorization.
import { useEffect, useMemo, useRef, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ChevronDown, ChevronUp, Film, LoaderCircle, Play, X } from "lucide-react";
import { attachmentBasename, FILE_MAX_BYTES, type TranscriptFileAttachment, type TranscriptImageAttachment } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localFilePath } from "./ChatMarkdown";
import {
  AttachedFileChip,
  AttachmentPreviewDialog,
  AttachmentThumbnail,
  previewImage,
  requestMessageFile,
  safeDownloadFilename,
  type MessageAttachmentContext,
  type PreviewImage,
} from "./AttachmentPreview";

export interface GalleryFile extends TranscriptFileAttachment {
  /** The file came from a rendered Markdown link rather than a user upload. */
  linked?: boolean;
}

type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
};

function fileIdentity(path: string): string {
  // This is only presentation deduplication, never an authorization check.
  // localFilePath has already decoded file:// once, including literal #/?
  // characters in filenames. Only raw Markdown paths have suffixes to strip.
  if (/^file:\/\//i.test(path)) return localFilePath(path) ?? path;
  try { return decodeURIComponent(path.split(/[?#]/, 1)[0]!); }
  catch { return path; }
}

/** Real Markdown links only: prose, examples, images, and remote URLs don't
 * turn into host file cards. The server independently validates every click. */
export function collectMessageFiles(text: string, existingPaths: readonly string[] = []): GalleryFile[] {
  const tree: MarkdownNode = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const links: MarkdownNode[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    } else if (node.type === "link" || node.type === "linkReference") {
      // Linked images already have a thumbnail in the Markdown renderer.
      if (!node.children?.some((child) => child.type === "image" || child.type === "imageReference")) links.push(node);
    }
    if (node.children) pending.push(...[...node.children].reverse());
  }
  const seen = new Set(existingPaths.map(fileIdentity));
  return links.flatMap((node) => {
    const href = node.url ?? (node.identifier ? definitions.get(node.identifier) : undefined);
    const path = localFilePath(href);
    if (!path || !href) return [];
    const identity = fileIdentity(href);
    if (seen.has(identity)) return [];
    seen.add(identity);
    // Send the authored spelling, not the decoded display path: the server
    // owns the one decode at its authorization/file-opening boundary.
    return [{ path: href, name: safeDownloadFilename(attachmentBasename(identity)), linked: true }];
  });
}

export function isVideoAttachment(path: string): boolean {
  return /\.(?:mp4|m4v|webm|mov)$/i.test(fileIdentity(path));
}

const NO_GENERATED_ATTACHMENTS: readonly { path: string }[] = [];

/** Group/room rows can share the gallery without parsing every old message
 * on unrelated state updates. Preserve the message's original attachment array. */
export function MessageAttachmentGallery({ text, attachments = NO_GENERATED_ATTACHMENTS, message, eager, className }: {
  text: string;
  attachments?: readonly { path: string }[];
  message: MessageAttachmentContext;
  eager?: boolean;
  className?: string;
}) {
  const images = useMemo(() => attachments.map((attachment) => attachment.path), [attachments]);
  const files = useMemo(() => collectMessageFiles(text, images), [text, images]);
  return <AttachmentGallery images={images} files={files} message={message} eager={eager} className={className} />;
}

/** A server-provided MIME is required as well as the filename hint. Old
 * servers can still download a video but never turn arbitrary bytes into UI. */
export async function loadMessageVideo(
  file: GalleryFile,
  message: MessageAttachmentContext,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await requestMessageFile(file.path, message, signal);
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mime || !["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"].includes(mime)) {
    await response.body?.cancel();
    throw new Error(t("attach.videoUnavailable"));
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > FILE_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(t("attach.fileTooLarge"));
  }
  // Keep this bounded even if a reverse proxy omits Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t("attach.videoUnavailable"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FILE_MAX_BYTES) throw new Error(t("attach.fileTooLarge"));
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new Blob(chunks, { type: mime });
}

function VideoAttachment({ file, message }: { file: GalleryFile; message: MessageAttachmentContext }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (preview) videoRef.current?.focus();
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const load = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const blob = await loadMessageVideo(file, message, controller.signal);
      if (!controller.signal.aborted) setPreview(URL.createObjectURL(blob));
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("attach.videoUnavailable"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  };
  const close = () => {
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setPreview(null);
    setError("");
    // The button is hidden while the preview is mounted.
    requestAnimationFrame(() => playButton.current?.focus());
  };

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-hairline/40 bg-inset/40">
      <div className="relative flex aspect-[4/3] items-center justify-center bg-inset">
        {preview && !error ? (
          <video
            ref={videoRef}
            src={preview}
            tabIndex={0}
            controls
            playsInline
            preload="metadata"
            aria-label={t("attach.previewVideo", { name: file.name })}
            className="max-h-full max-w-full"
            onError={() => setError(t("attach.videoUnavailable"))}
          />
        ) : (
          <button
            ref={playButton}
            type="button"
            disabled={loading}
            onClick={() => void load()}
            aria-label={t("attach.previewVideo", { name: file.name })}
            className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-ink-secondary transition-colors hover:bg-raised/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-wait disabled:hover:bg-transparent"
          >
            {loading ? <LoaderCircle size={24} className="animate-spin" /> : <Play size={24} />}
            <span className="text-[12px]">{loading ? t("attach.videoLoading") : error ? t("chat.retry") : t("attach.loadVideo")}</span>
            {!error && !loading && <span className="text-[10.5px]">{t("attach.videoHint")}</span>}
          </button>
        )}
        {(preview || loading || error) && (
          <button type="button" aria-label={t("attach.closeVideo")} onClick={close} className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-panel/90 text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            <X size={14} />
          </button>
        )}
        {!preview && !loading && <Film size={13} className="pointer-events-none absolute left-2 top-2 text-ink-secondary/50" />}
      </div>
      {error && <p role="alert" className="px-3 py-2 text-[11px] text-danger">{error}</p>}
      <AttachedFileChip file={file} linked={file.linked} message={message} className="max-w-none rounded-none border-0 border-t border-hairline/30 bg-transparent" />
    </div>
  );
}

type GalleryItem = { key: string } & (
  | { kind: "image"; image: PreviewImage }
  | { kind: "video" | "file"; file: GalleryFile }
);

export function AttachmentGallery({ images = [], files = [], message, eager = false, className }: {
  images?: Array<string | TranscriptImageAttachment>;
  files?: GalleryFile[];
  message?: MessageAttachmentContext;
  eager?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<PreviewImage | null>(null);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const result: GalleryItem[] = [];
    for (const reference of images) {
      const path = typeof reference === "string" ? reference : reference.path;
      const key = fileIdentity(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const image = typeof reference === "string" || reference.private
        ? previewImage(path, typeof reference === "string" ? undefined : reference.name)
        : null;
      if (image) result.push({ key, kind: "image", image });
      else result.push({ key, kind: "file", file: typeof reference === "string" ? { path, name: attachmentBasename(path) } : reference });
    }
    for (const file of files) {
      const key = fileIdentity(file.path);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ key, kind: message && (file.private || file.linked) && isVideoAttachment(file.path) ? "video" : "file", file });
    }
    return result;
  }, [images, files, message]);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, 4);
  const media = shown.filter((item) => item.kind !== "file");
  const documents = shown.filter((item) => item.kind === "file");
  const previews = items.flatMap((item) => item.kind === "image" ? [item.image] : []);

  return (
    <section aria-label={items.length === 1 ? t("attach.gallerySingle") : t("attach.galleryCount", { count: items.length })} className={cn("mb-2 w-[min(34rem,70vw)] max-w-full overflow-hidden rounded-xl border border-hairline/40 bg-inset/25 text-left whitespace-normal", className)}>
      <header className="flex items-center gap-2 px-3 py-2 text-[11px] font-medium text-ink-secondary">
        <span>{t("attach.gallery")}</span><span className="tabular-nums opacity-65">{items.length}</span>
      </header>
      {media.length > 0 && (
        <div className={cn("grid gap-2 px-2 pb-2", media.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
          {media.map((item) => item.kind === "image" ? (
            <div key={item.key} className="min-w-0 overflow-hidden rounded-xl border border-hairline/30 bg-inset/40">
              <AttachmentThumbnail key={item.image.src} image={item.image} eager={eager} onPreview={() => setSelected(item.image)} className="max-h-64 rounded-none border-0" />
              <div className="flex items-center gap-2 px-2.5 py-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-ink" title={item.image.name}>{item.image.name}</span>
                <span className="shrink-0 text-[10px] text-ink-secondary">{t("attach.image")}</span>
              </div>
            </div>
          ) : item.kind === "video" && message ? (
            <VideoAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} message={message} />
          ) : null)}
        </div>
      )}
      {documents.length > 0 && (
        <div className="space-y-1 px-2 pb-2">
          {documents.map((item) => item.kind === "file" && <AttachedFileChip key={item.key} file={item.file} linked={item.file.linked} message={message} className="max-w-none rounded-lg border-hairline/25 bg-transparent" />)}
        </div>
      )}
      {items.length > 4 && (
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="flex min-h-8 w-full items-center justify-center gap-1 border-t border-hairline/30 px-3 py-1.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? t("attach.showLess") : t("attach.showMore", { count: items.length - 4 })}
        </button>
      )}
      {selected && previews.some((image) => image.src === selected.src) && (
        <AttachmentPreviewDialog image={selected} images={previews} initialIndex={previews.findIndex((image) => image.src === selected.src)} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
