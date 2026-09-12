// A spotlight on a live element: the window dims except for a cutout around
// the anchor, and a small card with the guide sits beside it. The anchor is
// found by its `data-tour` id, never by a class name, so refactors cannot
// silently break the tour. The dim layer takes no pointer events, so the
// user can keep working (typing, clicking the control) while it is up; the
// control inside the cutout is what the step usually asks them to press.
//
// Motion: on first mount the cutout eases from the full window down to the
// anchor and the card scales in from the anchor's side. When the anchor
// changes (the next tour step) the component stays mounted, so the cutout
// and the card slide to the new control instead of dimming everything
// again. Under reduced motion everything simply appears. With no anchor
// the card sits centred over the dimmed window.
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { MausState } from "@/lib/mascot";
import { reducedMotion } from "@/lib/onboarding";

const PAD = 8;
const RADIUS = 14;
const CARD_W = 320;
const GAP = 12;

type Rect = { x: number; y: number; w: number; h: number };

function measure(anchor: string): Rect | null {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`),
  ).filter((el) => el.getClientRects().length > 0);
  // the newest visible match: a second approval card is the one to explain
  const el = all[all.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0 || r.top >= window.innerHeight) return null;
  return {
    x: r.left - PAD,
    y: r.top - PAD,
    w: r.width + PAD * 2,
    h: r.height + PAD * 2,
  };
}

/** An even-odd polygon: the whole viewport minus the anchor's rectangle. */
function cutout(r: Rect | null): string {
  if (!r) return "polygon(0 0, 100% 0, 100% 100%, 0 100%)";
  const x1 = r.x,
    y1 = r.y,
    x2 = r.x + r.w,
    y2 = r.y + r.h;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
}

interface Action {
  label: string;
  onClick: () => void;
}

export function Spotlight({
  anchor,
  placement,
  mascot = "curious",
  children,
  progress,
  primary,
  secondary,
  onDone,
}: {
  anchor: string | null;
  placement: "above" | "below" | "right";
  mascot?: MausState;
  children: ReactNode;
  /** "Step 2 of 6", shown small under the text. */
  progress?: string;
  /** The filled button; omit when the step ends by the user's own action. */
  primary?: Action;
  /** The quiet button, usually Skip. */
  secondary?: Action;
  /** Escape. */
  onDone: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [settled, setSettled] = useState(false);

  // Follow the anchor: layout, scroll, resize, and the anchor's own size.
  // A new anchor that is not on screen yet (a menu still opening) keeps
  // the previous rectangle, so the cutout waits in place and then slides.
  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setRect((prev) => measure(anchor) ?? prev),
      );
    };
    update();
    const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
    const ro = el ? new ResizeObserver(update) : null;
    if (el) ro?.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  // first paint at the full window, next frame at the anchor: that is the
  // transition the dim layer eases through
  useEffect(() => {
    if (reducedMotion()) {
      setSettled(true);
      return;
    }
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  // an anchored step whose control is not on screen yet shows nothing; the
  // observers above will find it when it appears
  if (anchor && !rect) return null;

  const viewportW = window.innerWidth;
  const cardWidth = Math.min(CARD_W, viewportW - 24);
  const viewportH = window.innerHeight;
  // The card is positioned with a transform, never left/top, so a change of
  // anchor slides it on the compositor. "bottom" placement is expressed as
  // a translate of -100% so the card's own height need not be known.
  let transform: string;
  let below = true;
  let beside = false;
  if (
    rect &&
    placement === "right" &&
    rect.x + rect.w + GAP + cardWidth <= viewportW - 12
  ) {
    // beside a sidebar control, centred on it, kept clear of the window edges
    beside = true;
    transform = `translate3d(${rect.x + rect.w + GAP}px, ${Math.max(12, Math.min(rect.y + rect.h / 2 - 70, viewportH - 180))}px, 0)`;
  } else if (rect) {
    const left = Math.max(12, Math.min(rect.x, viewportW - cardWidth - 12));
    const roomBelow = viewportH - (rect.y + rect.h) - GAP;
    const roomAbove = rect.y - GAP;
    below =
      placement === "below"
        ? roomBelow >= 140 || roomAbove < roomBelow
        : roomAbove < 140 && roomBelow > roomAbove;
    if (roomBelow < 140 && roomAbove < 140) {
      // the anchor fills the window (a panel, a page): sit inside it, top right
      below = true;
      transform = `translate3d(${Math.max(12, Math.min(rect.x + rect.w - cardWidth - GAP * 2, viewportW - cardWidth - 12))}px, ${Math.max(12, rect.y + GAP * 2)}px, 0)`;
    } else {
      transform = below
        ? `translate3d(${left}px, ${rect.y + rect.h + GAP}px, 0)`
        : `translate3d(${left}px, calc(${rect.y - GAP}px - 100%), 0)`;
    }
  } else {
    transform = "translate3d(calc(50vw - 50%), calc(50vh - 50%), 0)";
  }

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[60]"
      aria-live="polite"
    >
      <div
        className="absolute inset-0 bg-black/55 transition-[clip-path] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ clipPath: cutout(settled ? rect : null) }}
        aria-hidden="true"
      />
      {rect && (
        <div
          className="absolute ring-2 ring-accent transition-opacity duration-300"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            opacity: settled ? 1 : 0,
            borderRadius: RADIUS,
            // a soft halo so the control reads as lit, not merely outlined
            boxShadow:
              "0 0 0 5px color-mix(in srgb, var(--color-accent) 28%, transparent), 0 0 36px 6px color-mix(in srgb, var(--color-accent) 30%, transparent)",
          }}
          aria-hidden="true"
        />
      )}
      {/* the outer layer only positions (a transition on transform); the
          inner layer only enters (keyframes on transform and opacity), so
          the two never fight over the same property */}
      <div
        data-tour-card
        className="pointer-events-auto absolute left-0 top-0 w-[320px] transition-transform duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform, width: cardWidth }}
      >
        <div
          role="dialog"
          className={cn(
            "flex items-start gap-3 rounded-2xl border border-hairline/50 bg-panel p-3.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]",
            rect
              ? beside
                ? "origin-left"
                : below
                  ? "origin-top-left"
                  : "origin-bottom-left"
              : "origin-center",
            settled ? "animate-spot-in motion-reduce:animate-none" : "opacity-0",
          )}
        >
          <div className="shrink-0 drop-shadow-[0_6px_14px_rgba(0,0,0,0.35)]">
            <MausAvatar
              color="green"
              state={mascot}
              size={38}
              trackPointer={false}
            />
          </div>
          <div
            key={anchor ?? "centre"}
            className="min-w-0 flex-1 animate-rise motion-reduce:animate-none"
          >
            <div className="text-[13.5px] leading-relaxed text-ink">
              {children}
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              {primary && (
                <button
                  type="button"
                  autoFocus
                  onClick={primary.onClick}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-transform duration-150 active:scale-[0.98]"
                >
                  {primary.label}
                </button>
              )}
              {progress && (
                <span className="text-[11.5px] tabular-nums text-ink-secondary">
                  {progress}
                </span>
              )}
              {secondary && (
                <button
                  type="button"
                  onClick={secondary.onClick}
                  className="ml-auto text-[12px] text-ink-secondary transition-colors hover:text-ink"
                >
                  {secondary.label}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
