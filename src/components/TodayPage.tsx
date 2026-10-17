import { useState } from "react";
import {
  AlertTriangle, CalendarClock, CircleHelp, ClipboardList, FilePen, FileText, Hourglass, Info, Loader2, MailOpen, MessageSquare, Send, Sun, UserPlus, Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useCaptionChrome, useDesktopCapabilities } from "./DesktopCapabilities";
import { activeLocale, t } from "@/lib/i18n";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { plainErrorLine } from "@/lib/plain-error";
import { useShowThreads } from "@/lib/thread-preferences";
import { durationText, TILE_LABEL, timeSavedExplanation, useTodayReport, type TodayRange } from "@/lib/today";
import { formatTime, openThread, useStore, type Action, type AppState } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { listNames } from "../../shared/place-view";
import { OUTCOME_CATEGORIES, type OutcomeCategory } from "../../shared/today-outcomes";
import type { NeedsYouItem, TodayLine, TodayReport, TodayStarter } from "../../shared/today";
import type { TrialCreditRefusal } from "../../shared/trial-credit";
import { BotAvatar } from "./Avatar";
import { Select } from "./Select";

const ICON: Record<OutcomeCategory, LucideIcon> = {
  emailRead: MailOpen, draft: FilePen, emailSent: Send, message: MessageSquare, doc: FileText, report: ClipboardList, lead: UserPlus, other: Zap,
};
const STARTER: Record<TodayStarter, LocaleKey> = {
  schedule: "today.startedBy.schedule", webhook: "today.startedBy.webhook", manual: "today.startedBy.manual", startup: "today.startedBy.startup",
  bot: "today.startedBy.bot", api: "today.startedBy.api", relay: "today.startedBy.relay", person: "today.startedBy.person",
};
const CREDIT_LINE: Record<TrialCreditRefusal, LocaleKey> = {
  used_up: "engines.trialCreditUsedUp", ended: "engines.trialCreditEnded", paused: "engines.trialCreditPaused", too_low: "engines.trialCreditTooLow",
};
const ALL_BOTS = "all";
const ENGINES = { type: "toggleAppSettings", open: true, section: "engines" } as const;

type Dispatch = (action: Action) => void;

export function TodayPage() {
  const { dragProps, noDragStyle } = useCaptionChrome();
  const [range, setRange] = useState<TodayRange>("today");
  const { report, error, reload } = useTodayReport(range);
  const segment = (active: boolean) => cn("rounded-md px-3 py-1.5 text-[12px] font-medium", active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink");
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink" data-testid="today-page">
      <header {...dragProps} className="flex shrink-0 items-center gap-2.5 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <Sun size={18} className="text-ink-secondary" aria-hidden="true" />
        <h1 className="text-[17px] font-semibold">{t("today.title")}</h1>
        <div role="group" aria-label={t("today.range.label")} style={noDragStyle} className="ml-auto flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5">
          <button type="button" aria-pressed={range === "today"} onClick={() => setRange("today")} className={segment(range === "today")}>{t("today.range.today")}</button>
          <button type="button" aria-pressed={range === "week"} onClick={() => setRange("week")} className={segment(range === "week")}>{t("today.range.week")}</button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-6">
          {report ? <TodayContent report={report} range={range} /> : error ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 text-[13px]">
              <span className="text-danger">{t("today.loadFailed", { error })}</span>
              <button type="button" className="ui-button ui-button-sm" onClick={reload}>{t("today.retry")}</button>
            </div>
          ) : (
            <div role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{t("today.loading")}</div>
          )}
        </div>
      </div>
    </main>
  );
}

export function TodayContent({ report, range }: { report: TodayReport; range: TodayRange }) {
  const nothingDone = !report.tiles.length && !report.lines.length && !report.routines.ok && !report.routines.failed;
  return (
    <>
      {report.needsYou.length > 0 && <NeedsYou items={report.needsYou} />}
      {nothingDone ? <EmptyToday range={range} routines={report.routineCount} /> : (
        <>
          <Tiles report={report} />
          <Timeline report={report} range={range} />
        </>
      )}
    </>
  );
}

function EmptyToday({ range, routines }: { range: TodayRange; routines: number }) {
  const { dispatch } = useStore();
  return (
    <section aria-labelledby="today-empty" className="flex flex-col items-start gap-3 rounded-xl bg-card px-5 py-5" data-testid="today-empty">
      <h2 id="today-empty" className="text-[15px] font-medium">{t(range === "today" ? "today.empty.title" : "today.empty.titleWeek")}</h2>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t(routines ? "today.empty.routinesBody" : "today.empty.body")}</p>
      <button type="button" className="ui-button" onClick={() => dispatch({ type: "showRoutines" })}>
        {t(routines ? "today.empty.openRoutines" : "today.empty.firstRoutine")}
      </button>
    </section>
  );
}

