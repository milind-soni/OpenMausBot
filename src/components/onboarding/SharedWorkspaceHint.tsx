// What a member of a hosted team workspace sees on first open instead of the
// welcome flow. The workspace config belongs to its admins, so a member
// could neither save the tour nor stop it coming back. One quiet note below
// the header, clear of the composer, says where they are. It is not a
// dialog: nothing waits on it. Dismissal is remembered in this browser only.
import { useId, useState } from "react";
import { MausAvatar } from "@/components/Avatar";
import { t } from "@/lib/i18n";

const DISMISSED_KEY = "omb.onboarding.sharedWorkspaceHint";

export function sharedHintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // private window or blocked storage: show it, once per visit
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // not remembered; it is a hint, not a gate
  }
}

export function SharedWorkspaceHint({
  replay,
  onClose,
}: {
  /** Settings → Replay welcome tour: show it again even if dismissed. */
  replay: boolean;
  onClose: () => void;
}) {
  const [dismissed, setDismissed] = useState(sharedHintDismissed);
  const titleId = useId();
  if (dismissed && !replay) return null;
  const close = () => {
    rememberDismissed();
    setDismissed(true);
    onClose();
  };
  return (
    <aside
      aria-labelledby={titleId}
      className="fixed inset-x-3 top-14 z-40 flex items-start gap-3 rounded-2xl border border-hairline/50 bg-panel p-3.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] sm:inset-x-auto sm:right-5 sm:top-16 sm:w-[360px]"
    >
      <div className="shrink-0">
        <MausAvatar color="green" state="happy" size={36} trackPointer={false} />
      </div>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-[13.5px] font-semibold text-ink">
          {t("onboarding.shared.title")}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("onboarding.shared.body")}</p>
        <button
          type="button"
          onClick={close}
          className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-transform duration-150 active:scale-[0.98]"
        >
          {t("onboarding.spot.gotIt")}
        </button>
      </div>
    </aside>
  );
}
