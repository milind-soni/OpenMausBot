// A compact message-level gallery. Image pixels keep the existing attachment
// path validation; local files and videos only load after an explicit action
// through the server's exact-message file authorization.
import { useEffect, useMemo, useRef, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ChevronDown, ChevronUp, Download, Film, LoaderCircle, Music, Play, X } from "lucide-react";
import { attachmentBasename, FILE_MAX_BYTES, type TranscriptFileAttachment, type TranscriptImageAttachment } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { windowsPathDestinations } from "../../shared/markdown-windows-paths";
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

export function fileIdentity(path: string): string {
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
  const tree: MarkdownNode = fromMarkdown(text, { mdastExtensions: [windowsPathDestinations] });
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

export function isAudioAttachment(path: string): boolean {
  return /\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i.test(fileIdentity(path));
}

type MessageAttachmentEntry = { path: string; kind?: string; name?: string };
const NO_GENERATED_ATTACHMENTS: readonly MessageAttachmentEntry[] = [];

/** A bot message's stored attachments as the gallery wants them: image paths,
 * plus documents, audio and video attached with attach_file as private files
 * (authorized by the message itself, like a user's own upload). */
export function splitMessageAttachments(attachments: readonly MessageAttachmentEntry[] = NO_GENERATED_ATTACHMENTS): { images: string[]; files: GalleryFile[] } {
  const images: string[] = [];
  const files: GalleryFile[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "file") files.push({ path: attachment.path, name: attachment.name || attachmentBasename(attachment.path), private: true });
    else if (attachment.kind === "image" || attachment.kind === undefined) images.push(attachment.path);
  }
  return { images, files };
}

/** What goes in the group under a bot reply that has text, and which
 * delivered files its inline links stand for. A local file the text already
 * links is not repeated as a chip: the inline link is the download. When that
 * link names a file the bot also delivered with attach_file, the link saves
 * the delivered copy (`delivered`), which the message itself authorizes.
 * Linked video and audio keep their player in the group. */
export function replyAttachmentGroup(text: string, attachments: readonly MessageAttachmentEntry[] = NO_GENERATED_ATTACHMENTS): {
  images: string[];
  files: GalleryFile[];
  delivered: Record<string, string>;
} {
  const attached = splitMessageAttachments(attachments);
  const links = collectMessageFiles(text);
  const linkedNames = new Set(links.map((link) => link.name));
  const delivered: Record<string, string> = {};
  const files: GalleryFile[] = [];
  const deliveredNames = new Map<string, number>();
  for (const file of attached.files) deliveredNames.set(file.name, (deliveredNames.get(file.name) ?? 0) + 1);
  for (const file of attached.files) {
    // two deliveries with one name stay chips: a link can't say which it means
    if (linkedNames.has(file.name) && deliveredNames.get(file.name) === 1) delivered[file.name] = file.path;
    else files.push(file);
  }
  const taken = new Set([...attached.images, ...attached.files.map((file) => file.path)].map(fileIdentity));
  for (const link of links) {
    if (Object.hasOwn(delivered, link.name) || taken.has(fileIdentity(link.path))) continue;
    if (isVideoAttachment(link.path) || isAudioAttachment(link.path)) files.push(link);
  }
  return { images: attached.images, files, delivered };
}

/** Group/room rows can share the gallery without parsing every old message
 * on unrelated state updates. Preserve the message's original attachment array. */
