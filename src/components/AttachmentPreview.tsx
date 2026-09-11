// Same-origin attachment previews plus the reusable image viewer used by
// Markdown. Transcript paths are resolved through attachmentImageUrl; model
// text never gets to turn an arbitrary local path into a browser request.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  ImageOff,
  LoaderCircle,
  Maximize2,
  RotateCcw,
  X,
} from "lucide-react";

import {
  attachmentBasename,
  attachmentImageUrl,
  type TranscriptFileAttachment,
  type TranscriptImageAttachment,
} from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export interface PreviewImage {
  src: string;
  name: string;
  /** Same-origin images can be downloaded directly. */
  downloadUrl?: string;
  /** A portable filename chosen independently from the visible label. */
  downloadName?: string;
  /** Authored remote images keep an explicit way to open their source. */
  openUrl?: string;
}

export interface MessageAttachmentContext { threadId: string; messageId: string }

export function previewImage(path: string, name = attachmentBasename(path)): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  return {
    src,
    name,
    downloadUrl: src,
    downloadName: canonicalDownloadFilename({ fallback: name, source: path }),
  };
}

export function wrappedImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}

export type PreviewKeyAction = "close" | "previous" | "next" | null;

export function previewKeyAction(key: string, count: number): PreviewKeyAction {
  if (key === "Escape") return "close";
  if (count > 1 && key === "ArrowLeft") return "previous";
  if (count > 1 && key === "ArrowRight") return "next";
  return null;
}

export function imageGalleryLayout(count: number): string {
  if (count <= 1) return "w-[min(32rem,70vw)] grid-cols-1";
  if (count === 2) return "w-[min(36rem,70vw)] grid-cols-2";
  return "w-[min(38rem,70vw)] grid-cols-2 sm:grid-cols-3";
}

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

