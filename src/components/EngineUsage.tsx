import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  limitLine, loadLimits, reportsUsage, resetTime, usageBars, usageRows, usageTone, useEngineLimits, USAGE_BARS, windowLabel,
  type EngineLimit, type UsageTone,
} from "@/lib/limit-resets";
import type { Routine } from "@/lib/routines";
import { api, useStore } from "@/state/store";
import { openBotSettings } from "./bot-panel/panel-link";

/** The stopped turn's "Continue at 3:40 PM when your limit resets": one click sets up a one-time automation in this
 * conversation that picks up where it stopped. Undefined when there is nothing to offer. */
export function useLimitResetContinue(botId: string | undefined, threadId: string | undefined, resetsAt: number | undefined) {
  const { dispatch } = useStore();
  const [state, setState] = useState<"idle" | "working" | "set">("idle");
  if (!botId || !threadId || !resetsAt || resetsAt <= Date.now() || state === "set") return undefined;
  return {
    label: t("chat.limit.continueAt", { time: resetTime(resetsAt) }),
    onClick: () => {
      if (state === "working") return;
      setState("working");
      void api<{ routine?: Routine }>("/api/limit-resets/continue", { method: "POST", body: JSON.stringify({ botId, threadId }) })
        .then((response) => {
          if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
          setState("set");
        })
        .catch((cause) => {
          setState("idle");
          dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
        });
    },
  };
}

function useEngineUsage(engine: string | undefined): EngineLimit | undefined {
  const limit = useEngineLimits().find((candidate) => candidate.engine === engine);
  return reportsUsage(limit) ? limit : undefined;
}

const BAR_STEP = 4;
const BAR_WIDTH = 2;
const GLYPH_HEIGHT = 14;
/** The bars end this far above the box's bottom, which puts their flat base on the text baseline. */
const BASELINE_INSET = 2;
const TALLEST = GLYPH_HEIGHT - BASELINE_INSET;
const GLYPH_WIDTH = BAR_STEP * USAGE_BARS - (BAR_STEP - BAR_WIDTH);
const TONE_INK: Record<UsageTone, string> = { fine: "text-ink-tertiary", near: "text-warning", out: "text-warning" };