export function MessageAttachmentGallery({ text, attachments = NO_GENERATED_ATTACHMENTS, message, eager, className }: {
  text: string;
  attachments?: readonly MessageAttachmentEntry[];
  message: MessageAttachmentContext;
  eager?: boolean;
  className?: string;
}) {
  const attached = useMemo(() => splitMessageAttachments(attachments), [attachments]);
  const files = useMemo(
    () => [...attached.files, ...collectMessageFiles(text, [...attached.images, ...attached.files.map((file) => file.path)])],
    [text, attached],
  );
  return <AttachmentGallery images={attached.images} files={files} message={message} eager={eager} className={className} />;
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

const AUDIO_MIMES = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/ogg", "audio/opus", "audio/flac", "audio/x-flac"];

/** Same rule as video: the server must say it is audio, and the read is bounded
 * even when a proxy drops Content-Length. */
export async function loadMessageAudio(
  file: GalleryFile,
  message: MessageAttachmentContext,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await requestMessageFile(file.path, message, signal);
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mime || !AUDIO_MIMES.includes(mime)) {
    await response.body?.cancel();
    throw new Error(t("attach.audioUnavailable"));
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > FILE_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(t("attach.fileTooLarge"));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t("attach.audioUnavailable"));
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

/** A clip is a name and a play button; the bytes load, and play, on that click. */
function AudioAttachment({ file, message }: { file: GalleryFile; message: MessageAttachmentContext }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const load = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const blob = await loadMessageAudio(file, message, controller.signal);
      if (!controller.signal.aborted) setSrc(URL.createObjectURL(blob));
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("attach.audioUnavailable"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <div className="inline-flex w-72 max-w-full flex-col gap-1.5 rounded-2xl border border-hairline/30 bg-inset/60 px-3 py-2.5 text-left">
      <div className="flex items-center gap-2">
        {src ? <Music size={14} className="shrink-0 text-accent" aria-hidden="true" />
          : (
            <button type="button" disabled={loading} onClick={() => void load()} aria-label={t("attach.previewAudio", { name: file.name })}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait">
              {loading ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={13} fill="currentColor" />}
            </button>
          )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={file.name}>{file.name}</span>
        {src && <a href={src} download={file.name} aria-label={t("attach.saveAria", { name: file.name })} title={t("attach.saveAria", { name: file.name })}
          className="shrink-0 rounded-lg p-1 text-ink-secondary hover:bg-raised hover:text-ink"><Download size={14} /></a>}
      </div>
      {src && !error && <audio src={src} controls autoPlay preload="metadata" aria-label={t("attach.previewAudio", { name: file.name })} onError={() => { setSrc(null); setError(t("attach.audioUnavailable")); }} className="h-9 w-full" />}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

type GalleryItem = { key: string } & (
  | { kind: "image"; image: PreviewImage }
  | { kind: "video" | "audio" | "file"; file: GalleryFile }
);

/** How many items the group under a reply shows before "+N more". */
const BENEATH_LIMIT = 6;

export function AttachmentGallery({ images = [], files = [], message, eager = false, beneath = false, className }: {
  images?: Array<string | TranscriptImageAttachment>;
  files?: GalleryFile[];
  message?: MessageAttachmentContext;
  eager?: boolean;
  /** The compact group under a reply's text: image thumbnails and file
   * pills in wrapping rows, then "+N more". */
  beneath?: boolean;
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
      const trusted = Boolean(message && (file.private || file.linked));
      result.push({ key, kind: trusted && isVideoAttachment(file.path) ? "video" : trusted && isAudioAttachment(file.path) ? "audio" : "file", file });
    }
    return result;
  }, [images, files, message]);
  if (!items.length) return null;
  const limit = beneath ? BENEATH_LIMIT : 4;
  const shown = expanded ? items : items.slice(0, limit);
  const media = shown.filter((item) => item.kind === "image" || item.kind === "video");
  const documents = shown.filter((item) => item.kind === "file" || item.kind === "audio");
  const previews = items.flatMap((item) => item.kind === "image" ? [item.image] : []);
  const label = items.length === 1 ? t("attach.gallerySingle") : t("attach.galleryCount", { count: items.length });
  const dialog = selected && previews.some((image) => image.src === selected.src) && (
    <AttachmentPreviewDialog image={selected} images={previews} initialIndex={previews.findIndex((image) => image.src === selected.src)} onClose={() => setSelected(null)} />
  );

  if (beneath) {
    const thumbs = shown.filter((item) => item.kind === "image");
    const videos = shown.filter((item) => item.kind === "video");
    const rest = shown.filter((item) => item.kind === "file" || item.kind === "audio");
    return (
      <section aria-label={label} className={cn("mt-2.5 flex max-w-full flex-col items-start gap-2 text-start whitespace-normal", className)}>
        {thumbs.length > 0 && (
          <div className="flex max-w-full flex-wrap gap-2">
            {thumbs.map((item) => item.kind === "image" && (
              <div key={item.key} className="min-w-0" title={item.image.name}>
                <AttachmentThumbnail key={item.image.src} image={item.image} eager={eager} onPreview={() => setSelected(item.image)} className="h-24 w-auto max-w-48 rounded-2xl border-0" />
              </div>
            ))}
          </div>
        )}
        {videos.length > 0 && message && (
          <div className={cn("grid w-[min(34rem,70vw)] max-w-full gap-2", videos.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
            {videos.map((item) => item.kind === "video" && (
              <VideoAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} message={message} />
            ))}
          </div>
        )}
        {(rest.length > 0 || items.length > limit) && (
          <div className="flex max-w-full flex-wrap items-start gap-1.5">
            {rest.map((item) => item.kind === "audio" && message
              ? <AudioAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} message={message} />
              : item.kind === "file" && <AttachedFileChip key={item.key} file={item.file} linked={item.file.linked} message={message} compact />)}
            {items.length > limit && (
              <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="inline-flex h-7 items-center rounded-full px-2.5 text-[13px] leading-none text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {expanded ? t("attach.showLess") : t("attach.moreCount", { count: items.length - limit })}
              </button>
            )}
          </div>
        )}
        {dialog}
      </section>
    );
  }

  return (
    <section aria-label={label} className={cn("mb-1.5 w-[min(34rem,70vw)] max-w-full space-y-1.5 text-left whitespace-normal", className)}>
      {media.length > 0 && (
        <div className={cn("grid gap-2", media.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
          {media.map((item) => item.kind === "image" ? (
            <div key={item.key} className="min-w-0" title={item.image.name}>
              <AttachmentThumbnail key={item.image.src} image={item.image} eager={eager} onPreview={() => setSelected(item.image)} className="max-h-72 rounded-2xl border-0 bg-transparent" />
            </div>
          ) : item.kind === "video" && message ? (
            <VideoAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} message={message} />
          ) : null)}
        </div>
      )}
      {documents.length > 0 && (
        <div className="flex flex-col items-start gap-1.5">
          {documents.map((item) => item.kind === "audio" && message
            ? <AudioAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} message={message} />
            : item.kind === "file" && <AttachedFileChip key={item.key} file={item.file} linked={item.file.linked} message={message} className="max-w-none rounded-xl border-hairline/25 bg-transparent" />)}
        </div>
      )}
      {items.length > limit && (
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="flex min-h-8 items-center gap-1 rounded-lg px-1 py-1 text-[11px] text-ink-secondary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? t("attach.showLess") : t("attach.showMore", { count: items.length - limit })}
        </button>
      )}
      {dialog}
    </section>
  );
}
