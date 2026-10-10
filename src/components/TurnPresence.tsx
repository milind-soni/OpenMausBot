// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. The moment there is an answer, the label is gone while
// the canonical transcript row performs the settle-in animation above it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WorkingTimer } from "@/components/WorkingIndicator";
import { phraseAt, phraseHoldMs } from "@/lib/live-activity";

const FADE_MS = 320;

/**
 * Walks a phase's phrases on a gentle 4 to 6 second hold. A new phase starts
 * over at its plain label. The outgoing phrase lingers for one fade so the two
 * can crossfade in place.
 */
export function useRotatingPhrase(
  phrases: readonly string[],
  phase: string,
  seed: string,
  active: boolean,
): { current: string; previous: string | null } {
  const phaseSeed = `${seed}|${phase}`;
  // the step belongs to its phase. A new phase resets it during render, so
  // its first frame reads step 0 and a phase that comes back later starts
  // over too, even when the phase between them ended before its first swap
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

// The sheen keeps its place across phrase swaps instead of restarting at the
// left edge on every new word. 2s matches --animate-shimmer. The delay is
// fixed when a phrase mounts, so a re-render never nudges a running sheen.
function ShimmerPhrase({ text, className, hidden }: { text: string; className?: string; hidden?: boolean }) {
  const [delay] = useState(() => `-${Date.now() % 2000}ms`);
  return (
    <span
      aria-hidden={hidden || undefined}
      className={cn("thinking-shimmer animate-shimmer [grid-area:1/1]", className)}
      // the second value is the crossfade's, which must start now
      style={{ animationDelay: `${delay}, 0ms` }}
    >
      {text}
    </span>
  );
}

export function TurnPresence({
  avatar,
  visible,
  label = "Thinking",
  phrases,
  phase,
  seed = "",
  answering = false,
  since = null,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  /** rotating phrases for the current step, plain label first. Wins over `label`. */
  phrases?: readonly string[];
  /** stable key for the current step. A new phase starts over at its first phrase. */
  phase?: string;
  /** turn identity, so one turn always reads the same and two turns differ */
  seed?: string;
  answering?: boolean;
  /** Turn start (epoch ms) — shows a self-ticking elapsed readout while working. */
  since?: number | null;
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
  const list = phrases && phrases.length > 0 ? phrases : [label];
  const { current, previous } = useRotatingPhrase(list, phase ?? list[0], seed, mounted && showWorking);
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
          <span className="flex items-baseline gap-2 leading-none">
            {/* the outgoing phrase floats over the incoming one, so the width
                follows the shown phrase and the timer moves once per swap */}
            <span className="turn-phrase relative grid text-[13px]">
              {previous !== null && previous !== current && (
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
            {since !== null && (
              <WorkingTimer since={since} className="text-[11.5px] text-ink-tertiary" />
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
