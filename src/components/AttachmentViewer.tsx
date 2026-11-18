import { useState, useEffect } from "react";
import { Download, File, FileCode, FileText, Image as ImageIcon, Maximize2, X } from "lucide-react";
import { formatFileSize, isImageAttachment, isTextFile } from "@/lib/attachments";
import type { Attachment } from "@/state/store";
import { cn } from "@/lib/cn";

function getFileIcon(att: Attachment) {
  if (isImageAttachment(att)) return ImageIcon;
  if (isTextFile(att.name, att.mimeType)) {
    const ext = att.name.split(".").pop()?.toLowerCase();
    if (ext && ["ts", "tsx", "js", "jsx", "py", "rs", "go", "c", "cpp", "java", "html", "css", "json", "sql"].includes(ext)) {
      return FileCode;
    }
    return FileText;
  }
  return File;
}

export function ImageModal({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-msg-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center overflow-hidden rounded-2xl border border-hairline/40 bg-raised shadow-2xl"
      >
        <div className="flex w-full items-center justify-between border-b border-hairline/30 bg-panel px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <ImageIcon size={16} className="shrink-0 text-ink-secondary" />
            <span className="truncate text-[13.5px] font-medium text-ink">{attachment.name}</span>
            <span className="text-xs text-ink-secondary">({formatFileSize(attachment.size)})</span>
          </div>
          <div className="flex items-center gap-2">
            {(attachment.dataUrl ?? attachment.url) && (
              <a
                href={attachment.dataUrl ?? attachment.url}
                download={attachment.name}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-raised px-2.5 py-1 text-xs font-medium text-ink hover:bg-raised-hover"
                title="Download image"
              >
                <Download size={13} />
                Download
              </a>
            )}
            <button
              onClick={onClose}
              aria-label="Close image preview"
              className="rounded-lg p-1 text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex max-h-[calc(90vh-50px)] max-w-full items-center justify-center overflow-auto p-2">
          <img
            src={attachment.dataUrl ?? attachment.url}
            alt={attachment.name}
            className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-sm"
          />
        </div>
      </div>
    </div>
  );
}

export function AttachmentList({
  attachments,
  className,
}: {
  attachments?: Attachment[];
  className?: string;
}) {
  const [selectedImage, setSelectedImage] = useState<Attachment | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter(isImageAttachment);
  const files = attachments.filter((a) => !isImageAttachment(a));

  return (
    <div className={cn("flex flex-col gap-2 my-1.5", className)}>
      {/* Images Grid */}
      {images.length > 0 && (
        <div
          className={cn(
            "grid gap-2",
            images.length === 1 ? "grid-cols-1" : images.length === 2 ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          {images.map((img) => (
            <div
              key={img.id}
              onClick={() => setSelectedImage(img)}
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-hairline/40 bg-panel transition-all hover:border-hairline hover:shadow-md"
            >
              <img
                src={img.dataUrl ?? img.url}
                alt={img.name}
                className="h-36 w-full object-cover transition-transform duration-200 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20" />
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                <div className="flex items-center justify-between text-white">
                  <span className="truncate text-xs font-medium">{img.name}</span>
                  <Maximize2 size={12} className="shrink-0 ml-1" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Non-image File Cards */}
      {files.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {files.map((file) => {
            const Icon = getFileIcon(file);
            return (
              <div
                key={file.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-left transition-colors hover:border-hairline hover:bg-raised-hover"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink">{file.name}</p>
                    <p className="text-[11px] text-ink-secondary">{formatFileSize(file.size)}</p>
                  </div>
                </div>
                {(file.dataUrl ?? file.url) && (
                  <a
                    href={file.dataUrl ?? file.url}
                    download={file.name}
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
                    title={`Download ${file.name}`}
                  >
                    <Download size={14} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectedImage && <ImageModal attachment={selectedImage} onClose={() => setSelectedImage(null)} />}
    </div>
  );
}

export function StagedAttachmentsTray({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2 rounded-2xl border border-hairline/40 bg-panel/80 p-2 backdrop-blur-sm animate-msg-in">
      {attachments.map((att) => {
        const isImg = isImageAttachment(att);
        const Icon = getFileIcon(att);
        return (
          <div
            key={att.id}
            className="group relative flex items-center gap-2 rounded-xl border border-hairline/40 bg-raised py-1.5 pl-2 pr-1.5 text-xs text-ink transition-all hover:border-hairline shadow-sm"
          >
            {isImg && (att.dataUrl ?? att.url) ? (
              <img src={att.dataUrl ?? att.url} alt={att.name} className="size-6 shrink-0 rounded object-cover" />
            ) : (
              <Icon size={15} className="shrink-0 text-ink-secondary" />
            )}
            <div className="max-w-[140px] truncate font-medium">
              <span className="truncate">{att.name}</span>
            </div>
            <span className="text-[10.5px] text-ink-secondary">({formatFileSize(att.size)})</span>
            <button
              onClick={() => onRemove(att.id)}
              aria-label={`Remove attachment ${att.name}`}
              className="ml-0.5 rounded-full p-0.5 text-ink-secondary hover:bg-raised-hover hover:text-ink"
              title="Remove attachment"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
