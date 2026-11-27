import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { CodexMark } from "./ProviderIcons";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export function ManageUsageLink({ href, className, children }: { href: string; className: string; children?: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={(event) => {
    if (window.ogb?.openExternal) { event.preventDefault(); void openExternalLink(href); }
  }}>{t("engineSetup.chatgpt.manageUsage")}{children}</a>;
}

/** Security: this marker only dismisses a welcome message; no sign-in data lives in the renderer. Settings passes
 * `welcome={false}`: its account rows stay mounted inside closed cards, where a modal would block the page unseen. */
export function ChatGptPlanStatus({ instanceId, welcome = true }: { instanceId: string; welcome?: boolean }) {
  const key = `omb:chatgpt-plan-welcome:${instanceId}`;
  const [acknowledged, setAcknowledged] = useState(() => {
    if (!welcome) return true;
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!acknowledged && !document.querySelector("dialog[data-chatgpt-plan-welcome][open]")) dialog.current?.showModal();
  }, [acknowledged]);

  const dismiss = () => {
    try { localStorage.setItem(key, "1"); } catch {}
    dialog.current?.close();
    setAcknowledged(true);
  };

  return <>
    <div data-chatgpt-plan-status className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-secondary">
      <span>{t("engineSetup.chatgpt.using")}</span>
      <ManageUsageLink href={CHATGPT_USAGE_URL} className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink size={11} /></ManageUsageLink>
    </div>
    {!acknowledged && <dialog ref={dialog} data-chatgpt-plan-welcome aria-labelledby={titleId} className="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl border border-hairline bg-panel p-6 text-ink shadow-2xl backdrop:bg-black/50" onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }} onCancel={(event) => { event.preventDefault(); dismiss(); }}>
      <CodexMark size={28} />
      <h2 id={titleId} className="mt-4 text-lg font-semibold">{t("engineSetup.chatgpt.welcome")}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("engineSetup.chatgpt.welcomeBody")}</p>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); dismiss(); }}>
        <button type="submit" className="mt-5 w-full rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-app">{t("onboarding.spot.gotIt")}</button>
      </form>
    </dialog>}
  </>;
}
