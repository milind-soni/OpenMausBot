import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { canCopyImage, copyImage } from "@/lib/copy-image";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";

/** Sits beside Download in the image preview; hidden where the clipboard cannot take images. */
export function CopyImageButton({ src, name }: { src: string; name: string }) {
  const { state, copy } = useCopyFeedback(src, copyImage);
  if (!canCopyImage()) return null;
  const label = state === "copied"
    ? t("attach.imageCopied")
    : state === "failed"
      ? t("attach.copyImageFailed")
      : t("attach.copyImage");
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "flex size-9 items-center justify-center rounded-lg hover:bg-white/10 hover:text-white",
        state === "failed" ? "text-red-300" : "text-white/65",
      )}
      aria-label={state === "idle" ? t("attach.copyImageAria", { name }) : label}
      title={label}
    >
      {state === "copied" ? <Check size={17} /> : <Copy size={17} />}
    </button>
  );
}
