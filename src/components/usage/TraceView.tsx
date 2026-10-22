import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { fetchTrace } from "@/lib/usage-trace";
import type { TraceDetail } from "../../../shared/usage-trace";
import { TraceWaterfall } from "./TraceWaterfall";

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
export function TraceDialog({ id, at, onClose }: { id: string; at?: number; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-3 sm:p-8"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={t("trace.title")} className="w-full max-w-[1100px] animate-pop-in shadow-2xl">
        <TraceView id={id} at={at} actions={(
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("trace.close")}
            className="-mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        )} />
      </div>
    </div>,
    document.body,
  );
}
