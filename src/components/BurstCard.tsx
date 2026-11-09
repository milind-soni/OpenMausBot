import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Layers, Loader2, Square, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, openThread, useStore } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import type { LocaleKey } from "@/locales";
import type { BurstCardData, BurstChildRow, BurstChildStatus, BurstView } from "../../shared/burst";

const BUTTON = "rounded-lg border border-hairline/50 px-2.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50";
const PRIMARY = "rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white hover:bg-accent/90 disabled:opacity-50";

const STATUS: Record<BurstChildStatus, LocaleKey> = {
  queued: "burst.status.queued", running: "burst.status.running", done: "burst.status.done", failed: "burst.status.failed", cancelled: "burst.status.cancelled",
};

function compact(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function StatusIcon({ status }: { status: BurstChildStatus }) {
  const className = "size-3.5 shrink-0";
  if (status === "running") return <Loader2 aria-hidden="true" className={cn(className, "animate-spin text-accent")} />;
  if (status === "done") return <CheckCircle2 aria-hidden="true" className={cn(className, "text-success")} />;
  if (status === "failed") return <XCircle aria-hidden="true" className={cn(className, "text-danger")} />;
  if (status === "cancelled") return <Square aria-hidden="true" className={cn(className, "text-ink-tertiary")} />;
  return <CircleAlert aria-hidden="true" className={cn(className, "text-ink-tertiary")} />;
}

/** What a phase reads as, once a burst is past its preview. */
function headline(card: BurstCardData): string {
  if (card.phase === "merging") return t("burst.phase.merging");
  if (card.phase === "done") return `${t("burst.phase.done")} · ${t("burst.progress", { done: card.counts.done, total: card.total })}`;
  if (card.phase === "cancelled") return t("burst.phase.cancelled");
  return t("burst.progress", { done: card.counts.done, total: card.total });
}

export function BurstCounts({ card }: { card: BurstCardData }) {
  const parts = [
    card.counts.running > 0 && t("burst.running", { count: card.counts.running }),
    card.counts.queued > 0 && t("burst.waiting", { count: card.counts.queued }),
    card.counts.failed > 0 && t("burst.failed", { count: card.counts.failed }),
  ].filter(Boolean);
  return parts.length ? <p className="text-[12px] text-ink-secondary">{parts.join(" · ")}</p> : null;
}

/** The card a burst shows in its chat: a preview until the person presses Run, then one progress card. */
export function BurstCard({ card }: { card: BurstCardData }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<BurstView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const moved = `${card.phase}:${card.counts.done}:${card.counts.running}:${card.counts.failed}:${card.counts.cancelled}`;
  const live = open || editing;

  useEffect(() => {
    if (!live) return;
    let current = true;
    void api<BurstView>(`/api/bursts/${card.burstId}`).then((next) => { if (current) setView(next); }).catch(() => {});
    return () => { current = false; };
  }, [live, moved, card.burstId]);

  async function press(action: "run" | "cancel" | "retry" | "edit", body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(false);
    try {
      await api(`/api/bursts/${card.burstId}/${action}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const preview = card.phase === "preview";
  const failedNames = card.failed?.map((one) => one.title).join(", ");
  return (
    <section aria-label={t("burst.statusLabel", { status: headline(card) })}
      className="w-full max-w-[680px] rounded-2xl border border-hairline/45 bg-card px-3.5 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-inset">
          {card.phase === "running" || card.phase === "merging"
            ? <Loader2 aria-hidden="true" className="size-4 animate-spin text-accent" />
            : <Layers aria-hidden="true" className="size-4 text-ink-secondary" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate text-[14px] font-semibold text-ink">{t("burst.title", { task: compact(card.task, 120) })}</h3>
          {preview ? (
            <>
              <p className="text-[12px] text-ink-secondary">{t("burst.plan", { count: card.total, model: card.modelName, parallel: card.parallel, minutes: card.estimateMinutes })}</p>
              <p className="truncate text-[12px] text-ink-tertiary">{card.sample.join(" · ")}{card.total > card.sample.length ? ` · ${t("burst.moreItems", { count: card.total - card.sample.length })}` : ""}</p>
              {card.taskLimit !== undefined && (
                <p className="text-[12px] text-ink-secondary">{t("burst.limitCut", { total: card.total, requested: card.requested, limit: card.taskLimit })}{card.smallPlan ? ` ${t("burst.morePlan")}` : ""}</p>
              )}
            </>
          ) : (
            <>
              <p aria-live="polite" className="text-[13px] font-medium text-ink">{headline(card)}</p>
              <BurstCounts card={card} />
              {failedNames && (
                <p className="line-clamp-2 text-[12px] text-ink-secondary">
                  {card.failedMore ? t("burst.notFinishedMore", { names: failedNames, count: card.failedMore }) : t("burst.notFinished", { names: failedNames })}
                </p>
              )}
            </>
          )}
          {error && <p className="text-[12px] text-danger">{t("burst.error.action")}</p>}
          {editing && view && <BurstEditor view={view} busy={busy} onBack={() => setEditing(false)} onSave={(plan) => { void press("edit", plan).then((ok) => { if (ok) setEditing(false); }); }} />}
          {!editing && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
              {preview ? (
                <>
                  <button type="button" disabled={busy} onClick={() => { void press("run"); }} className={PRIMARY}>{t("burst.run")}</button>
                  <button type="button" disabled={busy} onClick={() => { setError(false); setEditing(true); }} className={BUTTON}>{t("burst.edit")}</button>
                  <button type="button" disabled={busy} onClick={() => { void press("cancel"); }} className={BUTTON}>{t("burst.cancel")}</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setOpen((value) => !value)} className={cn(BUTTON, "flex items-center gap-1")}>
                    {open ? <ChevronDown aria-hidden="true" className="size-3" /> : <ChevronRight aria-hidden="true" className="size-3" />}
                    {t(open ? "burst.hideTasks" : "burst.showTasks")}
                  </button>
                  {card.counts.failed > 0 && (card.phase === "running" || card.phase === "done") && (
                    <button type="button" disabled={busy} onClick={() => { void press("retry"); }} className={BUTTON}>{t("burst.retryFailed")}</button>
                  )}
                  {(card.phase === "running" || card.phase === "merging") && (
                    <button type="button" disabled={busy} onClick={() => { void press("cancel"); }} className={BUTTON}>{t("burst.cancelAll")}</button>
                  )}
                </>
              )}
            </div>
          )}
          {open && view && !preview && <BurstRows botId={card.botId} rows={view.children} />}
        </div>
      </div>
    </section>
  );
}

function BurstEditor({ view, busy, onSave, onBack }: { view: BurstView; busy: boolean; onSave: (plan: { instructions: string; items: string[] }) => void; onBack: () => void }) {
  const [instructions, setInstructions] = useState(view.instructions);
  const [items, setItems] = useState(view.items.join("\n"));
  const lines = items.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className="space-y-2 pt-1.5">
      <label className="block text-[12px] text-ink-secondary">
        {t("burst.editInstructions")}
        <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3}
          className="mt-1 w-full rounded-lg border border-hairline/50 bg-transparent px-2 py-1.5 text-[13px] text-ink" />
      </label>
      <label className="block text-[12px] text-ink-secondary">
        {t("burst.editItems")}
        <textarea value={items} onChange={(event) => setItems(event.target.value)} rows={Math.min(10, Math.max(3, lines.length))}
          className="mt-1 w-full rounded-lg border border-hairline/50 bg-transparent px-2 py-1.5 text-[13px] text-ink" />
      </label>
      <div className="flex gap-1.5">
        <button type="button" disabled={busy || lines.length < 2} onClick={() => onSave({ instructions, items: lines })} className={PRIMARY}>{t("burst.save")}</button>
        <button type="button" disabled={busy} onClick={onBack} className={BUTTON}>{t("burst.back")}</button>
      </div>
    </div>
  );
}

/** The parts under the card, opened on demand; each started part opens its own thread. */
export function BurstRows({ botId, rows }: { botId: string; rows: BurstChildRow[] }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  return (
    <ul className="max-h-[280px] space-y-0.5 overflow-y-auto pt-1.5">
      {rows.map((row) => {
        const label = (
          <>
            <StatusIcon status={row.status} />
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
            <span className="shrink-0 text-ink-tertiary">{t(STATUS[row.status])}</span>
          </>
        );
        return (
          <li key={row.seq}>
            {row.threadId ? (
              <button type="button" title={row.error ?? t("chat.openThread", { title: row.title })} onClick={() => openThread(dispatch, { botId, threadId: row.threadId! }, state, showThreads)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">{label}</button>
            ) : (
              <div className="flex w-full items-center gap-2 px-1.5 py-1 text-[12px] text-ink-secondary">{label}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
