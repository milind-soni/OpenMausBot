import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { t } from "@/lib/i18n";
import { SLOT, SettingsRows } from "../SettingsPrimitives";

/** A card waiting on its place: two rows at their final height, after 200 ms; a line after 8 s. */
export function SettingsSkeletonCard({ place }: { place: string }) {
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const show = window.setTimeout(() => setShown(true), 200);
    const late = window.setTimeout(() => setSlow(true), 8_000);
    return () => { window.clearTimeout(show); window.clearTimeout(late); };
  }, []);
  return (
    <div data-settings-skeleton="" aria-busy="true" className={shown ? undefined : "invisible"}>
      <SettingsRows>
        <SkeletonRow /><SkeletonRow />
        {slow && <div role="status" className="px-4 py-3 text-[13px] leading-[18px] text-ink-secondary">{t("settings.state.stillLoading", { place })}</div>}
      </SettingsRows>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div data-settings-skeleton-row="" className="flex min-h-16 flex-col justify-center gap-2 px-4 py-3">
      <span className="h-3 w-2/5 rounded-[4px] bg-ink/[0.06]" />
      <span className="h-2 w-[65%] rounded-[4px] bg-ink/[0.06]" />
    </div>
  );
}

/** A section's own loading state inside its card: two skeleton rows at their final height, never a spinner (§6.11). */
export function SettingsSkeletonRows() {
  return <div aria-busy="true" className="contents"><SkeletonRow /><SkeletonRow /></div>;
}

/** The place didn't answer: one card at the top of its pages; your account and this app keep working. */
export function SettingsUnreachable({ place, onRetry }: { place: string; onRetry: () => void }) {
  return (
    <SettingsRows icons>
      <div role="alert" data-settings-unreachable="" className="flex min-h-11 items-center gap-3 px-4 py-3">
        <span className={SLOT}><AlertTriangle size={16} aria-hidden="true" className="text-warning" /></span>
        <span className="min-w-0 flex-1 text-[14px] leading-5 text-ink">{t("settings.state.unreachable", { place })}</span>
        <button type="button" className="ui-button ui-button-md -my-1 shrink-0 rounded-full" onClick={onRetry}>{t("settings.state.tryAgain")}</button>
      </div>
    </SettingsRows>
  );
}
