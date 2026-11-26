import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { MascotMaterial } from "../../shared/bot-avatar";
import { engineBody } from "../../shared/object-bodies";
import type { AvatarPatch } from "./avatar-editing";
import { Segmented } from "./bot-panel/rows";

const FINISHES: readonly ("off" | MascotMaterial)[] = ["off", "matte", "metallic", "fluffy"];

/** The finish of the engine-drawn bodies; the cursor and festival bodies are always flat, so the row hides for them. */
export function MascotMaterialPicker({ bot, disabled, onPatch }: {
  bot: Bot;
  disabled: boolean;
  onPatch: (patch: AvatarPatch) => void;
}) {
  if (!engineBody(bot.mascotBody)) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[12px] text-ink-secondary">{t("botIdentity.material")}</div>
      <Segmented
        attr="data-avatar-material"
        label={t("botIdentity.material")}
        value={bot.mascotMaterial ?? "off"}
        onChange={(value) => onPatch({ mascotMaterial: value === "off" ? null : value })}
        options={FINISHES.map((value) => ({ value, label: t(`botIdentity.material.${value}`), disabled }))}
      />
    </div>
  );
}
