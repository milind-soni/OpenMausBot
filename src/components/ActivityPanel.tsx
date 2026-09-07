// A bot's activity: what it did, in plain words, with the outcome. The
// receipt view — for the person who wants to know what ran while they were
// away, not the wire-level inspector next to it.
//
// Nothing here is captured for the panel's sake. The harness folds the
// thread's runtime events and the decision log into rows (server/activity.ts);
// this only asks for them, and asks again when a turn settles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListChecks, RefreshCw, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  formatActivityTime,
  groupActivityByDay,
  outcomeChip,
  type ActivityRow,
  type ChipTone,
} from "@/lib/activity";
import { openLiveEvents } from "@/lib/live-events";
import type { RuntimeEvent } from "../../server/contracts.ts";

const LIMIT = 300;

const TONE_CLASS: Record<ChipTone, string> = {
  ok: "bg-accent/12 text-accent",
  danger: "bg-danger/15 text-danger",
  accent: "bg-accent/12 text-accent",
  warn: "bg-warning/15 text-warning",
};

export function ActivityPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const res = await fetch(`/api/bots/${bot.id}/activity?limit=${LIMIT}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      // SAFETY: this same-version renderer calls the harness's typed
      // activity endpoint; malformed transport data is handled by catch.
      const next = (await res.json()) as { rows: ActivityRow[] };
      if (controller.signal.aborted) return;
      setRows(next.rows);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [bot.id]);

  useEffect(() => {
    setRows(null);
    void load();
    return () => loadAbort.current?.abort();
  }, [load]);

  // Re-read when one of this bot's turns settles, or when a card is
  // answered: both change what a row says. Own EventSource on purpose,
  // the same way the inspector does — the store folds runtime events into
  // chat state and does not re-emit them.
  const threadIds = useMemo(
    () => new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]),
    [bot.threadId, bot.tasks],
  );
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const stopLive = openLiveEvents({
      screens: false,
      onSnapshotRequired: async () => {
        await load();
        return true;
      },
      onFrame: (frame) => {
        if (frame.kind !== "runtime") return;
        const event = frame.event;
        if (!event || Array.isArray(event) || Object(event) !== event) return;
        // SAFETY: runtime stream frames are produced from the typed harness
        // bus; this guard rejects non-object transport corruption.
        const runtime = event as RuntimeEvent;
        if (!threadIds.has(runtime.threadId)) return;
        if (
          runtime.type === "turn.completed" ||
          runtime.type === "runtime.error" ||
          runtime.type === "request.opened" ||
          runtime.type === "request.resolved" ||
          runtime.type === "item.completed"
        ) {
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => void load(), 400);
        }
      },
    });
    return () => {
      stopLive();
      if (settle) clearTimeout(settle);
    };
  }, [threadIds, load]);

  const days = useMemo(() => (rows ? groupActivityByDay(rows, new Date()) : []), [rows]);

  const jump = (row: ActivityRow) => {
    if (row.threadId !== bot.threadId && threadIds.has(row.threadId)) {
      dispatch({ type: "switchTask", botId: bot.id, threadId: row.threadId });
    }
  };

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <ListChecks size={16} className="text-ink-secondary" /> Activity
        </span>
        <span className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Reload"
            aria-label="Reload activity"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleActivity", open: false })}
            aria-label="Close Activity"
            title="Close Activity"
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </span>
      </div>

      <p className="border-b border-hairline/40 px-4 pb-3 text-[12px] text-ink-secondary">
        Every tool {bot.name} used and every approval it asked for, newest first.
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <div className="px-4 py-3 text-[13px] text-danger">couldn&apos;t load: {error}</div>}
        {rows && rows.length === 0 && !error && (
          <div className="px-4 py-6 text-[13px] text-ink-secondary">
            Nothing yet. Once {bot.name} runs a tool or asks for an approval, it shows up here.
          </div>
        )}
        {!rows && !error && <div className="px-4 py-6 text-[13px] text-ink-secondary">Loading…</div>}
        {days.map((day) => (
          <section key={day.key}>
            <h3 className="sticky top-0 bg-panel px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
              {day.label}
            </h3>
            {day.rows.map((row) => (
              <ActivityLine key={`${row.threadId}:${row.at}:${row.tool}:${row.requestId ?? ""}`} row={row} current={row.threadId === bot.threadId} onJump={() => jump(row)} />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function ActivityLine({ row, current, onJump }: { row: ActivityRow; current: boolean; onJump: () => void }) {
  const chip = outcomeChip(row.outcome);
  return (
    <button
      type="button"
      onClick={onJump}
      className={cn(
        "flex w-full items-start gap-3 border-b border-hairline/20 px-4 py-2 text-left",
        current ? "hover:bg-raised/60" : "hover:bg-raised/60",
      )}
      title={current ? row.tool : `${row.tool} — in another task; click to open it`}
    >
      <span className="mt-[2px] shrink-0 tabular-nums text-[11px] text-ink-secondary">{formatActivityTime(row.at)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] text-ink">
          {row.app && <span className="font-medium">{row.app}</span>}
          {row.app && <span className="text-ink-secondary">·</span>}
          <span className="truncate">{row.label}</span>
        </span>
        {row.summary && (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-secondary">{row.summary}</span>
        )}
      </span>
      <span className={cn("mt-[2px] shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium", TONE_CLASS[chip.tone])}>
        {chip.text}
      </span>
    </button>
  );
}
