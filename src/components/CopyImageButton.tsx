import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { canCopyImage, copyImage } from "@/lib/copy-image";
import { useCopyFeedback } from "@/lib/copy-text";
import { MENU_ITEM } from "./menu-recipe";
import { t } from "@/lib/i18n";

export function CopyImageButton({ src, name }: { src: string; name: string }) {
  const { state, copy } = useCopyFeedback(src, copyImage);
  const supported = canCopyImage();
  const label = state === "copied"
    ? t("attach.imageCopied")
    : state === "failed"
      ? t("attach.copyImageFailed")
      : t("attach.copyImage");
  return (
    <button
      type="button"
      onClick={copy}
      disabled={!supported}
      className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover disabled:opacity-50")}
      aria-label={state === "idle" ? t("attach.copyImageAria", { name }) : label}
      title={label}
    >
      {state === "copied" ? <Check size={17} /> : <Copy size={17} />}
      <span className="min-w-0 truncate" aria-live="polite">{label}</span>
    </button>
  );
}
