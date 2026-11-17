import type { ReactNode } from "react";
import { ArrowLeft, Circle, RotateCcw } from "lucide-react";
import { t } from "@/lib/i18n";
import type { PhoneKey } from "@/lib/phone-stream-client";

export type UnitPoint = { x: number; y: number };

/** Where a pointer falls on a picture fitted (`object-contain`) inside `bounds`, as fractions of the picture: null
 * outside it, unless clamped to its edge. */
export function fittedUnitPoint(
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  picture: { width: number; height: number },
  pointer: { clientX: number; clientY: number },
  clampToPicture = false,
): UnitPoint | null {
  if (!picture.width || !picture.height) return null;
  const scale = Math.min(bounds.width / picture.width, bounds.height / picture.height);
  const fittedWidth = picture.width * scale;
  const fittedHeight = picture.height * scale;
  const left = bounds.left + (bounds.width - fittedWidth) / 2;
  const top = bounds.top + (bounds.height - fittedHeight) / 2;
  const x = (pointer.clientX - left) / fittedWidth;
  const y = (pointer.clientY - top) / fittedHeight;
  if (clampToPicture) {
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export const ANDROID_KEY_NAMES: Readonly<Record<string, PhoneKey>> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Backspace: "delete",
  Delete: "delete",
  Enter: "enter",
  Escape: "back",
  Tab: "tab",
};

export function AndroidKeyButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50 disabled:hover:bg-raised"
    >
      {children}
    </button>
  );
}

export function AndroidNavButtons({ onKey, disabled }: { onKey: (key: "back" | "home" | "recent") => void; disabled?: boolean }) {
  return (
    <>
      <AndroidKeyButton onClick={() => onKey("back")} disabled={disabled}>
        <ArrowLeft size={13} /> {t("computer.android.back")}
      </AndroidKeyButton>
      <AndroidKeyButton onClick={() => onKey("home")} disabled={disabled}>
        <Circle size={12} /> {t("computer.android.home")}
      </AndroidKeyButton>
      <AndroidKeyButton onClick={() => onKey("recent")} disabled={disabled}>
        <RotateCcw size={13} /> {t("computer.android.recent")}
      </AndroidKeyButton>
    </>
  );
}
