import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, Database, History, Loader2, Maximize2, Minimize2, Pin } from "lucide-react";
import { DATA_ROUTES, type DataRunRequest } from "../../../shared/data-surface";
import { api, useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { useColorScheme } from "@/lib/color-scheme";
import { SourcesStrip } from "./SourcesStrip";
import { DataCard } from "./DataCard";
import { DataResultFooter } from "./DataGrid";
import { SqlEditor } from "./SqlEditor";
import { cardsLatestFirst } from "./data-format";

const QUERY_MIN_HEIGHT = 128;
const RESULT_MIN_HEIGHT = 180;
const RESIZE_HANDLE_HEIGHT = 6;
const QUERY_RESIZE_STEP = 24;
function queryBounds(panelHeight: number) {
  const max = Math.max(0, Math.floor(panelHeight - Math.min(RESULT_MIN_HEIGHT, panelHeight / 2) - RESIZE_HANDLE_HEIGHT));
  return { min: Math.min(QUERY_MIN_HEIGHT, max), max };
}
const clampHeight = (height: number, bounds: { min: number; max: number }) => Math.max(bounds.min, Math.min(bounds.max, height));
/** How long typing pauses before the text runs. Each run materialises a
 * table on the server and interrupts the previous one, so one keystroke
 * burst should be one query, not one per character; 50 ms still feels live. */
export const LIVE_RUN_DELAY_MS = 50;

/** One result at a time, following the latest update until History or
 * another result is selected. Older cards remain intact on the sheet. */
export function DataPanel({ bot, requestedCard }: { bot: Bot; requestedCard?: { id: string; requestId: number } }) {
  // A different conversation must not inherit this editor or its live request.
  return <BotDataPanel key={`${bot.id}:${bot.threadId}`} bot={bot} requestedCard={requestedCard} />;
}

function BotDataPanel({ bot, requestedCard }: { bot: Bot; requestedCard?: { id: string; requestId: number } }) {
  const { state, dispatch } = useStore();
  const sheet = state.dataSheets[bot.id];
  const theme = useColorScheme();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ cardId: string } | null>(() => requestedCard ? { cardId: requestedCard.id } : null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const query = useRef<HTMLDivElement>(null);
  const queryId = useId();
  const [panelHeight, setPanelHeight] = useState(0);
  const [queryHeight, setQueryHeight] = useState<number | null>(null);
  const resizeFrom = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const bounds = queryBounds(panelHeight);
  const liveRequest = useRef<AbortController | null>(null);
  // The text waiting out LIVE_RUN_DELAY_MS; a newer keystroke replaces it.
  const runTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropPendingRun = () => {
    if (runTimer.current === null) return;
    clearTimeout(runTimer.current);
    runTimer.current = null;
  };
  const draft = useRef<{ cardId: string; sql?: string; externalRevision?: string } | null>(null);
  const requested = useRef<string | null | undefined>(undefined);
  const previousConnection = useRef(state.connected);
  const requestKey = requestedCard ? JSON.stringify([requestedCard.id, requestedCard.requestId]) : null;
  useEffect(() => {
    if (requestedCard) setSelection({ cardId: requestedCard.id });
  }, [requestedCard?.id, requestedCard?.requestId]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(panel.current) && document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleFullscreen = async () => {
    if (!panel.current) return;
    try {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      else await panel.current.requestFullscreen();
      setFullscreenError(false);
    } catch { setFullscreenError(true); }
  };

  useEffect(() => {
    // Reconcile cached sheets after a restart or missed frame, and retry an
    // explicit result request if the current cache does not contain it.
    const reconnected = previousConnection.current === false && state.connected === true;
    previousConnection.current = state.connected;
    const refresh = reconnected || requested.current === undefined || (requested.current !== requestKey && requestedCard && !sheet?.cards.some((card) => card.id === requestedCard.id));
    requested.current = requestKey;
    if (!refresh) return;
    setLoadError(null);
    dispatch({ type: "loadDataSheet", botId: bot.id, onError: setLoadError });
  }, [bot.id, sheet, dispatch, requestKey, requestedCard?.id, state.connected]);

  const cards = useMemo(() => cardsLatestFirst(sheet?.cards ?? []), [sheet?.cards]);
  const tables = sheet?.tables ?? sheet?.sources ?? [];
  const selectedCard = selection ? cards.find((card) => card.id === selection.cardId) : null;
  const card = selection ? selectedCard ?? null : cards[0] ?? null;
  const hasSql = card?.sql !== undefined && card.kind !== "text";
  const externalRevision = card?.by === "bot" && card.status === "ready" ? card.result ?? card.updatedAt : undefined;
  const unavailable = sheet && selection && !selectedCard;
  useEffect(() => () => { draft.current = null; dispatch({ type: "dataView", view: null }); }, [bot.id, bot.threadId, dispatch]);
  useEffect(() => {
    if (!card || !hasSql) {
      draft.current = null;
      dispatch({ type: "dataView", view: null });
      return;
    }
    const botUpdated = externalRevision !== undefined && draft.current?.externalRevision !== externalRevision;
    if (botUpdated) {
      // The bot's finished edit replaces the shown SQL; text typed against the
      // old query must not run over it.
      dropPendingRun();
      liveRequest.current?.abort();
      liveRequest.current = null;
      setRunError(null);
    }
    if (draft.current?.cardId !== card.id || botUpdated) {
      draft.current = { cardId: card.id, externalRevision };
    }
    const sql = draft.current.sql;
    dispatch({ type: "dataView", view: { botId: bot.id, threadId: bot.threadId, cardId: card.id, ...(sql !== undefined && sql !== card.sql ? { draftSql: sql } : {}) } });
  }, [bot.id, bot.threadId, card?.id, card?.sql, externalRevision, hasSql, dispatch]);
  useEffect(() => {
    if (!panel.current) return;
    const read = () => {
      const height = panel.current?.offsetHeight ?? 0;
      setPanelHeight(height);
      if (hasSql) setQueryHeight((current) => clampHeight(current ?? query.current?.offsetHeight ?? QUERY_MIN_HEIGHT, queryBounds(height)));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [hasSql]);
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || resizeFrom.current) return;
    event.preventDefault();
    resizeFrom.current = { pointerId: event.pointerId, y: event.clientY, height: query.current?.offsetHeight ?? QUERY_MIN_HEIGHT };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeFrom.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setQueryHeight(clampHeight(start.height + start.y - event.clientY, bounds));
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeFrom.current?.pointerId !== event.pointerId) return;
    resizeFrom.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const delta = event.key === "ArrowUp" ? QUERY_RESIZE_STEP : event.key === "ArrowDown" ? -QUERY_RESIZE_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    setQueryHeight((current) => clampHeight((current ?? query.current?.offsetHeight ?? QUERY_MIN_HEIGHT) + delta, bounds));
  };
  useEffect(() => {
    setRunError(null);
    return () => { dropPendingRun(); liveRequest.current?.abort(); };
  }, [card?.id, requestedCard?.requestId]);

  const select = (next: typeof selection) => {
    setSelection(next);
  };
  /** Every keystroke: chat sees the draft at once; the run waits for a pause. */
  const edit = (sql: string) => {
    if (!card) return;
    draft.current = { cardId: card.id, sql, externalRevision: draft.current?.externalRevision };
    dispatch({ type: "dataView", view: { botId: bot.id, threadId: bot.threadId, cardId: card.id, ...(sql !== card.sql ? { draftSql: sql } : {}) } });
    dropPendingRun();
    runTimer.current = setTimeout(() => { runTimer.current = null; void run(sql); }, LIVE_RUN_DELAY_MS);
  };
  const run = async (sql: string) => {
    if (!card) return;
    liveRequest.current?.abort();
    const controller = new AbortController();
    liveRequest.current = controller;
    setRunError(null);
    const request: DataRunRequest = { cardId: card.id, sql, live: true };
    try {
      await api(DATA_ROUTES.run(bot.id), { method: "POST", body: JSON.stringify(request), signal: controller.signal });
    } catch (cause) {
      if (!controller.signal.aborted && liveRequest.current === controller && sql.trim()) setRunError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const empty = sheet && cards.length === 0 && !selection;
  const control = "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink";
  const controls = <>
        <details className="relative" data-testid="data-history">
          <summary role="button" className={`${control} cursor-pointer list-none [&::-webkit-details-marker]:hidden`} aria-label={t("data.history")} title={t("data.history")}>
            <History size={14} aria-hidden="true" /><span className="hidden @min-[460px]/data:inline">{t("data.history")}</span><ChevronDown size={12} aria-hidden="true" />
          </summary>
          <div className="absolute right-0 bottom-full z-30 mb-1 flex max-h-[min(20rem,calc(100cqh-3rem))] w-72 max-w-[70vw] flex-col overflow-y-auto rounded-xl border border-hairline/50 bg-menu p-1.5 shadow-xl" role="menu" aria-label={t("data.history")}>
            <button type="button" role="menuitemradio" aria-checked={selection === null} className={`${control} text-left`} onClick={(event) => { select(null); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("data.latest")}</button>
            {cards.map((candidate) => (
              <button key={candidate.id} type="button" role="menuitemradio" aria-checked={selection !== null && card?.id === candidate.id} className={`${control} text-left`}
                onClick={(event) => { select({ cardId: candidate.id }); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
                <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                {candidate.pinned && <Pin size={12} aria-label={t("data.card.pin")} />}
                {candidate.status === "running" && <Loader2 size={12} className="animate-spin" aria-label={t("data.card.running")} />}
              </button>
            ))}
          </div>
        </details>
        <button type="button" className={control} aria-label={t(fullscreen ? "desktopViewer.exitFullscreen" : "desktopViewer.fullscreen")} title={t(fullscreen ? "desktopViewer.exitFullscreen" : "desktopViewer.fullscreen")} onClick={() => void toggleFullscreen()}>
          {fullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
  </>;
  const queryError = runError ?? (fullscreenError ? t("desktopViewer.fullscreenFailed") : null);

  return (
    <div ref={panel} className="@container/data flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card text-ink fullscreen:h-full fullscreen:w-full" data-testid="data-panel">
      {/* Footer menus size against this result area, leaving the 44px footer and 4px gap. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden [container-type:size]" data-testid="data-result">
        {!sheet && !loadError && (
          <p className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-ink-secondary" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("data.loading")}
          </p>
        )}
        {loadError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("data.loadFailed", { reason: loadError })}</p>}
        {unavailable && <p role="status" className="px-3 py-8 text-center text-[13px] text-ink-secondary">{t("data.resultUnavailable")}</p>}
        {empty && (
          <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="data-empty">
            <Database size={22} className="text-ink-secondary" aria-hidden="true" />
            <p className="text-[13px] text-ink-secondary">{t("data.empty")}</p>
          </div>
        )}
        {card && <DataCard key={card.id} bot={bot} card={card} theme={theme} controls={controls} />}
        {!card && <div className="mt-auto"><DataResultFooter controls={controls} /></div>}
      </div>
      {hasSql && <div role="separator" aria-orientation="horizontal" aria-label={t("data.editor.resize")} aria-controls={queryId}
        aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={queryHeight ?? undefined} tabIndex={0}
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}
        onLostPointerCapture={() => { resizeFrom.current = null; }} onKeyDown={resizeByKey} data-testid="data-query-resize"
        className="group flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-hairline/40 hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none">
        <span className="h-0.5 w-8 rounded-full bg-hairline group-hover:bg-accent/60 group-focus-visible:bg-accent/60" />
      </div>}
      <div ref={query} id={queryId} style={{ height: hasSql ? queryHeight ?? undefined : undefined }} className="flex min-h-0 shrink-0 flex-col overflow-hidden px-3 py-2" data-testid="data-query">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasSql && <SqlEditor key={card.id} sql={card.sql!} externalRevision={externalRevision} readOnly={card.status === "running" && !card.result} onChange={edit} />}
          <p role={queryError ? "alert" : undefined} title={queryError ?? undefined} className="mt-1 h-4 shrink-0 truncate text-[11.5px] text-danger" data-testid="data-query-error">{queryError}</p>
        </div>
        <div className="shrink-0"><SourcesStrip sources={tables} /></div>
      </div>
    </div>
  );
}
