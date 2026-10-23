import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WorkingTimer } from "@/components/WorkingIndicator";
import { phraseAt, phraseHoldMs } from "@/lib/live-activity";
import { t } from "@/lib/i18n";

const FADE_MS = 320;

export function useRotatingPhrase(
  phrases: readonly string[],
  phase: string,
  seed: string,
  active: boolean,
): { current: string; previous: string | null } {
  const phaseSeed = `${seed}|${phase}`;
  const [clock, setClock] = useState({ phaseSeed, step: 0 });
  if (clock.phaseSeed !== phaseSeed) setClock({ phaseSeed, step: 0 });
  const step = clock.phaseSeed === phaseSeed ? clock.step : 0;
  const [previous, setPrevious] = useState<string | null>(null);
  const current = phraseAt(phrases, phaseSeed, step);
  const shown = useRef(current);

  useEffect(() => {
    if (!active || phrases.length < 2) return;
    const timer = setTimeout(() => setClock({ phaseSeed, step: step + 1 }), phraseHoldMs(phaseSeed, step));
    return () => clearTimeout(timer);
  }, [active, phrases.length, phaseSeed, step]);

  useEffect(() => {
    if (shown.current === current) return;
    setPrevious(shown.current);
    shown.current = current;
    const timer = setTimeout(() => setPrevious(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [current]);

  return { current, previous };
}

// 2s matches --animate-shimmer.
function ShimmerPhrase({ text, className, hidden }: { text: string; className?: string; hidden?: boolean }) {
  const [delay] = useState(() => `-${Date.now() % 2000}ms`);
  return (
    <span
      aria-hidden={hidden || undefined}
      className={cn("thinking-shimmer animate-shimmer [grid-area:1/1]", className)}
      style={{ animationDelay: `${delay}, 0ms` }}
    >
      {text}
    </span>
  );
}

const NOTHING: readonly string[] = [];
// The spaces keep copied text readable; the flex gap does the spacing on screen.
const Dot = () => <span aria-hidden="true" className="text-[11.5px] text-ink-tertiary"> · </span>;

/** The turn's live status line: "Working · 1m 12s · Writing index.html · 14 KB". The lead word and the timer stay for
 * the whole turn; `phrases` say what is happening now and rotate through their alternates; `size` is how much of the
 * file is written. With nothing to say the line is the lead and the timer alone. The part that is live shimmers. */
export function TurnPresence({
  avatar,
  visible,
  label,
  phrases,
  phase,
  seed = "",
  answering = false,
  since = null,
  size,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  phrases?: readonly string[];
  phase?: string;
  seed?: string;
  answering?: boolean;
  since?: number | null;
  size?: string;
}) {
  const [mounted, setMounted] = useState(visible);
  const [presencePhase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  const showWorking = presencePhase === "think";
  const lead = label ?? t("chat.activity.working");
  const now = phrases && phrases.length > 0 ? phrases : null;
  const { current, previous } = useRotatingPhrase(now ?? NOTHING, phase ?? now?.[0] ?? "", seed, mounted && showWorking && now !== null);
  if (!mounted) return null;
  return (
    <div className="turn-presence flex flex-col items-start">
      <div
        className={cn(
          "flex items-center gap-2",
          presencePhase === "think" && "turn-mascot-in",
          presencePhase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {showWorking ? (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 leading-none" data-turn-status>
            {now ? <span className="text-[13px] text-ink-secondary">{lead}</span> : <ShimmerPhrase text={lead} className="text-[13px]" />}
            {since !== null && (
              <>
                <Dot />
                <WorkingTimer since={since} className="text-[11.5px] text-ink-tertiary" />
              </>
            )}
            {now && (
              <>
                <Dot />
                <span className="turn-phrase relative grid text-[13px]" data-turn-now>
                  {previous && previous !== current && (
                    <ShimmerPhrase
                      key={`out:${previous}`}
                      text={previous}
                      className="turn-phrase-out absolute start-0 top-0 whitespace-nowrap"
                      hidden
                    />
                  )}
                  <ShimmerPhrase
                    key={`in:${current}`}
                    text={current}
                    className={previous !== null ? "turn-phrase-in" : undefined}
                  />
                </span>
                {size && (
                  <>
                    <Dot />
                    <span className="text-[11.5px] tabular-nums text-ink-tertiary" data-turn-size>{size}</span>
                  </>
                )}
              </>
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