/** Keep a suggested download name portable and prevent it from naming a path. */
export function safeDownloadFilename(value: string | null | undefined): string {
  const basename = (value ?? "").split(/[\\/]/).at(-1) ?? "";
  const cleaned = basename
    .normalize("NFC")
    // oxlint-disable-next-line no-control-regex -- strips control and bidi characters from a filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = Array.from(cleaned)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character.length > 1 || code < 0xd800 || code > 0xdfff;
    })
    .slice(0, 180)
    .join("");
  if (!bounded) return "download";
  const stem = bounded.split(".", 1)[0]!.toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${bounded}` : bounded;
}

/** Read the server-selected filename, preferring RFC 5987's UTF-8 form. */
export function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]*)/i.exec(header)?.[1]?.trim();
  if (encoded) {
    const unquoted = encoded.replace(/^"|"$/g, "");
    try {
      return safeDownloadFilename(decodeURIComponent(unquoted));
    } catch {
      // A malformed extended value may still have a valid ASCII fallback.
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header)?.[1];
  if (quoted !== undefined) return safeDownloadFilename(quoted.replace(/\\(.)/g, "$1"));
  const plain = /(?:^|;)\s*filename\s*=\s*([^;]*)/i.exec(header)?.[1]?.trim();
  return plain ? safeDownloadFilename(plain) : null;
}

function sourceImageExtension(source: string | undefined): string | null {
  if (!source) return null;
  let pathname = source;
  try {
    pathname = decodeURIComponent(new URL(source, "https://openmausbot.invalid").pathname);
  } catch {
    pathname = source.split(/[?#]/, 1)[0] ?? source;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return extension && IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

function replaceExtension(name: string, extension: string): string {
  const suffix = `.${extension}`;
  const stem = name.replace(/\.[^.]*$/, "") || "image";
  const available = Math.max(1, 180 - Array.from(suffix).length);
  return `${Array.from(stem).slice(0, available).join("")}${suffix}`;
}

/** The response chooses the label; image bytes/source choose the extension. */
export function canonicalDownloadFilename({
  contentDisposition,
  fallback,
  source,
  mime,
}: {
  contentDisposition?: string | null;
  fallback?: string;
  source?: string;
  mime?: string | null;
}): string {
  const selected = contentDispositionFilename(contentDisposition ?? null)
    ?? safeDownloadFilename(fallback);
  const mediaType = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const imageExtension = IMAGE_EXTENSION_BY_MIME[mediaType] ?? sourceImageExtension(source);
  return imageExtension ? replaceExtension(selected, imageExtension) : selected;
}

export function isExternalImageSource(src: string): boolean {
  const value = src.trim();
  // The URL parser removes embedded ASCII tab/LF/CR and treats backslashes as
  // slashes for special schemes. Normalize those parser quirks before deciding
  // whether mounting the image would make a network request.
  const networkSpelling = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  // Chromium canonicalizes special-scheme variants such as `https:host/x`,
  // `https:/host/x`, and backslash spellings into network requests. Treat the
  // whole scheme family as remote before an <img> can mount.
  return networkSpelling.startsWith("//") || /^https?:/i.test(networkSpelling);
}

/** A message-scoped image URL is safe for an <img>: the server still proves
 * that this exact message rendered an image at this Markdown source offset
 * before streaming it. The host path never enters the browser URL. */
export function messageImagePreviewUrl(
  message: MessageAttachmentContext,
  sourceOffset: number,
): string {
  return `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file?preview=1&ref=${sourceOffset}`;
}

function revokeObjectUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Shared save state for transcript file chips and bot-authored file links. */
export function useLocalFileSave(filePath: string, name?: string, message?: MessageAttachmentContext) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    saving.current = false;
    setReason("");
    setSavedTo("");
    setState("idle");
  }, [filePath, message?.messageId, message?.threadId]);

  const save = useCallback(async () => {
    if (saving.current) return;
    if (!message) {
      setReason(t("attach.unavailableOld"));
      setState("failed");
      return;
    }
    saving.current = true;
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setReason("");
    setState("saving");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: filePath }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? t("attach.downloadFailed"));
      }
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const saved = canonicalDownloadFilename({
        contentDisposition: response.headers.get("content-disposition"),
        fallback: name || attachmentBasename(filePath),
        source: filePath,
        mime: blob.type || response.headers.get("content-type"),
      });
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = saved;
        link.style.display = "none";
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        // Chromium may not consume a blob URL until after the click task ends.
        revokeObjectUrlLater(url);
      }
      if (!mounted.current || controller.signal.aborted) return;
      setSavedTo(saved);
      setState("saved");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setState("idle");
      }, 4000);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setReason(error instanceof Error ? error.message : t("attach.saveFailed"));
      setState("failed");
    } finally {
      if (request.current === controller) {
        request.current = null;
        saving.current = false;
      }
    }
  }, [filePath, message?.messageId, message?.threadId, name]);

  return { state, reason, savedTo, save };
}

export function AttachmentPreviewDialog({
  image,
  images,
  initialIndex = 0,
  onClose,
}: {
  image: PreviewImage;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const items = images?.length ? images : [image];
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const current = items[index] ?? image;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [loadedSources, setLoadedSources] = useState<Set<string>>(() => new Set());
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const navigate = useCallback((step: -1 | 1) => {
    setIndex((value) => wrappedImageIndex(value, step, items.length));
    setFailedSource(null);
  }, [items.length]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const action = previewKeyAction(event.key, items.length);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "close") closeRef.current();
        else navigate(action === "previous" ? -1 : 1);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [items.length, navigate]);

  const loaded = loadedSources.has(current.src);
  const failed = failedSource === current.src;
  const retry = () => {
    setFailedSource(null);
    setLoadedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setAttempt((value) => value + 1);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("attach.previewAria", { name: current.name })}
        tabIndex={-1}
        className="animate-pop-in flex h-full max-h-[900px] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/70 shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-black/45 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-white">{current.name}</div>
            <div className="text-[10.5px] text-white/50">
              {items.length > 1
                ? t("attach.position", { index: index + 1, count: items.length })
                : t("attach.imagePreview")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {current.downloadUrl && (
              <a
                href={current.downloadUrl}
                download={current.downloadName ?? canonicalDownloadFilename({
                  fallback: current.name,
                  source: current.downloadUrl,
                })}
                className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
                aria-label={t("attach.downloadAria", { name: current.name })}
                title={t("attach.download")}
              >
                <Download size={17} />
              </a>
            )}
            {current.openUrl && (
              <a
                href={current.openUrl}
                target="_blank"
                rel="noreferrer"
                className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
                aria-label={t("attach.openOriginalAria", { name: current.name })}
                title={t("attach.openOriginal")}
              >
                <ExternalLink size={17} />
              </a>
            )}
            <button
              onClick={onClose}
              className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
              aria-label={t("attach.close")}
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 sm:p-8">
          {!loaded && !failed && (
            <div className="absolute inset-4 flex animate-pulse items-center justify-center rounded-xl bg-white/[0.055] sm:inset-8" role="status">
              <span className="flex items-center gap-2 text-[13px] text-white/55">
                <LoaderCircle size={17} className="animate-spin" /> Loading image…
              </span>
            </div>
          )}
          {failed ? (
            <div className="flex flex-col items-center gap-3 text-white/60" role="alert">
              <ImageOff size={34} />
              <span className="text-[13px]">This image could not be loaded.</span>
              <button
                type="button"
                onClick={retry}
                className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] text-white hover:bg-white/15"
              >
                <RotateCcw size={13} /> Retry
              </button>
            </div>
          ) : (
            <img
              key={`${current.src}:${attempt}`}
              src={current.src}
              alt={current.name}
              onLoad={() => setLoadedSources((sources) => new Set(sources).add(current.src))}
              onError={() => setFailedSource(current.src)}
              className={cn(
                "block max-h-full max-w-full rounded-lg object-contain shadow-2xl transition-opacity duration-150",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
          )}
          {items.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => navigate(-1)}
                aria-label={t("attach.previous")}
                className="absolute left-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/80 backdrop-blur-sm hover:bg-black/75 hover:text-white sm:left-4"
              >
                <ChevronLeft size={21} />
              </button>
              <button
                type="button"
                onClick={() => navigate(1)}
                aria-label={t("attach.next")}
                className="absolute right-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/80 backdrop-blur-sm hover:bg-black/75 hover:text-white sm:right-4"
              >
                <ChevronRight size={21} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Thumbnail({
  image,
  onPreview,
  className,
  eager = false,
}: {
  image: PreviewImage;
  onPreview: () => void;
  className?: string;
  eager?: boolean;
}) {
  // Every caller keys this component by src. Resetting in an effect races a
  // cached/blob image's onLoad: it can become ready before the effect runs,
  // then be put back into a permanent loading state.
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);

  return (
    <span className={cn("group/image relative block aspect-[4/3] min-w-0 overflow-hidden rounded-xl border border-hairline/40 bg-inset", className)}>
      {state === "loading" && (
        <span className="absolute inset-0 flex animate-pulse items-center justify-center bg-raised/65" role="status">
          <LoaderCircle size={17} className="animate-spin text-ink-secondary/65" />
          <span className="sr-only">Loading {image.name}</span>
        </span>
      )}
      {state === "failed" ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-ink-secondary" role="alert">
          <ImageOff size={22} />
          <span className="max-w-full truncate text-[11.5px]">Image unavailable</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            className="flex items-center gap-1 rounded-md border border-hairline/50 bg-panel px-2 py-1 text-[11px] text-ink hover:bg-raised"
            aria-label={t("attach.retryAria", { name: image.name })}
          >
            <RotateCcw size={11} /> {t("chat.retry")}
          </span>
        </span>
      ) : (
        <span
          role="button"
          tabIndex={state === "ready" ? 0 : -1}
          aria-disabled={state !== "ready"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (state === "ready") onPreview();
          }}
          onKeyDown={(event) => {
            if (state === "ready" && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onPreview();
            }
          }}
          className="absolute inset-0 block size-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 aria-disabled:cursor-default"
          aria-label={t("attach.previewImageAria", { name: image.name })}
          title={t("attach.previewAria", { name: image.name })}
        >
          <img
            key={`${image.src}:${attempt}`}
            src={image.src}
            alt={image.name}
            loading={eager ? "eager" : "lazy"}
            fetchPriority={eager ? "high" : undefined}
            onLoad={() => setState("ready")}
            onError={() => setState("failed")}
            className={cn(
              "block size-full object-cover transition duration-200 group-hover/image:scale-[1.015]",
              state === "ready" ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-within/image:opacity-100">
            <Maximize2 size={13} />
          </span>
        </span>
      )}
    </span>
  );
}

export function AttachedImageGallery({
  paths,
  className,
  eager = false,
}: {
  paths: Array<string | TranscriptImageAttachment>;
  className?: string;
  eager?: boolean;
}) {
  const images = useMemo(() => paths.flatMap((reference) => {
    if (typeof reference !== "string" && !reference.private) return [];
    const path = typeof reference === "string" ? reference : reference.path;
    const name = typeof reference === "string" ? undefined : reference.name;
    const image = previewImage(path, name);
    return image ? [image] : [];
  }), [paths]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("mb-2 grid max-w-full gap-2", imageGalleryLayout(images.length), className)}>
        {images.map((image, index) => (
          <Thumbnail key={`${image.src}:${index}`} image={image} onPreview={() => setSelectedIndex(index)} eager={eager} />
        ))}
      </div>
      {selectedIndex !== null && images[selectedIndex] && (
        <AttachmentPreviewDialog
          image={images[selectedIndex]}
          images={images}
          initialIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}

/** A Markdown image keeps its remote source, but receives the same stable
 * loading/error surface and full-screen viewer as an attached image. */
export function MarkdownImagePreview({
  src,
  name,
  openUrl,
  message,
  filePath,
  sourceOffset,
}: {
  src: string;
  name: string;
  openUrl?: string;
  message?: MessageAttachmentContext;
  filePath?: string;
  sourceOffset?: number;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const threadId = message?.threadId;
  const messageId = message?.messageId;
  const localSourceOffset = typeof sourceOffset === "number" && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0
    ? sourceOffset
    : null;
  const localMessageImage = Boolean(
    filePath && threadId && messageId && localSourceOffset !== null,
  );
  const localImageKey = localMessageImage ? `${threadId}\u0000${messageId}\u0000${localSourceOffset}` : null;
  const [visibleLocalImageKey, setVisibleLocalImageKey] = useState<string | null>(null);
  const external = !filePath && isExternalImageSource(src);
  const [approvedExternalSource, setApprovedExternalSource] = useState<string | null>(null);

  useEffect(() => {
    if (!localImageKey) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisibleLocalImageKey(localImageKey);
      return;
    }
    setVisibleLocalImageKey(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisibleLocalImageKey(localImageKey);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [localImageKey]);

  const shouldLoadLocalImage = localMessageImage && (visibleLocalImageKey === localImageKey || open);
  const externalAllowed = !external || approvedExternalSource === src;
  const visibleSource = externalAllowed
    ? localMessageImage
      ? shouldLoadLocalImage && filePath && threadId && messageId && localSourceOffset !== null
        ? messageImagePreviewUrl({ threadId, messageId }, localSourceOffset)
        : null
      : src
    : null;
  const image: PreviewImage = {
    src: visibleSource ?? "",
    name,
    openUrl,
    downloadUrl: localMessageImage ? visibleSource ?? undefined : undefined,
    downloadName: localMessageImage
      ? canonicalDownloadFilename({ fallback: name, source: filePath })
      : undefined,
  };
  return (
    <>
      <span ref={containerRef} className="my-2 block w-[min(36rem,70vw)] max-w-full">
        {external && !externalAllowed ? (
          <span className="flex aspect-[4/3] max-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset px-4 text-center text-[12px] text-ink-secondary">
            <ImageOff size={20} />
            <span>{t("attach.externalHidden")}</span>
            <button type="button" className="rounded-md border border-hairline/50 bg-panel px-2.5 py-1 text-ink hover:bg-raised" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setApprovedExternalSource(src); }}>{t("attach.loadImage")}</button>
          </span>
        ) : filePath && (!threadId || !messageId || localSourceOffset === null) ? (
          <span className="flex aspect-[4/3] max-h-96 items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset text-[12px] text-ink-secondary" role="alert">
            <ImageOff size={17} /> {t("attach.oldImage")}
          </span>
        ) : visibleSource ? (
          <Thumbnail key={image.src} image={image} onPreview={() => setOpen(true)} className="max-h-96" eager />
        ) : (
          <span className="flex aspect-[4/3] max-h-96 animate-pulse items-center justify-center rounded-xl border border-hairline/40 bg-inset" role="status">
            <LoaderCircle size={17} className="animate-spin text-ink-secondary/65" />
            <span className="sr-only">Loading {name}</span>
          </span>
        )}
        {openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-[11px] text-accent hover:underline">
            Open original
          </a>
        )}
      </span>
      {open && visibleSource && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </>
  );
}

function AttachedFileChip({ file, message }: { file: TranscriptFileAttachment; message?: MessageAttachmentContext }) {
  const save = useLocalFileSave(file.path, file.name, message);
  const failed = save.state === "failed";
  if (!message || !file.private) {
    return (
      <div title={t("attach.legacyFile", { name: file.name })} className="flex max-w-[280px] items-center gap-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-2 text-[12px] text-ink-secondary">
        <FileText size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
        <span className="text-[10.5px]">{t("attach.unavailable")}</span>
      </div>
    );
  }
  return (
    <div
      title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
      className="max-w-[280px] overflow-hidden rounded-lg border border-hairline/40 bg-inset/70 text-[12px] text-ink-secondary"
    >
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        aria-label={
          failed
            ? t("attach.retrySaveAria", { name: file.name })
            : t("attach.saveAria", { name: file.name })
        }
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-raised/70 disabled:cursor-wait"
      >
        <FileText size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
        {save.state === "saving" ? (
          <LoaderCircle size={13} className="shrink-0 animate-spin" />
        ) : save.state === "saved" ? (
          <Check size={13} className="shrink-0 text-success" />
        ) : save.state === "failed" ? (
          <RotateCcw size={13} className="shrink-0 text-danger" />
        ) : (
          <Download size={13} className="shrink-0" />
        )}
      </button>
      {save.state !== "idle" && (
        <div
          role={failed ? "alert" : "status"}
          className={cn(
            "border-t border-hairline/30 px-2.5 py-1.5 text-[10.5px]",
            failed ? "text-danger" : save.state === "saved" ? "text-success" : "text-ink-secondary",
          )}
        >
          {save.state === "saving"
            ? t("attach.downloading")
            : save.state === "saved"
              ? t("attach.downloaded")
              : save.reason}
        </div>
      )}
    </div>
  );
}

/** Transcript file paths stay inert until the person explicitly asks the
 * desktop shell to validate and save a copy. */
export function AttachedFileChips({ files, className, message }: { files: TranscriptFileAttachment[]; className?: string; message?: MessageAttachmentContext }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-1.5", className)}>
      {files.map((file, index) => (
        <AttachedFileChip key={`${file.path}:${index}`} file={file} message={message} />
      ))}
    </div>
  );
}
