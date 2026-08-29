// The raw event inspector: what a thread's turns actually looked like on
// the wire, for the moment a bot misbehaves and the chat view can't say
// why. Two lenses over the same thread:
//
//   Events — the harness's normalized RuntimeEvent stream: turns, tool
//            items, requests, token usage, errors. Follows live over SSE.
//   Raw    — the provider's own protocol messages, verbatim (the native
//            tee). Read from disk; refreshed when a turn settles.
//
// Nothing here is captured for the panel's sake — both logs already exist
// under ~/.openmausbot (server/harness/bus.ts, server/drivers/native.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { formatTime, toRows, type InspectorEntry, type InspectorPage, type InspectorRow } from "@/lib/inspector";
import { openLiveEvents } from "@/lib/live-events";
import type { RuntimeEvent } from "../../server/contracts.ts";

type Lens = "events" | "raw";

export function InspectorPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const threadId = bot.threadId;
  const [lens, setLens] = useState<Lens>("events");
  const [page, setPage] = useState<InspectorPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadAbort = useRef<AbortController | null>(null);
  const managedRefresh = useRef<() => void>(() => {});

  const load = useCallback(async (): Promise<boolean> => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const res = await fetch(`/api/threads/${threadId}/events?limit=400`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      // SAFETY: this same-version renderer calls the harness's typed
      // inspector endpoint; malformed transport data is handled by catch.
      const next = (await res.json()) as InspectorPage;
      if (controller.signal.aborted) return false;
      setPage(next);
      setError(null);
      return true;
    } catch (e) {
      if (controller.signal.aborted) return false;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [threadId]);

  // history from disk on open / thread change
  useEffect(() => {
    setPage(null);
    setExpanded(new Set());
    stickToBottom.current = true;
    void load();
    return () => loadAbort.current?.abort();
  }, [load]);

  // live: append this thread's runtime events as they stream, and re-read
  // the disk when a turn settles so the native tee (not on the SSE) catches
  // up. Own EventSource on purpose: the store folds runtime events into
  // chat state and does not re-emit them.
  useEffect(() => {
    let alive = true;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let refreshGeneration = 0;
    let refreshing = false;
    const pendingRuntime: RuntimeEvent[] = [];

    const appendRuntime = (runtime: RuntimeEvent) => {
      setPage((prev) => {
        // A disk refresh and replay can overlap. eventId is canonical, so a
        // replayed entry already present in the snapshot is an exact no-op.
        if (
          prev?.entries.some(
            (entry) => entry.kind === "runtime" && entry.data.eventId === runtime.eventId,
          )
        ) {
          return prev;
        }
        const entry: InspectorEntry = { kind: "runtime", at: runtime.createdAt, data: runtime };
        if (!prev) return { entries: [entry], total: { runtime: 1, native: 0 } };
        return { entries: [...prev.entries, entry], total: { ...prev.total, runtime: prev.total.runtime + 1 } };
      });
    };

    const flushPendingRuntime = () => {
      for (const runtime of pendingRuntime.splice(0)) appendRuntime(runtime);
    };

    const refresh = async (flushLiveOnFailure: boolean): Promise<boolean> => {
      const generation = ++refreshGeneration;
      refreshing = true;
      const loaded = await load();
      // A later refresh aborts the earlier fetch. Only its completion owns
      // the buffered live tail, otherwise the earlier finally can flush
      // frames immediately before the newer snapshot overwrites them.
      if (!alive || generation !== refreshGeneration) return false;
      refreshing = false;
      // An ordinary Reload keeps the previous page when its fetch fails, so
      // live frames buffered during that request still belong on that page.
      // A replacement snapshot must not expose them: its caller will close
      // and replay the stream from the last acknowledged cursor instead.
      if (!loaded) {
        if (flushLiveOnFailure) flushPendingRuntime();
        return false;
      }
      flushPendingRuntime();
      return true;
    };
    const requestRefresh = () => void refresh(true);
    const refreshFromSnapshot = (): Promise<boolean> => {
      // A refused resume starts a new stream generation. Frames retained by
      // an earlier failed refresh will be present in the new disk snapshot or
      // replayed again, so do not carry them across the generation boundary.
      pendingRuntime.splice(0);
      return refresh(false);
    };
    managedRefresh.current = requestRefresh;

    const stopLive = openLiveEvents({
      screens: false,
      onSnapshotRequired: refreshFromSnapshot,
      onFrame: (frame) => {
        if (frame.kind !== "runtime") return;
        const event = frame.event;
        if (!event || Array.isArray(event) || Object(event) !== event) return;
        // SAFETY: runtime stream frames are produced from the typed harness
        // bus; this guard rejects non-object transport corruption.
        const runtime = event as RuntimeEvent;
        if (runtime.threadId !== threadId) return;
        if (refreshing) pendingRuntime.push(runtime);
        else appendRuntime(runtime);
        if (runtime.type === "turn.completed" || runtime.type === "runtime.error") {
          if (settle) clearTimeout(settle);
          settle = setTimeout(requestRefresh, 400);
        }
      },
    });
    return () => {
      alive = false;
      if (managedRefresh.current === requestRefresh) managedRefresh.current = () => {};
      stopLive();
      if (settle) clearTimeout(settle);
    };
  }, [threadId, load]);

  const entries = useMemo(
    () => (page ? page.entries.filter((e) => (lens === "raw" ? e.kind === "native" : e.kind === "runtime")) : []),
    [page, lens],
  );
  const rows = useMemo(() => toRows(entries), [entries]);

  // follow the tail unless the user has scrolled up to read
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [page?.entries.length, rows.length, lens]);
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
    <aside className="animate-panel-in flex h-full w-[460px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <Bug size={16} className="text-ink-secondary" /> Inspector
        </span>
        <button
          onClick={() => dispatch({ type: "toggleInspector", open: false })}
          aria-label="Close the Inspector"
          title="Close the Inspector"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-hairline/40 px-4 pb-3">
        <div className="flex rounded-lg bg-inset p-0.5">
          {(["events", "raw"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLens(l)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium capitalize",
                lens === l ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-ink-secondary">
          {page ? (shown < total ? `last ${shown} of ${total}` : `${shown} entries`) : "loading…"}
        </span>
        <button onClick={() => managedRefresh.current()} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" title="Reload from disk">
          <RefreshCw size={14} />
        </button>
      </div>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
        {error && <div className="px-4 py-3 text-danger">couldn't load: {error}</div>}
        {page && rows.length === 0 && !error && (
          <div className="px-4 py-6 text-ink-secondary">
            {lens === "raw" ? "No native protocol messages recorded for this thread yet." : "No runtime events for this thread yet."}
          </div>
        )}
        {rows.map((row) => (
          <Row key={row.key} row={row} open={expanded.has(row.key)} onToggle={() => toggle(row.key)} />
        ))}
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
            "shrink-0 rounded px-1 text-[10.5px]",
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
