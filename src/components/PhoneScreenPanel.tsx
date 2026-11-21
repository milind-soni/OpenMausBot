import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, Power } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { createPhoneStreamClient, PHONE_STREAM_CLOSE, type PhoneStreamClient, type PhoneStreamView } from "@/lib/phone-stream-client";
import { ANDROID_KEY_NAMES, AndroidKeyButton, AndroidNavButtons, fittedUnitPoint } from "./android-device-parts";

type Press = { pointerId: number; x: number; y: number; moveFrame: number | null };

const CONNECTING: PhoneStreamView = { status: { kind: "connecting" }, frame: null, held: false };

export function PhoneScreenPanel({ serial, name }: { serial: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<PhoneStreamClient | null>(null);
  const viewRef = useRef(CONNECTING);
  const textRef = useRef<HTMLInputElement>(null);
  const pressRef = useRef<Press | null>(null);
  const composingRef = useRef(false);
  const [view, setView] = useState(CONNECTING);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const client = createPhoneStreamClient({ serial, canvas }, (next) => {
      viewRef.current = next;
      setView(next);
    });
    clientRef.current = client;
    return () => {
      clientRef.current = null;
      client.stop();
    };
  }, [serial, attempt]);

  const drives = (shown: PhoneStreamView) => shown.held && shown.status.kind === "live";
  const driver = () => (drives(viewRef.current) ? clientRef.current : null);

  const videoPoint = (event: React.PointerEvent<HTMLDivElement>, clampToPicture = false) => {
    const frame = viewRef.current.frame;
    const unit = frame && fittedUnitPoint(event.currentTarget.getBoundingClientRect(), frame, event, clampToPicture);
    if (!frame || !unit) return null;
    return {
      x: Math.min(frame.width - 1, Math.floor(unit.x * frame.width)),
      y: Math.min(frame.height - 1, Math.floor(unit.y * frame.height)),
    };
  };

  const lift = (event: React.PointerEvent<HTMLDivElement>, at: { x: number; y: number } | null) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pressRef.current = null;
    if (press.moveFrame !== null) cancelAnimationFrame(press.moveFrame);
    driver()?.touch("up", (at ?? press).x, (at ?? press).y);
  };

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const client = driver();
    const movesFocusOut = event.key === "Tab" && event.shiftKey;
    if (!client || movesFocusOut || event.metaKey || event.ctrlKey || event.altKey) return;
    const named = ANDROID_KEY_NAMES[event.key];
    if (named) {
      event.preventDefault();
      client.key(named);
    } else if ([...event.key].length === 1) {
      event.preventDefault();
      client.text(event.key);
    }
  };

  const sendText = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = textRef.current;
    const client = driver();
    if (!client || !field?.value || composingRef.current) return;
    client.text(field.value);
    field.value = "";
  };

  const { status, held } = view;
  const driving = drives(view);
  const streaming = status.kind === "connecting" || status.kind === "live";

  return (
    <>
      {streaming && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-2.5">
          <span role="status" className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            {held && <span className="size-1.5 rounded-full bg-success" />}
            {t(held ? "computer.inControl" : "computer.android.watching")}
          </span>
          <button
            onClick={() => (held ? clientRef.current?.handBack() : clientRef.current?.take())}
            disabled={status.kind !== "live"}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] disabled:opacity-50",
              held ? "bg-accent font-medium text-accent-ink hover:brightness-110" : "bg-control text-ink hover:bg-raised-hover",
            )}
          >
            <Hand size={13} /> {t(held ? "computer.handBack" : "computer.takeControl")}
          </button>
        </div>
      )}

      <div
        role="application"
        aria-label={t("computer.android.screenAria", { name })}
        tabIndex={0}
        onKeyDown={keyDown}
        onPointerDown={(event) => {
          const client = driver();
          const point = videoPoint(event);
          if (!client || !point || pressRef.current || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          pressRef.current = { pointerId: event.pointerId, ...point, moveFrame: null };
          client.touch("down", point.x, point.y);
        }}
        onPointerMove={(event) => {
          const press = pressRef.current;
          const point = videoPoint(event, true);
          if (!press || press.pointerId !== event.pointerId || !point) return;
          press.x = point.x;
          press.y = point.y;
          press.moveFrame ??= requestAnimationFrame(() => {
            press.moveFrame = null;
            if (pressRef.current === press) driver()?.touch("move", press.x, press.y);
          });
        }}
        onPointerUp={(event) => lift(event, videoPoint(event, true))}
        onPointerCancel={(event) => lift(event, null)}
        onLostPointerCapture={(event) => lift(event, null)}
        className={cn(
          "relative mx-auto flex h-[520px] w-full touch-none items-center justify-center overflow-hidden overscroll-none rounded-[28px] bg-black outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-accent",
          driving && "cursor-pointer",
        )}
      >
        <canvas ref={canvasRef} className={cn("pointer-events-none h-full w-full select-none object-contain", status.kind !== "live" && "opacity-40")} />
        {status.kind !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[12px] leading-relaxed text-white/80">
            {status.kind === "connecting" ? (
              <Loader2 size={20} className="animate-spin" />
            ) : status.kind === "closed" ? (
              <>
                <span role="alert">{status.reason || t("computer.android.liveStopped")}</span>
                {status.code === PHONE_STREAM_CLOSE.failed && (
                  <button
                    onClick={() => setAttempt((count) => count + 1)}
                    className="rounded-lg bg-white/15 px-3 py-1.5 text-white hover:bg-white/25"
                  >
                    {t("computer.android.retry")}
                  </button>
                )}
              </>
            ) : (
              t("computer.android.liveUnsupported")
            )}
          </div>
        )}
      </div>

      {streaming && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <AndroidNavButtons onKey={(key) => driver()?.key(key)} disabled={!driving} />
            <AndroidKeyButton onClick={() => driver()?.key("wakeup")} disabled={!driving}>
              <Power size={13} /> {t("computer.android.wake")}
            </AndroidKeyButton>
          </div>
          <form onSubmit={sendText}>
            <input
              ref={textRef}
              type="text"
              autoComplete="off"
              disabled={!driving}
              aria-label={t("computer.android.textAria")}
              placeholder={t("computer.android.textPlaceholder")}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              className="w-full rounded-lg bg-raised px-3 py-2 text-[12px] text-ink outline-none placeholder:text-ink-secondary focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </form>
        </>
      )}

      <div className="text-center text-[11px] leading-relaxed text-ink-secondary">
        {t("computer.android.secureNote")}
      </div>
    </>
  );
}
