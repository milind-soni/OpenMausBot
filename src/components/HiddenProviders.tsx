import { useEffect, useState } from "react";

import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { InstanceProviderMark } from "./ProviderIcons";
import { SettingsMark } from "./SettingsPrimitives";

/** A provider someone hid: the server leaves it out of /api/instances and every model list (withInstanceConfig), so
 * these lists are the only way back to it. */
export interface HiddenProvider { instanceId: string; driverKind?: string; displayName: string }

/** GET /api/instances/hidden, read again whenever the instance list changes (a Hide or an Unhide refreshes it). */
export function useHiddenProviders(): HiddenProvider[] {
  const { state } = useStore();
  const [hidden, setHidden] = useState<HiddenProvider[]>([]);
  useEffect(() => {
    let alive = true;
    // An older server has no such route: nothing is hidden there.
    api<{ instances?: HiddenProvider[] } | undefined>("/api/instances/hidden")
      .then((result) => { if (alive) setHidden(Array.isArray(result?.instances) ? result.instances : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [state.instances]);
  return hidden;
}

function useUnhide() {
  const { refreshInstances } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unhide = (instanceId: string) => {
    setBusy(instanceId);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "PATCH", body: JSON.stringify({ hidden: false }) })
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  return { busy, error, unhide };
}

/** The hidden providers as the last rows of Settings → AI → More providers: each with its mark, a status saying it is
 * hidden, and Unhide. */
export function HiddenProviderRows({ hidden }: { hidden: HiddenProvider[] }) {
  const { busy, error, unhide } = useUnhide();
  if (hidden.length === 0) return null;
  return <>
    <div data-hidden-engines="" className="px-4 pb-1 pt-3 text-[12px] font-medium text-ink-secondary">{t("engines.hiddenTitle", { count: String(hidden.length) })}</div>
    {hidden.map((entry) => (
      <div key={entry.instanceId} data-hidden-engine={entry.instanceId} className="flex min-h-11 items-center gap-3 px-4 py-1.5">
        <SettingsMark><InstanceProviderMark instance={{ driverKind: entry.driverKind ?? "" }} size={18} subtle /></SettingsMark>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] leading-5 text-ink">{entry.displayName}</span>
          <span className="truncate text-[13px] leading-[18px] text-ink-secondary">{t("settings.ai.hiddenStatus")}</span>
        </span>
        <button type="button" data-unhide-engine={entry.instanceId} disabled={busy !== null} onClick={() => unhide(entry.instanceId)} aria-label={t("engines.unhideAria", { name: entry.displayName })} className="ui-button ml-3 shrink-0 disabled:opacity-50">
          {busy === entry.instanceId ? t("engines.unhiding") : t("engines.unhide")}
        </button>
      </div>
    ))}
    {error && <p role="alert" className="px-4 pb-2 text-[12px] text-danger">{error}</p>}
  </>;
}

/** Providers someone hid, for the full engines page: listed apart, folded, each one click from coming back. */
export function HiddenEngines() {
  const hidden = useHiddenProviders();
  const { busy, error, unhide } = useUnhide();
  if (hidden.length === 0) return null;
  return (
    <details data-hidden-engines className="px-4">
      <summary className="cursor-pointer text-[13px] font-medium text-ink-secondary hover:text-ink">{t("engines.hiddenTitle", { count: String(hidden.length) })}</summary>
      <p className="mt-2 text-[12px] text-ink-secondary">{t("engines.hiddenHint")}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {hidden.map((entry) => (
          <div key={entry.instanceId} className="flex items-center justify-between gap-3 rounded-lg bg-control px-3 py-2">
            <span className="min-w-0 truncate text-[13px] text-ink">{entry.displayName}</span>
            <button type="button" data-unhide-engine={entry.instanceId} disabled={busy !== null} onClick={() => unhide(entry.instanceId)} aria-label={t("engines.unhideAria", { name: entry.displayName })}
              className="shrink-0 text-[12px] font-medium text-accent hover:underline disabled:opacity-50">
              {busy === entry.instanceId ? t("engines.unhiding") : t("engines.unhide")}
            </button>
          </div>
        ))}
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
    </details>
  );
}
