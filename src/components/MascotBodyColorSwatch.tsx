import { useRef } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MAUS_COLORS } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import type { AvatarPatch } from "./avatar-editing";

const RAINBOW = "conic-gradient(#ff3b30, #ff9500, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30)";

/** The last colour swatch: a rainbow ring that opens the system colour picker and tints only the avatar body. */
export function MascotBodyColorSwatch({ bot, disabled, onPatch, className, selectedClassName, holeClassName }: {
  bot: Pick<Bot, "color" | "mascotBodyColor">;
  disabled: boolean;
  onPatch: (patch: AvatarPatch) => void;
  /** Size of the swatch, matching the named swatches beside it. */
  className: string;
  /** The ring the selected named swatch wears. */
  selectedClassName: string;
  /** The surface behind the swatch, shown inside the ring until a colour is picked. */
  holeClassName: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const custom = bot.mascotBodyColor;
  const open = () => {
    const picker = input.current;
    if (!picker) return;
    try { picker.showPicker(); } catch { picker.click(); }
  };
  return (
    <>
      <button
        type="button"
        data-avatar-body-color
        disabled={disabled}
        aria-pressed={Boolean(custom)}
        aria-label={t("mascot.useCustomColor")}
        title={t("mascot.useCustomColor")}
        onClick={open}
        className={cn("rounded-full p-[3px] disabled:opacity-50", className, custom && selectedClassName)}
        style={{ background: RAINBOW }}
      >
        <span className={cn("block size-full rounded-full", !custom && holeClassName)} style={custom ? { background: custom } : undefined} />
      </button>
      <input
        ref={input}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        value={custom ?? MAUS_COLORS[bot.color].toLowerCase()}
        onChange={(event) => onPatch({ mascotBodyColor: event.target.value.toLowerCase() })}
      />
    </>
  );
}
