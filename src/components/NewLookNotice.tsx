import { useEffect } from "react";
import { X } from "lucide-react";
import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { markNewLookSeen } from "@/lib/new-look";

export const NEW_LOOK_NOTICE = "[data-new-look-notice]";
const TITLE = "new-look-notice-title";

export function reportNewLook(action: "shown" | "closed"): void {
  track("new_look_notice", { action });
}

/** Once, where Advanced mode was on before Simple became the only mode. Done, ×, Escape and a click outside close it for
 * good. */
export function NewLookNotice({ onClose }: { onClose: () => void }) {
  const close = () => {
    reportNewLook("closed");
    markNewLookSeen();
    onClose();
  };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.getElementById(TITLE)?.focus();
    return () => {
      if (opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  // Focus stays inside while it is open; Escape closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = document.querySelector<HTMLElement>(NEW_LOOK_NOTICE);
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="ui-scrim ui-scrim-light fixed inset-0 z-50 flex items-center justify-center p-4 motion-reduce:animate-none"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby="new-look-notice-body" data-new-look-notice=""
        className="ui-modal animate-pop-in relative w-[min(440px,calc(100vw-32px))] border-0 px-6 pb-5 pt-6 text-ink motion-reduce:animate-none">
        {/* Focus lands on the title, which is no control: it shows no ring. */}
        <h2 id={TITLE} tabIndex={-1} className="pe-8 text-[17px] font-medium leading-6 tracking-[-0.008em] outline-none!">
          {t("newLook.title")}
        </h2>
        <p id="new-look-notice-body" className="mt-2 text-[14px] leading-5 text-ink-secondary">{t("newLook.body")}</p>
        <div className="mt-5 flex justify-end">
          <button type="button" data-primary="" onClick={close}
            className="ui-button ui-button-pill min-w-[88px] border-transparent bg-ink text-app hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
            {t("common.done")}
          </button>
        </div>
        <button type="button" onClick={close} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
      </div>
    </div>
  );
}
