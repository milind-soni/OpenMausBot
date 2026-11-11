import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { useSettingsShell } from "./settings-shell";

/** A section Advanced mode adds. In Simple it shows only when search or a link asked for it, and then says so, with the
 * way to keep it; the mode never changes by itself. */
export function AdvancedSection({ anchor, children }: { anchor: string; children: ReactNode }) {
  const { ctx, anchor: asked } = useSettingsShell();
  if (ctx.advanced) return <>{children}</>;
  if (asked !== anchor) return null;
  return (
    <div data-settings-from-search={anchor} className="flex flex-col gap-2">
      <p className="px-4 text-[12px] leading-4 text-ink-secondary">
        {t("settings.search.advancedNote")}{" "}
        <button type="button" className="cursor-pointer text-accent-text hover:underline" onClick={() => setAdvancedMode(true)}>{t("settings.search.turnOnAdvanced")}</button>
      </p>
      {children}
    </div>
  );
}
