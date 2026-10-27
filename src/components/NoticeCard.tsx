import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, X, type LucideIcon } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";

export function NoticeCard({ titleId, icon: Icon, title, onDismiss, dismissLabel = t("notice.dismiss"), notice, children }: {
  titleId: string; icon: LucideIcon; title: string; onDismiss: () => void;
  dismissLabel?: string;
  notice?: string;
  children: ReactNode;
}) {
  return <aside aria-labelledby={titleId} data-notice={notice} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
  }} className="fixed bottom-4 left-4 z-40 max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-hairline/40 bg-panel p-3.5 text-ink shadow-2xl shadow-black/20">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2.5">
        <Icon size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
        <h2 id={titleId} className="text-[14px] font-semibold">{title}</h2>
      </div>
      <button type="button" onClick={onDismiss} aria-label={dismissLabel} className="ui-icon-button"><X size={16} /></button>
    </div>
    {children}
    <p role="status" className="sr-only">{title}</p>
  </aside>;
}

export const PRIMARY_BUTTON = "ui-button ui-button-primary min-h-9 gap-1.5 px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function LinkButton({ url, label, onOpened }: { url: string; label: string; onOpened?: () => void }) {
  const [failed, setFailed] = useState(false);
  return <div>
    <button type="button" className={PRIMARY_BUTTON} onClick={() => {
      setFailed(false);
      void openExternalLink(url).then(onOpened).catch(() => setFailed(true));
    }}>
      {label}<ArrowUpRight size={14} aria-hidden="true" />
    </button>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("notice.openFailed")}</p>}
  </div>;
}

export function NotNowButton({ onClick, label = t("notice.notNow") }: { onClick: () => void; label?: string }) {
  return <button type="button" className="py-2 text-[12px] text-ink-secondary hover:text-ink" onClick={onClick}>{label}</button>;
}

export function NoticeToast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 5_000);
    return () => clearTimeout(timer);
  }, [text]);
  return <p role="status" data-notice-toast className="fixed bottom-4 left-4 z-[60] w-[300px] max-w-[calc(100vw-32px)] rounded-xl border border-hairline/40 bg-panel px-3.5 py-2.5 text-[13px] text-ink shadow-2xl shadow-black/20">{text}</p>;
}
