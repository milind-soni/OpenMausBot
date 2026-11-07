import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { formatTime, toRows, type InspectorPage, type InspectorRow } from "@/lib/inspector";
import { listenLiveFrames } from "@/lib/live-events";
import type { RuntimeEvent } from "../../shared/runtime-events";
import { RunLog } from "./RunLog";
import { timelineEvents } from "@/lib/taskTimeline";
import { activeLocale, t } from "@/lib/i18n";
import { capital } from "@/lib/automations";
import type { LocaleKey } from "@/locales";
import { appendInspectorRuntime, mergeInspectorSnapshot, INSPECTOR_WINDOW_LIMIT } from "@/lib/inspector-window";

const tabLabel = (key: LocaleKey) => (activeLocale() === "en" ? t(key) : capital(t(key)));

type Lens = "run" | "events" | "raw";

/**
 * Displays one thread's Inspector snapshot and live event window.
 * Snapshot requests share the live subscription's buffering lifecycle, including
 * the initial request, because disk persistence can lag behind live delivery.
 * Native expansion resets on a loaded snapshot: its positional keys are not identities.
 */
export function InspectorPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const threadId = bot.threadId;
  const [lens, setLens] = useState<Lens>("run");
  const activity = useMemo(() => timelineEvents(visibleMessages(bot), bot), [bot]);
  const [page, setPage] = useState<InspectorPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadAbort = useRef<AbortController | null>(null);
  const managedRefresh = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const res = await fetch(`/api/threads/${threadId}/events?limit=${INSPECTOR_WINDOW_LIMIT}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      // SAFETY: the same-version harness's typed inspector endpoint; malformed transport data is handled by catch.
      const next = (await res.json()) as InspectorPage;
      if (controller.signal.aborted) return;
      setPage((previous) => mergeInspectorSnapshot(previous, next));
      setExpanded((previous) => new Set([...previous].filter((key) => key.startsWith("runtime:"))));
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [threadId]);

  useEffect(() => {
    setPage(null);
    setExpanded(new Set());
    stickToBottom.current = true;
    return () => loadAbort.current?.abort();
  }, [load]);

  useEffect(() => {
    let alive = true;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let refreshGeneration = 0;
    let refreshing = false;
    const pendingRuntime: RuntimeEvent[] = [];
    let batch: RuntimeEvent[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBatch = () => {
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = null;
      const events = batch;
      batch = [];
      if (events.length) setPage((prev) => appendInspectorRuntime(prev, events));
    };
    const appendRuntime = (runtime: RuntimeEvent) => {
      batch.push(runtime);
      if (batch.length >= INSPECTOR_WINDOW_LIMIT) flushBatch();
      else batchTimer ??= setTimeout(flushBatch, 16);
    };

    const flushPendingRuntime = () => {
      for (const runtime of pendingRuntime.splice(0)) appendRuntime(runtime);
    };

    const refresh = async () => {
      flushBatch();
      const generation = ++refreshGeneration;
      refreshing = true;
      await load();
      // A later refresh aborts the earlier fetch, and only its completion owns the buffered live tail.
      if (!alive || generation !== refreshGeneration) return;
      refreshing = false;
      flushPendingRuntime();
    };
    const requestRefresh = () => void refresh();
    managedRefresh.current = requestRefresh;

    const stopLive = listenLiveFrames({
      onMissedFrames: requestRefresh,
      onFrame: (frame) => {
        if (frame.kind !== "runtime") return;
        const runtime = frame.event;
        if (runtime.threadId !== threadId) return;
        if (refreshing) pendingRuntime.push(runtime);
        else appendRuntime(runtime);
        if (runtime.type === "turn.completed" || runtime.type === "runtime.error") {
          if (settle) clearTimeout(settle);
          settle = setTimeout(requestRefresh, 400);
        }
      },
    });
    requestRefresh();
    return () => {
      alive = false;
      if (managedRefresh.current === requestRefresh) managedRefresh.current = () => {};
      stopLive();
      if (settle) clearTimeout(settle);
      if (batchTimer) clearTimeout(batchTimer);
      batch = [];
    };
  }, [threadId, load]);

  const entries = useMemo(
    () => (page ? page.entries.filter((e) => (lens === "raw" ? e.kind === "native" : e.kind === "runtime")) : []),
    [page, lens],
  );
  const rows = useMemo(() => toRows(entries), [entries]);

  useEffect(() => {
    const retained = new Set(["runtime", "native"].flatMap((kind) =>
      toRows(page?.entries.filter((entry) => entry.kind === kind) ?? []).map((row) => `${row.kind}:${row.key}`)));
    setExpanded((previous) => {
      const next = new Set([...previous].filter((key) => retained.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [page]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [page, rows.length, lens]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const shown = entries.length;
  const total = lens === "raw" ? (page?.total.native ?? 0) : (page?.total.runtime ?? 0);

  return (
    <aside aria-label={t("inspector.title")} className="animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel md:static md:z-auto md:w-[min(460px,45vw)] md:shrink-0">
      <div {...dragProps} className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <Bug size={16} className="text-ink-secondary" /> {t("inspector.title")}
        </span>
        <button
          onClick={() => dispatch({ type: "toggleInspector", open: false })}
          aria-label={t("inspector.close")}
          title={t("inspector.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-hairline/40 px-4 pb-3">
        <div role="tablist" aria-label={t("inspector.views")} className="flex rounded-lg bg-inset p-0.5" onKeyDown={(event) => {
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowRight" ? (current + 1) % tabs.length
            : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          tabs[next].focus();
          tabs[next].click();
        }}>
          {(["run", "events", "raw"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              id={`inspector-tab-${l}`}
              aria-selected={lens === l}
              aria-controls={`inspector-panel-${l}`}
              tabIndex={lens === l ? 0 : -1}
              onClick={() => setLens(l)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium",
                activeLocale() === "en" && "capitalize",
                lens === l ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {tabLabel(l === "run" ? "inspector.run.title" : l === "events" ? "inspector.tab.events" : "inspector.tab.raw")}
            </button>
          ))}
        </div>
        {lens !== "run" && <span className="ml-auto text-[11px] text-ink-secondary">
          {page ? (shown < total ? t("inspector.entries.lastOf", { shown, total }) : t("inspector.entries.count", { count: shown })) : t("inspector.entries.loading")}
        </span>}
        {lens !== "run" && <button onClick={() => managedRefresh.current()} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" title={t("inspector.reload")}>
          <RefreshCw size={14} />
        </button>}
      </div>

      <div role="tabpanel" id={`inspector-panel-${lens}`} aria-labelledby={`inspector-tab-${lens}`} tabIndex={0} className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
      {lens === "run" ? <RunLog key={threadId} events={activity} /> : <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]">
        {error && <div className="px-4 py-3 text-danger">{t("inspector.loadFailed", { error })}</div>}
        {page && rows.length === 0 && !error && (
          <div className="px-4 py-6 text-ink-secondary">
            {t(lens === "raw" ? "inspector.emptyRaw" : "inspector.emptyEvents")}
          </div>
        )}
        {rows.map((row) => (
          <Row key={row.key} row={row} open={expanded.has(`${row.kind}:${row.key}`)} onToggle={() => toggle(`${row.kind}:${row.key}`)} />
        ))}
      </div>}
      </div>
    </aside>
  );
}

function Row({ row, open, onToggle }: { row: InspectorRow; open: boolean; onToggle: () => void }) {
  return (
    <div
      className={cn(
        "border-b border-hairline/20",
        row.tone === "boundary" && "bg-raised/40",
        row.tone === "error" && "bg-danger/10",
      )}
    >
      <button onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-raised/60">
        <span className="mt-[1px] shrink-0 text-ink-secondary">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className="shrink-0 tabular-nums text-ink-secondary">{formatTime(row.at)}</span>
        <span
          className={cn(
            "shrink-0 rounded px-1 text-[11px]",
            row.kind === "native" ? "bg-accent/15 text-accent" : row.tone === "error" ? "bg-danger/20 text-danger" : "bg-inset text-ink-secondary",
          )}
        >
          {row.tag}
          {row.count > 1 ? ` ×${row.count}` : ""}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", row.tone === "error" ? "text-danger" : "text-ink")}>{row.summary}</span>
      </button>
      {open && (
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all border-t border-hairline/20 bg-app px-3 py-2 text-[11px] leading-relaxed text-ink">
          {JSON.stringify(row.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
