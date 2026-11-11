import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { appVersion } from "@/lib/app-links";
import type { SettingsPlace } from "./settings-context";
import type { SettingsContext, SettingsPage } from "./settings-index";
import { AppIcon, PlaceBadge, YouAvatar, pageLabel } from "./SettingsNav";

const INTRO: Partial<Record<SettingsPage["id"], Parameters<typeof t>[0]>> = {
  bots: "settings.bots.intro",
  desktops: "settings.desktops.intro",
  vault: "settings.vault.intro",
  app: "settings.app.intro",
};

/** "For My Cloud" with "For" quiet and the place's name in ink, in any word order a language needs. */
function forPlace(place: string): ReactNode {
  const mark = "⁣";
  const [before = "", after = ""] = t("settings.scope.for", { place: mark }).split(mark);
  return <>{before && <span className="text-ink-secondary">{before}</span>}<span className="text-ink">{place}</span>{after && <span className="text-ink-secondary">{after}</span>}</>;
}

function everyPlace(ctx: SettingsContext): ReactNode {
  return ctx.places && ctx.desktop ? <span className="text-ink-secondary"> · {t("settings.scope.everyPlace")}</span> : null;
}

export function overviewStatus(place: SettingsPlace): string {
  const version = t("settings.overview.version", { version: appVersion() });
  if (place.kind === "computer") return `${version} · ${t("settings.overview.updatesWithApp")}`;
  return `${place.kind === "server" ? t("settings.place.running") : t("settings.place.alwaysOn")} · ${version}`;
}

export function ScopeLine({ page, ctx, place }: { page: SettingsPage; ctx: SettingsContext; place: SettingsPlace }) {
  if (page.id === "overview") {
    return (
      <p data-settings-scope="" className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink-secondary">
        {place.kind !== "computer" && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />}
        {overviewStatus(place)}
      </p>
    );
  }
  const badge = page.owner === "place" ? <PlaceBadge place={place} size={14} /> : page.owner === "account" ? <YouAvatar size={14} /> : <AppIcon size={14} />;
  const text = page.owner === "place" ? forPlace(place.name)
    : page.owner === "account"
      ? ctx.desktop ? <><span className="text-ink">{t("settings.scope.account", { app: productName() })}</span>{everyPlace(ctx)}</> : <span className="text-ink-secondary">{t("settings.scope.browserAccount", { place: place.name })}</span>
      // This app's settings are still kept per place's page until they follow the device (S1), so its line makes no
      // "same on every place" promise yet; Your account's does, because the account is one.
      : ctx.desktop ? <span className="text-ink">{t("settings.scope.app", { app: productName() })}</span> : <span className="text-ink-secondary">{t("settings.scope.browser")}</span>;
  return (
    <p data-settings-scope="" className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px]">
      <span className="flex size-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[4px]">{badge}</span>
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}

export function SettingsPageHeader({ page, ctx, place, scrolled, narrow, missing }: {
  page: SettingsPage; ctx: SettingsContext; place: SettingsPlace; scrolled: boolean; narrow: boolean; missing?: string;
}) {
  // A browser has no updates of its own, so its This app intro leaves them out.
  const intro = page.id !== "app" ? INTRO[page.id]
    : !ctx.desktop ? ctx.advanced ? "settings.app.introBrowserAdvanced" : "settings.app.introBrowser"
    : ctx.advanced ? INTRO.app : "settings.app.introSimple";
  const title = page.id === "account" ? t("settings.page.account") : pageLabel(page, place, ctx.desktop);
  return (
    <header data-settings-header="" className={cn("sticky top-0 z-10 flex flex-col gap-1 bg-(--settings-sheet) pb-5", narrow ? "px-8 pt-1" : "pl-4 pt-4",
      scrolled && "shadow-[0_0.5px_0_var(--settings-edge)]")}>
      {!narrow && <h2 id="settings-page-title" className="truncate pr-12 text-[18px] font-semibold leading-6 tracking-[-0.01em] text-ink">{title}</h2>}
      <ScopeLine page={page} ctx={ctx} place={place} />
      {intro && <p data-settings-intro={intro} className="text-[13px] leading-[18px] text-ink-secondary">{t(intro, { place: place.name, app: productName() })}</p>}
      {missing && <p role="status" className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.missingHere", { page: missing, place: place.name })}</p>}
    </header>
  );
}