function Tiles({ report }: { report: TodayReport }) {
  const how = timeSavedExplanation();
  const routinesRun = report.routines.ok + report.routines.failed;
  if (!report.minutesSaved && !report.tiles.length && !routinesRun) return null;
  return (
    <section aria-labelledby="today-summary" className="flex flex-col gap-3">
      <h2 id="today-summary" className="sr-only">{t("today.summary")}</h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {report.minutesSaved > 0 && <li className="col-span-2 flex flex-col gap-1 rounded-xl bg-accent/10 px-4 py-3 sm:col-span-1" title={how} data-testid="today-time-saved">
          <span className="flex items-center gap-1.5 text-[12.5px] text-ink-secondary">
            <Hourglass size={14} aria-hidden="true" />{t("today.tile.timeSaved")}
            <Info size={13} aria-hidden="true" className="text-ink-tertiary" />
          </span>
          <span className="text-[24px] font-semibold tabular-nums text-ink" aria-describedby="today-time-saved-how">{t("today.timeSaved.value", { time: durationText(report.minutesSaved) })}</span>
          <span id="today-time-saved-how" className="sr-only">{how}</span>
        </li>}
        {report.tiles.map(({ category, count }) => {
          const Icon = ICON[category];
          return (
            <li key={category} className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3" data-today-tile={category}>
              <span className="flex items-center gap-1.5 text-[12.5px] text-ink-secondary"><Icon size={14} aria-hidden="true" />{t(TILE_LABEL[category])}</span>
              <span className="text-[24px] font-semibold tabular-nums text-ink">{count.toLocaleString(activeLocale())}</span>
            </li>
          );
        })}
        {routinesRun > 0 && (
          <li className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3" data-today-tile="routines">
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-secondary"><CalendarClock size={14} aria-hidden="true" />{t("today.tile.routines")}</span>
            <span className="text-[15px] font-semibold leading-[36px] text-ink">
              {t("today.tile.routinesOk", { count: report.routines.ok })}
              {report.routines.failed > 0 && <span className="text-danger"> · {t("today.tile.routinesFailed", { count: report.routines.failed })}</span>}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

function needsYouView(item: NeedsYouItem, state: AppState, dispatch: Dispatch, place: (item: Extract<NeedsYouItem, { kind: "place" }>) => { text: string; action: { label: string; run: () => void } | null }) {
  const names = (ids: readonly string[]) => listNames(ids.flatMap((id) => state.bots.find((bot) => bot.id === id)?.name ?? []), activeLocale());
  const engine = (instanceId?: string) => state.instances.find((instance) => instance.instanceId === instanceId)?.displayName ?? t("today.needsYou.yourAi");
  switch (item.kind) {
    case "signed-out":
      return { Icon: AlertTriangle, title: t("today.needsYou.signedOut", { engine: engine(item.instanceId) }), detail: t("today.needsYou.botsWaiting", { bots: names(item.botIds) }),
        action: { label: t("today.needsYou.signIn"), run: () => dispatch(ENGINES) } };
    case "out-of-credit":
      return { Icon: AlertTriangle, title: t(CREDIT_LINE[item.credit]), detail: t("today.needsYou.botsWaiting", { bots: names(item.botIds) }),
        action: { label: t("chat.error.connectOwnAi"), run: () => dispatch(ENGINES) } };
    case "usage-limit":
      return { Icon: AlertTriangle, title: t("today.needsYou.usageLimit", { engine: engine(item.instanceId) }), detail: plainErrorLine(item.text) ?? item.text,
        action: { label: t("today.needsYou.openAiSettings"), run: () => dispatch(ENGINES) } };
    case "connection":
      return { Icon: AlertTriangle, title: t("today.needsYou.connection", { app: item.app }), detail: t("today.needsYou.botsWaiting", { bots: names(item.botIds) }),
        action: { label: t("today.needsYou.reconnect"), run: () => dispatch({ type: "togglePlugins", open: true }) } };
    case "place": {
      const view = place(item);
      return { Icon: AlertTriangle, title: view.text, detail: names(item.botIds), action: view.action };
    }
    case "question": {
      const bot = state.bots.find((candidate) => candidate.id === item.botId);
      return { Icon: CircleHelp, title: t("today.needsYou.question", { bot: bot?.name ?? t("today.unknownBot") }), detail: item.text, action: null };
    }
  }
}

function NeedsYou({ items }: { items: NeedsYouItem[] }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(state.config, capabilities.host.platform);
  const place = (item: Extract<NeedsYouItem, { kind: "place" }>) => {
    const botId = item.botIds[0]!;
    const view = placeRowViewFor(item.place, seat, worksOnSimpleLabel(state.bots.find((bot) => bot.id === botId)?.computer, capabilities.host.platform));
    const id = view.action?.id;
    return { text: view.line, action: view.action && id ? { label: view.action.label, run: () => { openPlaceAction(id, { botId, threadId: item.threadId }, dispatch); } } : null };
  };
  const open = (botId: string, threadId: string) => openThread(dispatch, { botId, threadId }, state, showThreads);
  return (
    <section aria-labelledby="today-needs-you" className="flex flex-col gap-2" data-testid="today-needs-you">
      <h2 id="today-needs-you" className="text-[15px] font-medium">{t("today.needsYou.title")}</h2>
      <ul className="flex flex-col divide-y divide-hairline/40 rounded-xl border border-warning/30 bg-card">
        {items.map((item) => {
          const view = needsYouView(item, state, dispatch, place);
          const action = item.kind === "question" ? { label: t("today.needsYou.answer"), run: () => open(item.botId, item.threadId) } : view.action;
          return (
            <li key={item.id} className="flex items-start gap-3 px-4 py-3" data-needs-you={item.kind}>
              <view.Icon size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0", item.kind === "question" ? "text-accent" : "text-warning")} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink">{view.title}</p>
                {view.detail && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-secondary">{view.detail}</p>}
              </div>
              {action && <button type="button" className="ui-button ui-button-sm shrink-0" onClick={action.run}>{action.label}</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function lineTime(at: number, range: TodayRange): string {
  return range === "today" ? formatTime(at)
    : new Intl.DateTimeFormat(activeLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

function lineTitle(line: TodayLine): string {
  return line.title || t(line.ok ? "today.timeline.finished" : "today.timeline.failed");
}

function Timeline({ report, range }: { report: TodayReport; range: TodayRange }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [botFilter, setBotFilter] = useState(ALL_BOTS);
  const bots = [...new Set(report.lines.map((line) => line.botId))]
    .flatMap((id) => state.bots.find((bot) => bot.id === id) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name));
  const filter = botFilter === ALL_BOTS || bots.some((bot) => bot.id === botFilter) ? botFilter : ALL_BOTS;
  const lines = filter === ALL_BOTS ? report.lines : report.lines.filter((line) => line.botId === filter);
  const open = (line: TodayLine) => {
    if (line.threadId) openThread(dispatch, { botId: line.botId, threadId: line.threadId }, state, showThreads);
    else if (line.routineId) dispatch({ type: "showRoutines", section: "logs", routineId: line.routineId });
  };
  if (!report.lines.length) return null;
  return (
    <section aria-labelledby="today-timeline" className="flex flex-col gap-2" data-testid="today-timeline">
      <div className="flex items-center gap-3">
        <h2 id="today-timeline" className="flex-1 text-[15px] font-medium">{t("today.timeline.title")}</h2>
        {bots.length > 1 && (
          <Select size="sm" aria-label={t("today.timeline.filter")} value={filter} onChange={(event) => setBotFilter(event.target.value)}>
            <option value={ALL_BOTS}>{t("today.timeline.allBots")}</option>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </Select>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-hairline/40 rounded-xl bg-card">
        {lines.map((line) => {
          const bot = state.bots.find((candidate) => candidate.id === line.botId);
          const outcomes = OUTCOME_CATEGORIES.filter((category) => line.outcomes[category]);
          const clickable = Boolean(line.threadId || line.routineId);
          return (
            <li key={line.id} data-today-line={line.ok ? "ok" : "failed"}>
              <button type="button" disabled={!clickable} onClick={() => open(line)} title={clickable ? t("today.timeline.open") : undefined}
                className="flex w-full items-start gap-3 px-4 py-2.5 text-left enabled:hover:bg-raised/50 disabled:cursor-default">
                <span className="mt-px shrink-0" aria-hidden="true">{bot ? <BotAvatar bot={bot} state={line.ok ? "happy" : "sad"} size={24} /> : <span className="block size-6 rounded-full bg-raised" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-[13px]">
                    <span className="shrink-0 font-medium text-ink">{bot?.name ?? t("today.unknownBot")}</span>
                    <span className="shrink-0 text-ink-tertiary" aria-hidden="true">·</span>
                    <span className={cn("min-w-0 flex-1 truncate", line.ok ? "text-ink" : "text-danger")}>{lineTitle(line)}</span>
                    <time className="shrink-0 text-[11.5px] tabular-nums text-ink-tertiary" dateTime={new Date(line.at).toISOString()}>{lineTime(line.at, range)}</time>
                  </span>
                  {(line.error || line.startedBy || outcomes.length > 0) && (
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-secondary">
                      {line.startedBy && <span className="rounded-full bg-raised px-2 py-0.5">{t(STARTER[line.startedBy])}</span>}
                      {outcomes.map((category) => {
                        const Icon = ICON[category];
                        return (
                          <span key={category} className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5" title={t(TILE_LABEL[category])}>
                            <Icon size={11} aria-hidden="true" />
                            <span className="sr-only">{t(TILE_LABEL[category])}</span>
                            {line.outcomes[category]}
                          </span>
                        );
                      })}
                      {line.error && <span className="min-w-0 truncate text-danger">{plainErrorLine(line.error) ?? line.error}</span>}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {report.moreLines > 0 && filter === ALL_BOTS && <p className="text-[12px] text-ink-tertiary">{t("today.timeline.more", { count: report.moreLines })}</p>}
    </section>
  );
}
