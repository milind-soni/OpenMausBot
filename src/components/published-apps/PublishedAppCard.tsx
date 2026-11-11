import { useState } from "react";
import { ArrowUpRight, Check, Copy, Eye, MessageSquare, Settings2, Trash2 } from "lucide-react";

import type { PublishedApp } from "../../../shared/published-apps";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { relativeTime } from "@/lib/memory";
import { ConfirmDialog } from "../ConfirmDialog";
import { SiteThumb } from "./SiteThumb";

const ACCESS: Record<PublishedApp["access"], LocaleKey | null> = {
  public: "publishedApps.access.public", "netlify-team": "publishedApps.access.netlifyTeam", link: "publishedApps.access.link", unknown: null,
};

export type DeleteProblem = { text: string; manageUrl?: string };

export function PublishedAppCard({ app, onOpen, onPreview, onAsk, onDelete }: {
  app: PublishedApp;
  onOpen: (url: string) => void;
  onPreview: () => void;
  /** Absent when the bot is gone. */
  onAsk?: () => void;
  /** Resolves with what went wrong, or null once the app is deleted. */
  onDelete: () => Promise<DeleteProblem | null>;
}) {
  const { state: copied, copy } = useCopyFeedback(app.url);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<DeleteProblem | null>(null);
  const access = ACCESS[app.access];
  const facts = [app.bot.name, relativeTime(app.publishedAt)].filter(Boolean).join(" · ");
  const confirmDelete = async () => {
    setDeleting(true);
    const failed = await onDelete();
    setDeleting(false);
    setConfirming(false);
    setProblem(failed);
  };
  const icon = "ui-icon-button shrink-0 hover:bg-raised hover:text-ink";
  return (
    <li data-published-app={app.id} data-source={app.source} className="flex flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-card">
      <button type="button" onClick={onPreview} aria-label={t("publishedApps.card.previewOf", { name: app.title })} className="block w-full border-b border-hairline/30 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        <SiteThumb url={app.url} title={app.title} loginOnly={app.access === "netlify-team"} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
        <div className="min-w-0">
          <h2 dir="auto" className="truncate text-[15px] font-semibold text-ink" title={app.title}>{app.title}</h2>
          <p dir="auto" className="mt-0.5 truncate text-[13px] text-ink-secondary">{facts}</p>
          {access && <p data-app-access={app.access} className="mt-1.5 inline-block rounded-full bg-inset px-2 py-0.5 text-[12px] text-ink-secondary">{t(access)}</p>}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <button type="button" className="ui-button ui-button-md" onClick={onPreview}><Eye size={14} aria-hidden="true" />{t("publishedApps.card.preview")}</button>
          <button type="button" className="ui-button ui-button-md" onClick={() => onOpen(app.url)}><ArrowUpRight size={14} aria-hidden="true" />{t("chat.page.open")}</button>
          <span className="ml-auto flex items-center">
            <button type="button" className={icon} onClick={copy} aria-label={t("chat.page.copyLink")} title={t(copied === "copied" ? "chat.page.copied" : "chat.page.copyLink")}>
              {copied === "copied" ? <Check size={15} /> : <Copy size={15} />}
            </button>
            {onAsk && <button type="button" className={icon} onClick={onAsk} aria-label={t("publishedApps.card.ask", { bot: app.bot.name })} title={t("publishedApps.card.ask", { bot: app.bot.name })}><MessageSquare size={15} /></button>}
            {app.manageUrl && <button type="button" className={icon} onClick={() => onOpen(app.manageUrl!)} aria-label={t("publishedApps.card.manage")} title={t("publishedApps.card.manage")}><Settings2 size={15} /></button>}
            {app.canDelete && <button type="button" className={`${icon} hover:text-danger`} onClick={() => { setProblem(null); setConfirming(true); }} aria-label={t("publishedApps.card.delete", { name: app.title })} title={t("common.delete")}><Trash2 size={15} /></button>}
          </span>
        </div>
        {problem && (
          <p role="alert" className="text-[12px] leading-snug text-danger">
            {problem.text}{" "}
            {problem.manageUrl && <button type="button" className="font-medium underline underline-offset-2" onClick={() => onOpen(problem.manageUrl!)}>{t("publishedApps.card.manage")}</button>}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("publishedApps.delete.title", { name: app.title })}
        body={t("publishedApps.delete.body")}
        confirmLabel={t("common.delete")}
        pending={deleting}
        onCancel={() => { if (!deleting) setConfirming(false); }}
        onConfirm={() => void confirmDelete()}
      />
    </li>
  );
}
