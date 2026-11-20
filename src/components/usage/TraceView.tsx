import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { overlayPortal as createPortal } from "@/components/ModalPresence";
import { Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { fetchTrace } from "@/lib/usage-trace";
import type { TraceDetail } from "../../../shared/usage-trace";
import { TraceWaterfall } from "./TraceWaterfall";
import { useMenuMotion } from "../MenuMotion";
import "./trace-dialog.css";

/** Refetches at most this often while the run is live; the now-line ticks in between. */
const LIVE_REFRESH_MS = 1_000;

/** Loads one trace and keeps it current from the runtime events the app already receives. */
export function useTrace(id: string, at?: number): { detail: TraceDetail | null; error: string | null; now: number } {
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(detail?.root.running);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useRef<() => void>(() => {});

  useEffect(() => {
    let current = true;
    load.current = () => {
      void fetchTrace(id, at)
        .then((next) => { if (current) { setDetail(next); setError(null); setNow(Date.now()); } })
        .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    setDetail(null);
    load.current();
    return () => {
      current = false;
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [id, at]);

  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const stop = listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "runtime" || pending.current) return;
        pending.current = setTimeout(() => { pending.current = null; load.current(); }, LIVE_REFRESH_MS);
      },
      onMissedFrames: () => load.current(),
    });
    return () => { clearInterval(tick); stop(); };
  }, [running]);

  return { detail, error, now };
}

export function TraceView({ id, at, actions }: { id: string; at?: number; actions?: ReactNode }) {
  const { detail, error, now } = useTrace(id, at);
  if (detail) return <TraceWaterfall detail={detail} now={now} actions={actions} />;
  const missing = error !== null && /no such trace|404/i.test(error);
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-hairline/50 bg-card px-5 py-4 text-[13px] text-ink-secondary">
      {error === null && <Loader2 size={14} className="shrink-0 animate-spin" />}
      <span role={error === null ? undefined : "alert"} className="min-w-0 flex-1">{error === null ? t("trace.loading") : missing ? t("trace.missing") : t("trace.error", { error })}</span>
      {actions}
    </div>
  );
}

/** The waterfall over the chat, for one turn's "View trace". */
export function TraceDialog({ id, at, open, onClose }: { id: string; at?: number; open: boolean; onClose: () => void }) {
  const motion = useMenuMotion(open);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) dialog.showModal();
    else dialog.close();
  }, [open]);

  if (!motion.shown) return null;

  return createPortal(
    <dialog ref={dialogRef} className="trace-dialog fading-dialog" aria-label={t("trace.title")}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="trace-dialog-shell">
        <header className="trace-dialog-header">
          <h2>{t("trace.title")}</h2>
          <button type="button" autoFocus aria-label={t("trace.close")} onClick={onClose}
            className="flex size-8 items-center justify-center rounded-full text-ink-secondary interaction:bg-raised/50 hover:text-ink">
            <X size={17} />
          </button>
        </header>
        <div className="trace-dialog-content">
          <TraceView id={id} at={at} />
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
