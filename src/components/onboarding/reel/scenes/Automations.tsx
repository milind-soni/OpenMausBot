import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, MousePointer2, Zap } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { reducedMotion } from "@/lib/onboarding";
import { intlLocale, t } from "@/lib/i18n";
import { dayName } from "@/lib/schedule-label";
import type { SceneProps } from "./types";

const AUTOMATIONS_MS = 6200;

const POINTER_AT = 500;
const DROP_AT = 1100;
const FIRE_AT = 2200;
const DONE_AT = 3300;
const HOOK_AT = 4000;
const HOOK_DONE_AT = 5200;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const HOURS = [8, 9, 10, 11];
const ROW = 38;

type Phase = "grid" | "pointer" | "dropped" | "firing" | "done" | "hook" | "hookDone";
const ORDER: Phase[] = ["grid", "pointer", "dropped", "firing", "done", "hook", "hookDone"];
const reached = (phase: Phase, target: Phase) => ORDER.indexOf(phase) >= ORDER.indexOf(target);

function Receipt({ name, running, tone }: { name: string; running: boolean; tone: "accent" | "warning" }) {
  return (
    <div
      className={cn(
        "animate-rise flex w-[232px] items-center gap-2.5 rounded-2xl border bg-card px-3 py-2.5 transition-[border-color,box-shadow] duration-500",
        running
          ? "border-hairline/50 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)]"
          : "border-success/35 shadow-[0_14px_36px_-14px_rgba(56,213,145,0.35)]",
      )}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset">
        {running ? (
          <Loader2 size={14} className={cn("animate-spin", tone === "accent" ? "text-accent" : "text-warning")} />
        ) : (
          <CheckCircle2 size={14} className="animate-spot-in text-success" />
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-semibold text-ink">{name}</div>
        <div className={cn("text-[10.5px] font-medium transition-colors duration-300", running ? "text-ink-secondary" : "text-success")}>
          {t(running ? "onboarding.reel.demo.running2" : "onboarding.reel.demo.ranInChat")}
        </div>
      </div>
    </div>
  );
}

export function Automations({ playing, onCue, onEnded, label }: SceneProps) {
  const still = reducedMotion() || !playing;
  const [phase, setPhase] = useState<Phase>(still ? "hookDone" : "grid");

  useEffect(() => {
    if (still) return;
    setPhase("grid");
    onCue?.("drowsy");
    const timers = [
      setTimeout(() => setPhase("pointer"), POINTER_AT),
      setTimeout(() => setPhase("dropped"), DROP_AT),
      setTimeout(() => {
        setPhase("firing");
        onCue?.("working");
      }, FIRE_AT),
      setTimeout(() => {
        setPhase("done");
        onCue?.("proud");
      }, DONE_AT),
      setTimeout(() => {
        setPhase("hook");
        onCue?.("alerting");
      }, HOOK_AT),
      setTimeout(() => {
        setPhase("hookDone");
        onCue?.("happy");
      }, HOOK_DONE_AT),
      setTimeout(() => onEnded?.(), AUTOMATIONS_MS),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, still]);

  const pointer = phase === "pointer";
  const dropped = reached(phase, "dropped");
  const firing = reached(phase, "firing");
  const done = reached(phase, "done");
  const hook = reached(phase, "hook");
  const hookDone = reached(phase, "hookDone");
  const busy = (firing && !done) || (hook && !hookDone);

  return (
    <div className="relative h-full w-full overflow-hidden bg-inset" role="img" aria-label={label}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,transparent_55%,rgba(0,0,0,0.28)_100%)]" aria-hidden="true" />

      <div className="animate-rise absolute inset-x-5 top-4 overflow-hidden rounded-xl border border-hairline/40 bg-app shadow-[0_18px_44px_-20px_rgba(0,0,0,0.6)]">
        <div className="stagger grid grid-cols-[34px_repeat(5,1fr)] border-b border-hairline/40">
          <div />
          {DAYS.map((day, i) => (
            <div
              key={day}
              className={cn("animate-rise border-l border-hairline/40 py-1.5 text-center", i === 0 && "bg-gradient-to-b from-accent/[0.09] to-accent/[0.03]")}
              style={{ "--i": i + 1 } as React.CSSProperties}
            >
              <div className={cn("text-[8.5px] font-medium uppercase tracking-[0.14em]", i === 0 ? "text-accent" : "text-ink-secondary")}>{dayName(i + 1)}</div>
              <div className={cn("mx-auto mt-0.5 flex size-5 items-center justify-center rounded-full text-[10.5px] font-medium tabular-nums", i === 0 ? "bg-accent text-white shadow-[0_4px_12px_-4px_var(--color-accent)]" : "text-ink")}>
                {14 + i}
              </div>
            </div>
          ))}
        </div>
        <div className="relative grid grid-cols-[34px_repeat(5,1fr)]" style={{ height: HOURS.length * ROW }}>
          <div className="relative">
            {HOURS.map((hour, i) => (
              <div key={hour} className="absolute right-1.5 -translate-y-1/2 text-[8.5px] tabular-nums text-ink-tertiary" style={{ top: i * ROW }}>
                {new Date(2000, 0, 1, hour).toLocaleTimeString(intlLocale(), { hour: "numeric" })}
              </div>
            ))}
          </div>
          {DAYS.map((day, i) => (
            <div key={day} className={cn("relative border-l border-hairline/40", i === 0 && "bg-accent/[0.035]")}>
              {HOURS.map((hour, h) => (
                <div key={hour} className="absolute inset-x-0 border-t border-hairline/30" style={{ top: h * ROW }} />
              ))}
              {i === 0 && (
                <>
                  <div
                    className={cn("absolute inset-x-0.5 rounded-md transition-opacity duration-300", pointer ? "opacity-100" : "opacity-0")}
                    style={{ top: ROW + 1, height: ROW - 2, background: "color-mix(in oklab, var(--color-accent) 12%, transparent)", outline: "1px dashed color-mix(in oklab, var(--color-accent) 45%, transparent)", outlineOffset: -1 }}
                  />
                  <div
                    className={cn(
                      "absolute inset-x-1 flex items-center gap-1.5 overflow-hidden rounded-md border-l-2 border-accent bg-accent/15 px-1.5 py-1",
                      "transition-[transform,opacity,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
                      dropped ? "translate-y-0 scale-100 opacity-100 shadow-[0_2px_6px_-2px_rgba(0,0,0,0.4)]" : "-translate-y-3 scale-[0.98] opacity-0 shadow-[0_18px_28px_-10px_rgba(0,0,0,0.6)]",
                      busy && firing && !done && "animate-ripple",
                      hook && !hookDone && "animate-ripple",
                    )}
                    style={{ top: ROW + 2, height: ROW - 8 }}
                  >
                    <MausAvatar color="green" state={busy ? "working" : "idle"} size={16} animated={!still} trackPointer={false} />
                    <div className="min-w-0">
                      <div className="truncate text-[9.5px] font-semibold leading-tight text-ink">{t("onboarding.reel.demo.weeklyReport")}</div>
                      <div className="text-[8px] leading-tight tabular-nums text-ink-secondary">9:00 · {t("onboarding.reel.demo.weekly")}</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
          <div
            className="pointer-events-none absolute left-[34px] right-0 z-10 h-px bg-gradient-to-r from-danger via-danger/70 to-danger/20 transition-transform duration-[1100ms] ease-[cubic-bezier(0.77,0,0.175,1)]"
            style={{ top: 6, transform: `translateY(${firing ? ROW - 6 : 0}px)` }}
          >
            <span className="absolute -left-1 -top-[3px] size-1.5 rounded-full bg-danger shadow-[0_0_8px_2px_rgba(255,86,103,0.45)]" />
          </div>
        </div>
      </div>

      {(pointer || (dropped && !firing)) && (
        <MousePointer2
          size={16}
          className={cn(
            "absolute z-30 text-ink drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)] transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]",
            pointer ? "translate-x-0 translate-y-0 opacity-100" : "translate-x-6 -translate-y-8 opacity-0",
          )}
          style={{ left: 92, top: 96, fill: "var(--color-ink)" }}
        />
      )}

      <div className="absolute bottom-4 right-5 z-20 flex flex-col items-end gap-2">
        {firing && <Receipt name={t("onboarding.reel.demo.weeklyReport")} running={!done} tone="accent" />}
        {hook && <Receipt name={t("onboarding.reel.demo.webhookTask")} running={!hookDone} tone="warning" />}
      </div>

      {hook && (
        <div className="absolute bottom-4 left-5 z-20 flex items-center gap-3">
          <div className="animate-rise flex items-center gap-1.5 rounded-lg border border-hairline/50 bg-panel px-2.5 py-1.5 font-mono text-[9.5px] text-ink-secondary shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)]">
            <span className="font-semibold text-ink">POST</span> …/hooks/wh_7f3a
          </div>
          <Zap
            size={15}
            fill="currentColor"
            className={cn("text-warning drop-shadow-[0_0_6px_rgba(255,152,0,0.55)]", hookDone ? "opacity-0 transition-opacity duration-300" : "animate-bolt")}
          />
        </div>
      )}

      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div className={cn("absolute inset-0 -m-4 rounded-full bg-accent/20 blur-xl transition-opacity duration-500", busy ? "opacity-100" : "opacity-0")} aria-hidden="true" />
        <div className="relative drop-shadow-[0_8px_18px_rgba(0,0,0,0.45)]">
          <MausAvatar
            color="green"
            state={hookDone ? "happy" : hook ? "alerting" : done ? "proud" : firing ? "working" : "drowsy"}
            size={40}
            animated={!still}
            trackPointer={false}
          />
        </div>
      </div>
    </div>
  );
}