/** Four rising bars on whole pixels, filled for the usage left; at the limit every bar is empty and struck through. */
export function UsageGlyph({ limit, className }: { limit: EngineLimit; className?: string }) {
  const filled = usageBars(limit);
  const tone = usageTone(limit);
  const step = Math.round(TALLEST / 2 / (USAGE_BARS - 1));
  return (
    <svg aria-hidden="true" data-usage-glyph={filled} width={GLYPH_WIDTH} height={GLYPH_HEIGHT} viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`}
      className={cn("shrink-0", TONE_INK[tone], className)}>
      {Array.from({ length: USAGE_BARS }, (_, index) => {
        const height = TALLEST - (USAGE_BARS - 1 - index) * step;
        return <rect key={index} x={index * BAR_STEP} y={TALLEST - height} width={BAR_WIDTH} height={height} fill="currentColor" opacity={index < filled ? 1 : 0.3} />;
      })}
      {tone === "out" && <path d={`M0.75 ${TALLEST - 0.75}L${GLYPH_WIDTH - 0.75} 0.75`} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />}
    </svg>
  );
}

/** Each window's share left, its reset and a thin bar; at the limit, how it clears and a fresh check. */
export function UsageRows({ limit }: { limit: EngineLimit }) {
  const [checking, setChecking] = useState(false);
  const now = Date.now();
  return (
    <div data-usage-rows className="flex flex-col gap-2">
      <div className="text-[13px] font-medium leading-[18px] text-ink">{limit.name}</div>
      {usageRows(limit).map((row) => (
        <div key={row.window} data-usage-row={row.window} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 text-[12px] leading-4">
            <span className="text-ink-secondary">{windowLabel(row.window)}</span>
            <span className={cn("font-medium tabular-nums", row.tone === "fine" ? "text-ink" : "text-warning")}>
              {row.tone === "out" ? t("limits.windowAtLimit") : t("planUsage.left", { remaining: row.left })}
            </span>
            {row.resetsAt !== null && row.resetsAt > now && (
              <span className="ms-auto shrink-0 tabular-nums text-ink-tertiary">{t("limits.resets", { time: resetTime(row.resetsAt, now) })}</span>
            )}
          </div>
          <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-ink/[0.08]">
            <div className={cn("h-full rounded-full", row.tone === "fine" ? "bg-ink-tertiary" : "bg-warning")} style={{ width: `${row.left}%` }} />
          </div>
        </div>
      ))}
      {limit.blocked && (
        <p className="text-[12px] leading-4 text-ink-tertiary">
          {t("limits.clearsOnReply", { engine: limit.name })}{" "}
          <button type="button" data-usage-check disabled={checking} aria-busy={checking}
            onClick={() => { setChecking(true); void loadLimits(true).finally(() => setChecking(false)); }}
            className="font-medium text-accent-text hover:underline disabled:cursor-wait disabled:opacity-60">
            {t("common.checkAgain")}
          </button>
        </p>
      )}
    </div>
  );
}

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;
const CARD_WIDTH = 272;
const CARD_GAP = 8;
const keep = (event: SyntheticEvent) => event.stopPropagation();

function UsageCard({ limit, anchor, onEnter, onLeave }: { limit: EngineLimit; anchor: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const below = anchor.top < window.innerHeight / 2;
  const style: CSSProperties = {
    position: "fixed", width: CARD_WIDTH,
    left: Math.max(CARD_GAP, Math.min(anchor.left + anchor.width / 2 - CARD_WIDTH / 2, window.innerWidth - CARD_WIDTH - CARD_GAP)),
    ...(below ? { top: anchor.bottom + CARD_GAP } : { bottom: window.innerHeight - anchor.top + CARD_GAP }),
  };
  // A portal still bubbles React events to the model button it was opened from, which would open the model menu.
  return (
    <div data-usage-card role="group" aria-label={limit.name} style={style} className="menu-surface z-[90] px-3 py-2.5"
      onPointerEnter={onEnter} onPointerLeave={onLeave} onPointerDown={keep} onMouseDown={keep} onClick={keep} onKeyDown={keep}>
      <UsageRows limit={limit} />
    </div>
  );
}

/** The usage left as bars inside the model button, with every window in a card on hover. `compact` hides the bars in
 * the narrow chat header while there is plenty left. The words are in the button's name for screen readers, and the
 * same rows open at the top of the model menu for keyboard and touch. */
export function UsageBars({ engine, compact = false, hover = true, className }: { engine: string | undefined; compact?: boolean; hover?: boolean; className?: string }) {
  const limit = useEngineUsage(engine);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const spot = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!limit) return null;
  const tone = usageTone(limit);
  const later = (next: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(next, ms);
  };
  const enter = (event?: ReactPointerEvent) => {
    if (!hover || event?.pointerType === "touch" || spot.current?.closest("[aria-expanded=true]")) return;
    later(() => setAnchor(spot.current?.getBoundingClientRect() ?? null), anchor ? 0 : HOVER_OPEN_MS);
  };
  const leave = () => later(() => setAnchor(null), HOVER_CLOSE_MS);
  return (
    // An empty title keeps the button's own tooltip from opening over the card.
    <span ref={spot} title="" data-usage-bars={tone} data-usage-warn={tone === "fine" ? undefined : ""} className={cn("flex shrink-0 items-center", className)}
      onPointerEnter={enter} onPointerLeave={leave} onPointerDown={() => later(() => setAnchor(null), 0)}>
      <UsageGlyph limit={limit} className={compact && tone === "fine" ? "@max-4xl/chathead:hidden" : undefined} />
      <span className="sr-only">{limitLine(limit, Date.now(), ", ")}</span>
      {anchor && createPortal(<UsageCard limit={limit} anchor={anchor} onEnter={() => enter()} onLeave={leave} />, document.body)}
    </span>
  );
}

/** Widens the narrow header's square model button to fit the bars while they warn. */
export const USAGE_WARN_WIDENS = "@max-4xl/chathead:has-[[data-usage-warn]]:w-auto @max-4xl/chathead:has-[[data-usage-warn]]:gap-1.5 @max-4xl/chathead:has-[[data-usage-warn]]:px-2";

/** The rows at the top of the open model menu. */
export function UsageMenuRows({ engine }: { engine: string | undefined }) {
  const limit = useEngineUsage(engine);
  if (!limit) return null;
  return <div data-usage-menu className="shrink-0 border-b-[0.5px] border-ink/10 px-3.5 py-2.5"><UsageRows limit={limit} /></div>;
}

/** A phone's header has no model button: near or at the limit, the bars stand alone and open the bot's model. */
export function UsageAlert({ engine }: { engine: string | undefined }) {
  const { dispatch } = useStore();
  const limit = useEngineUsage(engine);
  if (!limit || usageTone(limit) === "fine") return null;
  const line = limitLine(limit, Date.now(), ", ");
  return (
    <button type="button" data-usage-alert aria-label={line} title={line} onClick={() => openBotSettings(dispatch, "model")}
      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-card">
      <UsageGlyph limit={limit} />
    </button>
  );
}
