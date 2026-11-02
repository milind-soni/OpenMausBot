import { useState } from "react";
import { Loader2, Merge } from "lucide-react";
import { ipcErrorText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import type { TwoPlacesSuggestion } from "@/lib/two-places";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

/** Bots on this computer and on another place of the person's can't work together: the card offers to bring them
 * together there, and the one-time move starts only once the person confirms what it does; Cancel changes nothing.
 * Not now or the close button never asks again for that place. */
export function TwoPlacesCard({ suggest, onBring, onDismiss }: { suggest: TwoPlacesSuggestion; onBring: () => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Cancel removes the focused button, so focus goes back to "Bring them together" as it reappears.
  const [cancelled, setCancelled] = useState(false);
  const cancel = () => { if (busy) return; setConfirming(false); setCancelled(true); setFailed(null); };
  const bring = () => {
    if (busy) return;
    setBusy(true); setFailed(null);
    void onBring().catch((cause: unknown) => { setBusy(false); setFailed(ipcErrorText(cause) ?? t("twoPlaces.failed")); });
  };
  return <NoticeCard titleId="two-places-title" notice="two-places" icon={Merge} title={t("twoPlaces.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("twoPlaces.body", { place: suggest.name })}</p>
    {failed && <p role="alert" className="mb-3 text-[12px] text-danger">{failed}</p>}
    {confirming ? <div role="group" aria-label={t("twoPlaces.confirmTitle", { place: suggest.name })} className="rounded-lg border border-hairline/40 p-3"
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <p className="text-[13px] font-medium text-ink">{t("twoPlaces.confirmTitle", { place: suggest.name })}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("twoPlaces.confirm", { place: suggest.name })}</p>
      {suggest.kind === "cloud" && <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("twoPlaces.undo")}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" data-two-places-move className={PRIMARY_BUTTON} disabled={busy} aria-busy={busy || undefined} onClick={bring}>
          {busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />}
          {t("twoPlaces.move")}
        </button>
        <button type="button" autoFocus className="ui-button min-h-9 px-3 py-1.5" disabled={busy} onClick={cancel}>{t("common.cancel")}</button>
      </div>
    </div> : <div className="flex flex-wrap items-center gap-3">
      <button type="button" data-two-places-bring className={PRIMARY_BUTTON} autoFocus={cancelled} onClick={() => setConfirming(true)}>{t("twoPlaces.bring")}</button>
      <NotNowButton onClick={onDismiss} />
    </div>}
  </NoticeCard>;
}
