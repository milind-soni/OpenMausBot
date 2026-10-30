import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { NewBotDialog } from "./lazy-screens";
import { READY_BOT_CATEGORIES, READY_BOTS, matchesReadyBot, type ReadyBotCategory } from "@/lib/ready-bots";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot } from "@/state/store";

const APP_LABELS: Record<string, string> = {
  gmail: "Gmail", github: "GitHub", discord: "Discord", slack: "Slack", googlecalendar: "Google Calendar",
  notion: "Notion", linear: "Linear", figma: "Figma", gong: "Gong", hubspot: "HubSpot", postiz: "Postiz",
};

const CATEGORY_KEYS: Record<ReadyBotCategory, LocaleKey> = {
  everyday: "readyBots.category.everyday", work: "readyBots.category.work", writing: "readyBots.category.writing",
  design: "readyBots.category.design", sales: "readyBots.category.sales", personal: "readyBots.category.personal",
};

export function ReadyBotGallery({ search, onDialog, onAdded }: {
  search: string;
  /** The New bot dialog is open over Templates, so Templates must leave its keys alone. */
  onDialog: (open: boolean) => void;
  onAdded: (bot: Bot) => void;
}) {
  const [category, setCategory] = useState<ReadyBotCategory | null>(null);
  const { dispatch } = useStore();
  const [adding, setAdding] = useState<string | null>(null);
  const open = (id: string | null) => {
    // A paired device may not read the host's New bot defaults that the review is filled from.
    if (id !== null && window.ogb?.remoteClient?.active) { dispatch({ type: "newBot", onCreated: onAdded }); return; }
    setAdding(id); onDialog(id !== null);
  };
  const visible = READY_BOTS.filter((bot) => (!category || bot.category === category) && matchesReadyBot(bot, search));
  if (search.trim() && visible.length === 0) return null;
  return <section className="mb-8" aria-labelledby="ready-bots-title">
    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="ready-bots-title" className="text-[12px] font-medium text-ink-secondary">{t("readyBots.title")}</h3>
      <p className="text-[12px] text-ink-tertiary">{t("readyBots.subtitle")}</p>
    </div>
    <div className="mb-3 mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("readyBots.categories")}>
      {[null, ...READY_BOT_CATEGORIES].map((value) => <button key={value ?? "all"} type="button" aria-pressed={category === value}
        onClick={() => setCategory(value)}
        className={cn("rounded-full px-3 py-1 text-[13px] transition-colors",
          category === value ? "bg-ink text-panel" : "bg-raised/70 text-ink-secondary hover:text-ink")}>
        {value ? t(CATEGORY_KEYS[value]) : t("readyBots.all")}
      </button>)}
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {visible.map((bot) => <article key={bot.id} data-ready-bot={bot.id} className="flex flex-col rounded-2xl border border-hairline/40 bg-card p-4">
        <div className="flex items-center gap-3">
          <MausAvatar color={bot.look.color} bodyId={bot.look.mascotBody} size={40} animated={false} label={bot.name} />
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-[14px] font-medium text-ink">{bot.name}</h4>
            <p className="truncate text-[12px] text-ink-secondary">{bot.title} · {t(CATEGORY_KEYS[bot.category])}</p>
          </div>
          <button type="button" onClick={() => open(bot.id)} aria-label={t("readyBots.addAria", { name: bot.name, title: bot.title })}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-raised px-3 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
            <Plus size={14} aria-hidden="true" />{t("readyBots.add")}
          </button>
        </div>
        <p className="mt-3 text-[13px] leading-[1.45] text-ink-secondary">{bot.description}</p>
        <p className="mt-2 text-[12px] italic text-ink-tertiary">{t("readyBots.try", { prompt: bot.tryAsking[0]! })}</p>
        {(bot.apps.length > 0 || bot.routines?.length) && <p className="mt-auto pt-2 text-[12px] text-ink-tertiary">
          {[bot.apps.length > 0 && t("readyBots.worksWith", { apps: bot.apps.map((app) => APP_LABELS[app] ?? app).join(", ") }),
            bot.routines?.length && t("readyBots.pausedRoutine")].filter(Boolean).join(" · ")}
        </p>}
      </article>)}
    </div>
    {adding && createPortal(<NewBotDialog readyBotId={adding} onClose={() => open(null)} onCreated={(bot) => { onDialog(false); onAdded(bot); }} />, document.body)}
  </section>;
}
