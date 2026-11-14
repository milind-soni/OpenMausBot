import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { MASCOT_FACE_COLORS } from "../../shared/bot-avatar";
import type { AvatarPatch } from "./avatar-editing";
import { Segmented } from "./bot-panel/rows";

export function MascotFaceColorPicker({ bot, disabled, onPatch }: {
  bot: Bot;
  disabled: boolean;
  onPatch: (patch: AvatarPatch) => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px] text-ink-secondary">
        <span>{t("botIdentity.faceColor")}</span>
        {!bot.mascotFaceColor && <span className="text-ink-tertiary">{t("botIdentity.faceColor.default")}</span>}
      </div>
      <Segmented
        attr="data-avatar-face-color"
        label={t("botIdentity.faceColor")}
        value={bot.mascotFaceColor}
        onChange={(mascotFaceColor) => onPatch({ mascotFaceColor })}
        options={MASCOT_FACE_COLORS.map((value) => ({ value, label: t(`botIdentity.faceColor.${value}`), disabled }))}
      />
    </div>
  );
}
