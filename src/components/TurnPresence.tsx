import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { WorkingTimer } from "@/components/WorkingIndicator";
import { phraseAt, phraseHoldMs } from "@/lib/live-activity";
import { quietText } from "@/lib/now-steps";
import { t } from "@/lib/i18n";
import { formatElapsed } from "@/lib/working-time";
import type { StepQuiet } from "../../shared/turn-progress";

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
function ShimmerPhrase({ text, className }: { text: string; className?: string }) {
  const [delay] = useState(() => `-${Date.now() % 2000}ms`);
  return (
    <span
      className={cn("thinking-shimmer animate-shimmer [grid-area:1/1]", className)}
      style={{ animationDelay: `${delay}, 0ms` }}
    >
      {text}
    </span>
  );
}

const NOTHING: readonly string[] = [];
// The spaces keep copied text readable; the flex gap does the spacing on screen.
const Dot = () => <span aria-hidden="true" className="text-[12px] text-ink-tertiary"> · </span>;

/** "last output 2 min ago" counts on by itself; the other states change only with a new frame. */
function QuietPart({ quiet }: { quiet: StepQuiet }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (quiet.kind !== "output") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [quiet]);
  return <><Dot /><span data-turn-quiet="" className="text-[12px] text-ink-tertiary">{quietText(quiet, now)}</span></>;
}

/** The turn's live status line: "Working · 1m 12s · Running scrape.py · busy, no output yet". The lead word and the
 * timer stay for the whole turn; `phrases` say what is happening now and rotate through their alternates; `size` is how
 * much of the file is written; `quiet` is how a long step is doing. With nothing to say the line is the lead and the timer
 * alone. The part that is live shimmers. `simple` draws Simple mode's quiet line instead: the avatar and one phrase for
 * what is happening now. With a `card`, the line is a button that unfolds it underneath. */
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
  simple = false,
  detail,
  hover,
  quiet,
  card,
  cardLabel,
  className,
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
  simple?: boolean;
  /** Simple mode: Advanced's wording for what is happening now, kept in the row's tooltip with the timer and size. */
  detail?: string;
  /** The whole command, query or address behind the phrase. */
  hover?: string;
  quiet?: StepQuiet;
  card?: ReactNode;
  cardLabel?: string;
  className?: string;
}) {
  const [mounted, setMounted] = useState(visible);
  const [presencePhase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const [open, setOpen] = useState(false);
  const wasAnswering = useRef(answering);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const statusId = useId();

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
  const expandable = Boolean(card) && showWorking;
  useEffect(() => {
    if (!expandable) setOpen(false);
  }, [expandable]);
  useEffect(() => {
    if (!open) return;
    const fold = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inside = Boolean(root.current?.contains(document.activeElement));
      if (!inside && document.activeElement && document.activeElement !== document.body) return;
      event.preventDefault();
      setOpen(false);
      if (inside) toggle.current?.focus();
    };
    document.addEventListener("keydown", fold);
    return () => document.removeEventListener("keydown", fold);
  }, [open]);
  const lead = label ?? t("chat.activity.working");
  const now = phrases && phrases.length > 0 ? phrases : null;
  const { current, previous } = useRotatingPhrase(now ?? NOTHING, phase ?? now?.[0] ?? "", seed, mounted && showWorking && now !== null);
  if (!mounted) return null;
  const status = showWorking && simple ? (
    <span id={statusId} className="flex min-w-0 items-baseline gap-x-1.5 text-[14px] leading-[22px] text-ink-tertiary" data-turn-status>
      <span className="turn-phrase turn-phrase-quiet relative grid min-w-0" title={hover} data-turn-now={now ? "" : undefined}>
        {now ? (
          <ShimmerPhrase key={`in:${current}`} text={current} className={cn("truncate", previous !== null && "turn-phrase-in")} />
        ) : (
          <span>{label ?? t("chat.typing")}</span>
        )}
      </span>
      {now && quiet && <QuietPart quiet={quiet} />}
    </span>
  ) : showWorking ? (
    <span id={statusId} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 leading-none" data-turn-status>
      {now ? <span className="text-[13px] text-ink-secondary">{lead}</span> : <ShimmerPhrase text={lead} className="text-[13px]" />}
      {since !== null && (
        <>
          <Dot />
          <WorkingTimer since={since} className="text-[12px] text-ink-tertiary" />
        </>
      )}
      {now && (
        <>
          <Dot />
          {/* One phrase at a time: a fading old phrase sat out of flow and a longer one drew over the size beside it. */}
          <span className="turn-phrase relative grid min-w-0 max-w-full text-[13px]" title={hover} data-turn-now>
            <ShimmerPhrase
              key={`in:${current}`}
              text={current}
              className={cn("truncate", previous !== null && "turn-phrase-in")}
            />
          </span>
          {size && (
            <>
              <Dot />
              <span className="text-[12px] tabular-nums text-ink-tertiary" data-turn-size>{size}</span>
            </>
          )}
          {quiet && <QuietPart quiet={quiet} />}
        </>
      )}
    </span>
  ) : null;
  return (
    <div ref={root} className={cn("turn-presence flex min-w-0 max-w-full flex-col items-start", className)}>
      <div
        title={simple && showWorking ? [lead, since !== null ? formatElapsed(Date.now() - since) : null, detail ?? (now ? current : null), size].filter(Boolean).join(" · ") : undefined}
        className={cn(
          simple ? "flex h-9 min-w-0 max-w-full items-center gap-2 ps-2" : "flex min-w-0 max-w-full items-center gap-2",
          presencePhase === "think" && "turn-mascot-in",
          presencePhase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {expandable ? (
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls={cardId}
            aria-label={cardLabel}
            aria-describedby={statusId}
            onClick={() => setOpen((shown) => !shown)}
            className="turn-now-toggle"
          >
            {status}
            <ChevronDown aria-hidden="true" size={12} strokeWidth={2} className={cn("turn-now-chevron", open && "rotate-180")} />
          </button>
        ) : status}
      </div>
      {expandable && open && (
        <div id={cardId} role="region" aria-label={cardLabel} className="turn-now-card">
          {card}
        </div>
      )}
    </div>
  );
}
