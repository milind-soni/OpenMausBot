import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SKINS, THEME_SKINS, applySkinChoice, readSkinChoice, subscribeSkin, type SkinChoice } from "@/lib/skins";
import { SettingRow } from "./SettingsPrimitives";

const THEMES = [
  { choice: "system", label: "settings.theme.system" },
  { choice: THEME_SKINS.light, label: "settings.theme.light" },
  { choice: THEME_SKINS.dark, label: "settings.theme.dark" },
] as const satisfies readonly { choice: SkinChoice; label: string }[];

export function useSkinChoice(): SkinChoice {
  return useSyncExternalStore(subscribeSkin, readSkinChoice, readSkinChoice);
}

export function ThemeRow() {
  const choice = useSkinChoice();
  const look = THEMES.some((theme) => theme.choice === choice) ? undefined : SKINS.find((skin) => skin.id === choice)?.name;
  return (
    <SettingRow
      title={t("settings.theme.title")}
      subtitle={look ? t("settings.theme.look", { name: look }) : t("settings.theme.subtitle")}
    >
      <div role="radiogroup" aria-label={t("settings.theme.title")} className="inline-flex rounded-full bg-inset p-0.5">
        {THEMES.map((theme) => (
          <button
            key={theme.choice}
            type="button"
            role="radio"
            aria-checked={choice === theme.choice}
            onClick={() => applySkinChoice(theme.choice)}
            className={cn(
              "rounded-full px-3 py-1 text-[13px] font-medium transition-colors",
              choice === theme.choice ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t(theme.label)}
          </button>
        ))}
      </div>
    </SettingRow>
  );
}
