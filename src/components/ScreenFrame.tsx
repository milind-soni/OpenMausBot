// A frame of the bot's computer in the transcript. The frame is a screenshot
// the user often needs to actually read, so it opens in the same viewer as
// attached images rather than sitting as an inert thumbnail-sized <img>.
import { useState } from "react";
import { ZoomIn } from "lucide-react";

import { AttachmentPreviewDialog, type PreviewImage } from "@/components/AttachmentPreview";
import { t } from "@/lib/i18n";

/** The viewer entry for one frame; the data URL doubles as its download. */
export function screenFramePreview(png: string, mime = "image/png"): PreviewImage {
  const src = `data:${mime};base64,${png}`;
  return {
    src,
    name: t("chat.botScreen"),
    downloadUrl: src,
    downloadName: mime === "image/jpeg" ? "screen.jpg" : "screen.png",
  };
}

export function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  const [open, setOpen] = useState(false);
  const image = screenFramePreview(png, mime);
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("attach.previewAria", { name: image.name })}
        className="group/image relative w-fit max-w-[min(42rem,78%)] overflow-hidden rounded-2xl border border-hairline/40 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <img
          src={image.src}
          alt={image.name}
          className="block max-w-full transition duration-200 group-hover/image:scale-[1.015]"
        />
        <span
          aria-hidden
          className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-within/image:opacity-100"
        >
          <ZoomIn size={13} />
        </span>
      </button>
      {open && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </div>
  );
}
