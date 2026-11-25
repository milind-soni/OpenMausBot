import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { SettingsTag } from "../SettingsPrimitives";
import { pageById } from "./settings-index";
import { useSettingsShell } from "./settings-shell";

export function AdvancedSettingTag() {
  return <SettingsTag>{t("settings.advancedSetting")}</SettingsTag>;
}

function Marked({ anchor, children }: { anchor: string; children: ReactNode }) {
  return (
    <div data-settings-peek={anchor} className="flex flex-col gap-2">
      <div className="px-4"><AdvancedSettingTag /></div>
      {children}
    </div>
  );
}

function useAsked(anchor: string, also: string[]) {
  const { ctx, page, anchor: asked } = useSettingsShell();
  return { ctx, listed: pageById(page).when(ctx), asked, matches: asked === anchor || Boolean(asked && also.includes(asked)) };
}

/** A section Advanced mode adds. In Simple it shows only while search, a link or a notice asks for it, marked as
 * an Advanced setting, and the app stays in Simple mode. */
export function AdvancedSection({ anchor, also = [], children }: { anchor: string; also?: string[]; children: ReactNode }) {
  const { ctx, matches } = useAsked(anchor, also);
  if (ctx.advanced) return <>{children}</>;
  return matches ? <Marked anchor={anchor}>{children}</Marked> : null;
}

/** A section of a page only Advanced lists. Opened from Simple at one section, only that section shows, marked;
 * opened as a page, the page shows whole. */
export function AdvancedPagePart({ anchor, also = [], children }: { anchor: string; also?: string[]; children: ReactNode }) {
  const { ctx, listed, asked, matches } = useAsked(anchor, also);
  if (ctx.advanced || listed || !asked) return <>{children}</>;
  return matches ? <Marked anchor={anchor}>{children}</Marked> : null;
}
