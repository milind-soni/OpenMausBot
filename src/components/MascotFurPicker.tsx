import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { MASCOT_FURS } from "../../shared/bot-avatar";
import { engineBody } from "../../shared/object-bodies";
import type { AvatarPatch } from "./avatar-editing";
import { Segmented } from "./bot-panel/rows";

/** Fur for the engine-drawn bodies; the cursor and festival bodies have none, so the row hides for them. */
export function MascotFurPicker({ bot, disabled, onPatch }: {
  bot: Bot;
  disabled: boolean;
  onPatch: (patch: AvatarPatch) => void;
}) {
  if (!engineBody(bot.mascotBody)) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[12px] text-ink-secondary">{t("botIdentity.fur")}</div>
      <Segmented
        attr="data-avatar-fur"
        label={t("botIdentity.fur")}
        value={bot.mascotFur ?? "off"}
        onChange={(value) => onPatch({ mascotFur: value === "off" ? null : value })}
        options={(["off", ...MASCOT_FURS] as const).map((value) => ({ value, label: t(`botIdentity.fur.${value}`), disabled }))}
      />
    </div>
  );
}
