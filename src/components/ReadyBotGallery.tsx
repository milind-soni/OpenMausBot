import { useState } from "react";
import { createPortal } from "react-dom";
import { Clock3, Plus, Star, UsersRound } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { NewBotDialog } from "./lazy-screens";
import { READY_BOT_CATEGORIES, READY_BOTS, matchesReadyBot, type ReadyBotCategory } from "@/lib/ready-bots";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot } from "@/state/store";
import type { TemplateStats } from "@/lib/team-catalog";

const APP_LABELS: Record<string, string> = {
  gmail: "Gmail", github: "GitHub", discord: "Discord", slack: "Slack", googlecalendar: "Google Calendar",
  notion: "Notion", linear: "Linear", figma: "Figma", gong: "Gong", hubspot: "HubSpot", postiz: "Postiz",
};

const CATEGORY_KEYS: Record<ReadyBotCategory, LocaleKey> = {
  everyday: "readyBots.category.everyday", work: "readyBots.category.work", writing: "readyBots.category.writing",
  design: "readyBots.category.design", sales: "readyBots.category.sales", personal: "readyBots.category.personal",
};

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Stars and "Used by", only when the community catalog publishes them for this template: never a placeholder number. */
const hasSignals = (stats?: TemplateStats): boolean => Boolean(stats && (stats.stars !== undefined || stats.installs !== undefined));

function CommunitySignals({ stats }: { stats?: TemplateStats }) {
  if (!stats || !hasSignals(stats)) return null;
  const { stars, installs } = stats;
  return <span data-ready-bot-signals className="flex shrink-0 items-center gap-1.5">
    {stars !== undefined && <span className="flex items-center gap-0.5" title={t("readyBots.stars", { count: String(stars) })}>
      <Star size={12} aria-hidden="true" className="fill-current text-warning" /><span aria-hidden="true">{compact.format(stars)}</span>
      <span className="sr-only">{t("readyBots.stars", { count: String(stars) })}</span>
    </span>}
    {installs !== undefined && <span className="flex items-center gap-0.5" title={t("readyBots.usedBy", { count: String(installs) })}>
      <UsersRound size={12} aria-hidden="true" /><span aria-hidden="true">{compact.format(installs)}</span>
      <span className="sr-only">{t("readyBots.usedBy", { count: String(installs) })}</span>
    </span>}
  </span>;
}

export function ReadyBotGallery({ search, onDialog, onAdded, stats }: {
  search: string;
  /** Community signals by template id, from the community catalog when it publishes them. */
  stats?: Record<string, TemplateStats>;
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
  const galleryHasStats = Object.values(stats ?? {}).some(hasSignals);
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
    <div className="grid auto-rows-fr grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {visible.map((bot) => {
        const apps = bot.apps.map((app) => APP_LABELS[app] ?? app).join(", ");
        const tryPrompt = t("readyBots.try", { prompt: bot.tryAsking[0]! });
        // One layout for every card: header, two lines of description, one Try line, and a one-line footer at the bottom.
        // Left is what the bot is; right is + Add above its stars, at the same edge on every card.
        return <article key={bot.id} data-ready-bot={bot.id} className="flex flex-col rounded-2xl border border-hairline/40 bg-card p-4">
          <div className="flex h-10 items-center gap-3">
            <MausAvatar color={bot.look.color} bodyId={bot.look.mascotBody} size={40} animated={false} label={bot.name} />
            <div className="min-w-0 flex-1">
              <h4 className="truncate text-[14px] font-medium text-ink">{bot.name}</h4>
              <p data-ready-bot-role className="truncate text-[12px] text-ink-secondary" title={bot.title}>{bot.title}</p>
            </div>
            <button type="button" onClick={() => open(bot.id)} aria-label={t("readyBots.addAria", { name: bot.name, title: bot.title })}
              className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-raised px-3 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
              <Plus size={14} aria-hidden="true" />{t("readyBots.add")}
            </button>
          </div>
          <p data-ready-bot-description title={bot.description} className="mt-3 line-clamp-2 min-h-[2.9em] text-[13px] leading-[1.45] text-ink-secondary">{bot.description}</p>
          <p data-ready-bot-try title={tryPrompt} className="mt-2 truncate text-[12px] italic text-ink-tertiary">{tryPrompt}</p>
          <div data-ready-bot-footer className="mt-auto flex h-6 min-w-0 items-center gap-3 pt-3 text-[12px] text-ink-tertiary">
            <div data-ready-bot-about className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 rounded-full bg-raised/70 px-2 py-0.5 text-[11px] font-medium text-ink-secondary">{t(CATEGORY_KEYS[bot.category])}</span>
              {bot.routines?.length ? <span data-ready-bot-routine className="flex shrink-0 items-center gap-1" title={t("readyBots.pausedRoutine")}>
                <Clock3 size={12} aria-hidden="true" /><span aria-hidden="true">{t("readyBots.routine")}</span><span className="sr-only">{t("readyBots.pausedRoutine")}</span>
              </span> : null}
              {apps && <span className="min-w-0 truncate" title={t("readyBots.worksWith", { apps })}>{t("readyBots.worksWith", { apps })}</span>}
            </div>
            {/* Under + Add on every card once any template has numbers, so the columns line up; empty for a template without its own. */}
            {galleryHasStats && <div data-ready-bot-stats className="flex w-24 shrink-0 justify-end tabular-nums"><CommunitySignals stats={stats?.[bot.id]} /></div>}
          </div>
        </article>;
      })}
    </div>
    {adding && createPortal(<NewBotDialog readyBotId={adding} onClose={() => open(null)} onCreated={(bot) => { onDialog(false); onAdded(bot); }} />, document.body)}
  </section>;
}
