import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  limitLine, limitsCheckedAt, loadLimits, reportsUsage, resetTime, usageBars, usageRows, usageTone, useEngineLimits, USAGE_BARS, windowLabel,
  type EngineLimit, type UsageTone,
} from "@/lib/limit-resets";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Message } from "@/state/store";
import { failedTurnNotice } from "@/lib/failed-turn";
import { codexUsageLimitReached } from "../../shared/codex-usage-limit";
import { openBotSettings } from "./bot-panel/panel-link";
import { threadUpdatedLabel } from "./SidebarThreadRow";

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

/** A usage-limit refusal whose reset time has passed stays in the transcript as evidence, collapsed, not as a current
 * blocker: the reset passing does not prove today's quota is available again. Null while the refusal is still current. */
export function usePastLimitNotice(tool: NonNullable<Message["tool"]>, messageAt: number | undefined) {
  const at = tool.limitResetsAt;
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const remaining = at - Date.now();
      if (remaining <= 0) {
        setClock(Date.now());
        return;
      }
      timer = setTimeout(arm, Math.min(remaining + 1_000, 2_147_483_647));
    };
    arm();
    return () => { if (timer) clearTimeout(timer); };
  }, [at]);
  if (typeof at !== "number" || !Number.isFinite(at) || typeof messageAt !== "number" || messageAt > at || clock < at) return null;
  const { cause, notice } = failedTurnNotice(tool);
  if (!codexUsageLimitReached(cause)) return null;
  return (
    <details className="my-1 w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-lg border border-hairline/40 bg-raised px-3 py-2 text-[12px] text-ink-secondary">
      <summary className="cursor-pointer">{t("chat.error.pastUsageLimit")}</summary>
      <p className="mt-2 break-words">{notice ?? cause}</p>
    </details>
  );
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

/** When the usage was last read, each window's share left with its reset and a track filled by use; at the limit, how it
 * clears and a fresh check. */
export function UsageRows({ limit }: { limit: EngineLimit }) {
  const [checking, setChecking] = useState(false);
  const now = Date.now();
  const checkedAt = limitsCheckedAt();
  return (
    <div data-usage-rows className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] font-semibold leading-[18px] text-ink">{t("limits.cardTitle", { engine: limit.name })}</span>
        {checkedAt > 0 && <span data-usage-checked className="shrink-0 text-[12px] leading-4 text-ink-tertiary">{t("limits.checked", { when: threadUpdatedLabel(checkedAt, now) })}</span>}
      </div>
      {usageRows(limit).map((row) => (
        <div key={row.window} data-usage-row={row.window} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-3 text-[12px] leading-4">
            <span className="shrink-0 text-ink-secondary">{windowLabel(row.window)}</span>
            <span className={cn("ms-auto min-w-0 truncate text-end tabular-nums", row.tone === "fine" ? "text-ink" : "text-warning")}>
              <span className="font-medium">{row.tone === "out" ? t("limits.windowAtLimit") : t("planUsage.left", { remaining: row.left })}</span>
              {row.resetsAt !== null && row.resetsAt > now && ` · ${t("limits.resets", { time: resetTime(row.resetsAt, now) })}`}
            </span>
          </div>
          <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-ink/[0.08]">
            <div data-usage-track className={cn("h-full rounded-full", row.tone === "fine" ? "bg-ink-tertiary" : "bg-warning")} style={{ width: `${100 - row.left}%` }} />
          </div>
        </div>
      ))}
      {limit.blocked && (
        <div className="flex items-start justify-between gap-3 border-t-[0.5px] border-ink/10 pt-2.5 text-[12px] leading-4">
          <p className="min-w-0 text-ink-tertiary">{t("limits.clearsOnReply", { engine: limit.name })}</p>
          <button type="button" data-usage-check disabled={checking} aria-busy={checking}
            onClick={() => { setChecking(true); void loadLimits(true).finally(() => setChecking(false)); }}
            className="shrink-0 font-medium text-ink underline underline-offset-2 hover:text-ink-secondary disabled:cursor-wait disabled:opacity-60">
            {t("common.checkAgain")}
          </button>
        </div>
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
