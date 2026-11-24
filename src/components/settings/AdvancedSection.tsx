import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { SettingsTag } from "../SettingsPrimitives";
import { pageById } from "./settings-index";
import { useSettingsShell } from "./settings-shell";

export function AdvancedSettingTag() {
  return <SettingsTag>{t("settings.advancedSetting")}</SettingsTag>;
}

/** A section Advanced mode adds. In Simple it shows only while search, a link or a notice asks for it, marked as
 * an Advanced setting, and the app stays in Simple mode. */
export function AdvancedSection({ anchor, also = [], children }: { anchor: string; also?: string[]; children: ReactNode }) {
  const { ctx, page, anchor: asked } = useSettingsShell();
  if (ctx.advanced) return <>{children}</>;
  if (asked !== anchor && !(asked && also.includes(asked))) return null;
  if (!pageById(page).when(ctx)) return <>{children}</>;
  return (
    <div data-settings-peek={anchor} className="flex flex-col gap-2">
      <div className="px-4"><AdvancedSettingTag /></div>
      {children}
    </div>
  );
}
