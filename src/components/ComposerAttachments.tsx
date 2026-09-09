// Chips for what is attached to the next message, plus the window-wide
// file drop that creates them. A long paste collapses into a card of its
// first lines instead of flooding the composer; a file dropped anywhere
// on the window attaches by path.
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, File as FileIcon, Image as ImageIcon, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  attachmentImageUrl,
  intakeFiles,
  formatSize,
  pasteSummary,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { AttachmentPreviewDialog, previewImage, type PreviewImage } from "./AttachmentPreview";

/** Electron 32 removed File.path — only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

/** Renders pending attachments and their composer actions. */
export function ComposerAttachments({
  items,
  onAdd,
  onRemove,
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
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  allowImages?: boolean;
  notice: string | null;
  onNotice: (notice: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
  uploadImage: (file: File) => Promise<Attachment | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  // dragenter/dragleave fire once per element crossed, so the overlay
  // tracks depth rather than the last event it happened to see
  const depth = useRef(0);
  const callbacks = useRef({ onAdd, onNotice, onPendingChange, allowImages, uploadImage });
  callbacks.current = { onAdd, onNotice, onPendingChange, allowImages, uploadImage };
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
    // without preventDefault the window navigates to the dropped file and
    // the app is simply gone
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      // Same intake the attach button uses: a dropped file and a picked one
      // must not appear in a different order.
      const operation = Symbol("attachment-drop");
      pendingDrops.current.add(operation);
      callbacks.current.onPendingChange?.(true);
      try {
        const { attachments, notice: message } = await intakeFiles(files, {
          allowImages: callbacks.current.allowImages,
          getPath: pathForFile,
          uploadImage: callbacks.current.uploadImage,
        });
        if (attachments.length) callbacks.current.onAdd(attachments);
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
            Drop to attach
          </div>
        </div>
      )}

      {notice && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            onClick={() => onNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {items.map((a) =>
            a.kind === "paste" ? (
              <Chip
                key={a.id}
                label="PASTED"
                title={a.text.slice(0, 4000)}
                onRemove={() => onRemove(a.id)}
              >
                <div className="relative h-[76px] overflow-hidden">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-ink-secondary">
                    {a.text.slice(0, 400)}
                  </pre>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-raised" />
                </div>
                <div className="mt-1 text-[10.5px] text-ink-secondary/70">{pasteSummary(a)}</div>
                <button
                  type="button"
                  onClick={() => onDisplayInChatBox(a)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1.5 text-[10.5px] font-medium text-accent-text transition-colors hover:border-accent/50 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  aria-label="Display pasted text in chat box"
                  title="Display in chat box"
                >
                  <MessageSquareText size={12} aria-hidden="true" />
                  <span>Display in chat box</span>
                </button>
              </Chip>
            ) : a.kind === "image" ? (
              <Chip key={a.id} label="IMAGE" title={a.name} onRemove={() => onRemove(a.id)}>
                <button
                  type="button"
                  onClick={() => {
                    const image = previewImage(a.path, a.name);
                    const src = image?.src ?? a.previewUrl;
                    if (src) setPreview(image ?? { src, name: a.name });
                  }}
                  disabled={!attachmentImageUrl(a.path) && !a.previewUrl}
                  aria-busy={a.uploading || undefined}
                  className="relative flex h-[76px] w-full items-center justify-center overflow-hidden rounded-lg bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default"
                  aria-label={`Preview ${a.name}`}
                >
                  <img
                    src={attachmentImageUrl(a.path) ?? a.previewUrl}
                    alt={a.name}
                    loading="eager"
                    fetchPriority="high"
                    className="max-h-[76px] max-w-full object-contain"
                  />
                  {a.uploading && (
                    <span className="absolute bottom-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-black/65 text-white shadow-sm">
                      <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                    </span>
                  )}
                </button>
                <div className="mt-1 truncate text-[10.5px] text-ink-secondary/70">
                  {a.uploading ? "Uploading…" : formatSize(a.size)}
                </div>
              </Chip>
            ) : (
              <Chip key={a.id} label="FILE" title={a.path} onRemove={() => onRemove(a.id)}>
                <div className="flex h-[76px] items-center gap-2">
                  <FileIcon size={16} className="shrink-0 text-ink-secondary" />
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink">{a.name}</div>
                    <div className="text-[10.5px] text-ink-secondary/70">{formatSize(a.size)}</div>
                  </div>
                </div>
              </Chip>
            ),
          )}
        </div>
      )}
      {preview && <AttachmentPreviewDialog image={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function Chip({
  children,
  label,
  title,
  onRemove,
}: {
  children: React.ReactNode;
  label: "PASTED" | "FILE" | "IMAGE";
  title: string;
  onRemove: () => void;
}) {
  const Icon = label === "PASTED" ? ClipboardPaste : label === "IMAGE" ? ImageIcon : FileIcon;
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
        <Icon size={11} className="text-ink-secondary/70" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
          {label}
        </span>
      </div>
      {/* hover reveals it, but so must focus: `hidden` would take the only
          way to drop a chip out of reach of the keyboard */}
      <button
        onClick={onRemove}
        aria-label={`Remove ${label === "PASTED" ? "pasted text" : "file"}`}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}
