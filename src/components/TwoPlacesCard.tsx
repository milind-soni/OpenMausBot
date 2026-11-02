import { useState } from "react";
import { Loader2, Merge } from "lucide-react";
import { ipcErrorText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import type { TwoPlacesSuggestion } from "@/lib/two-places";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

/** Bots on this computer and on another place of the person's can't work together: one tap brings them together there
 * (the one-time move), Not now or the close button never asks again for that place. */
export function TwoPlacesCard({ suggest, onBring, onDismiss }: { suggest: TwoPlacesSuggestion; onBring: () => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const bring = () => {
    if (busy) return;
    setBusy(true); setFailed(null);
    void onBring().catch((cause: unknown) => { setBusy(false); setFailed(ipcErrorText(cause) ?? t("twoPlaces.failed")); });
  };
  return <NoticeCard titleId="two-places-title" notice="two-places" icon={Merge} title={t("twoPlaces.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("twoPlaces.body", { place: suggest.name })}</p>
    {failed && <p role="alert" className="mb-3 text-[12px] text-danger">{failed}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" data-two-places-bring className={PRIMARY_BUTTON} disabled={busy} aria-busy={busy || undefined} onClick={bring}>
        {busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />}
        {t("twoPlaces.bring")}
      </button>
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}
