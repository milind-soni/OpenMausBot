import { CachedChatImage } from "./CachedChatImage";
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, FileText, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  attachmentImageUrl,
  intakeFiles,
  imageBytesLeft,
  imageSlotsLeft,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { AttachmentPreviewDialog, previewImage, type PreviewImage } from "./AttachmentPreview";
import { CitationBadge } from "./CitationUI";
import type { CitationAttachment } from "@/lib/citations";
import { t } from "@/lib/i18n";
import { attachNoticeText, pasteSummaryText } from "@/lib/attach-notice";

/** Electron 32 removed File.path — only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

export function ComposerAttachments({
  items,
  onAdd,
  onRemove,
  onChangeCitation,
  onDisplayInChatBox,
  allowImages = true,
  notice,
  onNotice,
  onPendingChange,
  uploadImage,
}: {
  items: Attachment[];
  onAdd: (attachments: Attachment[]) => void;
  onRemove: (id: string) => void;
  onChangeCitation: (citation: CitationAttachment) => void;
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  allowImages?: boolean;
  notice: string | null;
  onNotice: (notice: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
  uploadImage: (file: File) => Promise<Attachment | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  // dragenter/dragleave fire once per element crossed, so the overlay tracks depth.
  const depth = useRef(0);
  // A drop past the images the message can still take is left out with a notice.
  const imageSlots = imageSlotsLeft(items);
  const imageBytes = imageBytesLeft(items);
  const callbacks = useRef({ onAdd, onNotice, onPendingChange, allowImages, imageSlots, imageBytes, uploadImage });
  callbacks.current = { onAdd, onNotice, onPendingChange, allowImages, imageSlots, imageBytes, uploadImage };
  const pendingDrops = useRef(new Set<symbol>());

  useEffect(() => {
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    // Without preventDefault the window navigates to the dropped file.
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const operation = Symbol("attachment-drop");
      pendingDrops.current.add(operation);
      callbacks.current.onPendingChange?.(true);
      try {
        const { attachments, problems } = await intakeFiles(files, {
          allowImages: callbacks.current.allowImages,
          getPath: pathForFile,
          uploadImage: callbacks.current.uploadImage,
          imageSlots: callbacks.current.imageSlots,
          imageBytes: callbacks.current.imageBytes,
        });
        if (attachments.length) callbacks.current.onAdd(attachments);
        const message = attachNoticeText(problems);
        if (message) callbacks.current.onNotice(message);
      } finally {
        if (pendingDrops.current.delete(operation)) callbacks.current.onPendingChange?.(false);
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <>
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-10">
          <div className="rounded-2xl border-2 border-dashed border-accent/70 bg-panel/90 px-8 py-6 text-[14px] font-medium text-ink shadow-2xl">
            {t("composer.dropToAttach")}
          </div>
        </div>
      )}

      {notice && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            onClick={() => onNotice(null)}
            aria-label={t("composer.notice.dismiss")}
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-2 flex min-w-0 flex-wrap items-start gap-2">
          {items.map((a) =>
            a.kind === "citation" ? (
              <CitationBadge
                key={a.id}
                citation={a}
                onChange={onChangeCitation}
                onRemove={() => onRemove(a.id)}
                solid
              />
            ) : a.kind === "paste" ? (
              <PastedTextChip
                key={a.id}
                title={a.text.slice(0, 4000)}
                onRemove={() => onRemove(a.id)}
              >
                <div className="relative h-[76px] overflow-hidden">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.45] text-ink-secondary">
                    {a.text.slice(0, 400)}
                  </pre>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-raised" />
                </div>
                <div className="mt-1 text-[11px] text-ink-tertiary">{pasteSummaryText(a)}</div>
                <button
                  type="button"
                  onClick={() => onDisplayInChatBox(a)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1.5 text-[11px] font-medium text-accent-text transition-colors hover:border-accent/50 interaction:bg-raised/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  aria-label={t("composer.chip.displayLabel")}
                  title={t("composer.chip.display")}
                >
                  <MessageSquareText size={12} aria-hidden="true" />
                  <span>{t("composer.chip.display")}</span>
                </button>
              </PastedTextChip>
            ) : a.kind === "image" ? (
              <div key={a.id} className="group relative aspect-square w-16 max-w-full rounded-lg md:w-20 motion-safe:animate-fade-in">
                <button
                  type="button"
                  onClick={() => {
                    const image = previewImage(a.path, a.name);
                    const src = image?.src ?? a.previewUrl;
                    if (src) setPreview(image ?? { src, name: a.name });
                  }}
                  disabled={!attachmentImageUrl(a.path) && !a.previewUrl}
                  aria-busy={a.uploading || undefined}
                  className="relative block size-full overflow-hidden rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default"
                  aria-label={t("attach.previewAria", { name: a.name })}
                >
                  <CachedChatImage
                    src={attachmentImageUrl(a.path) ?? a.previewUrl}
                    alt={a.name}
                    loading="eager"
                    fetchPriority="high"
                    className="size-full object-cover"
                  />
                  {a.uploading && (
                    <span className="absolute bottom-1.5 end-1.5 flex size-6 items-center justify-center rounded-full bg-black/65 text-white shadow-sm">
                      <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(a.id)}
                  aria-label={t("composer.chip.removeFile")}
                  className="absolute end-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/65 text-white opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div key={a.id} className="flex min-h-[42px] max-w-full items-center gap-2 rounded-xl border border-hairline/25 px-2.5 text-[12px] text-ink-secondary">
                <FileText size={14} className="shrink-0" aria-hidden="true" />
                <span dir="auto" title={a.name} className="min-w-0 truncate text-ink">{a.name}</span>
                <button
                  type="button"
                  onClick={() => onRemove(a.id)}
                  aria-label={t("composer.chip.removeFile")}
                  title={t("composer.chip.removeFile")}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg interaction:bg-raised/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ),
          )}
        </div>
      )}
      {preview && <AttachmentPreviewDialog image={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function PastedTextChip({
  children,
  title,
  onRemove,
}: {
  children: React.ReactNode;
  title: string;
  onRemove: () => void;
}) {
  return (
    <div
      title={title}
      className={cn(
        "group relative w-[172px] rounded-xl border border-hairline/40 bg-raised px-2.5 py-2",
        "transition-colors hover:border-hairline",
      )}
    >
      {children}
      <div className="mt-1 flex items-center gap-1">
        <ClipboardPaste size={11} className="text-ink-tertiary" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[10px] font-medium tracking-wide text-ink-secondary">
          {t("composer.chip.pasted")}
        </span>
      </div>
      {/* Not `hidden`: that would take the only way to remove a chip out of the keyboard's reach. */}
      <button
        onClick={onRemove}
        aria-label={t("composer.chip.removePasted")}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}
