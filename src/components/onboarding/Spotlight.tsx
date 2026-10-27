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
  progress?: string;
  primary?: Action;
  secondary?: Action;
  onDone: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [settled, setSettled] = useState(false);

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

  if (anchor && !rect) return null;

  const viewportW = window.innerWidth;
  const cardWidth = Math.min(CARD_W, viewportW - 24);
  const viewportH = window.innerHeight;
  let transform: string;
  let below = true;
  let beside = false;
  if (
    rect &&
    placement === "right" &&
    rect.x + rect.w + GAP + cardWidth <= viewportW - 12
  ) {
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
            boxShadow:
              "0 0 0 5px color-mix(in srgb, var(--color-accent) 28%, transparent), 0 0 36px 6px color-mix(in srgb, var(--color-accent) 30%, transparent)",
          }}
          aria-hidden="true"
        />
      )}
      {/* Outer layer positions (transition), inner layer enters (keyframes): the two never fight over transform. */}
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
            <div className="text-[14px] leading-relaxed text-ink">
              {children}
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              {primary && (
                <button
                  type="button"
                  autoFocus
                  onClick={primary.onClick}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-transform duration-150 active:scale-[0.98]"
                >
                  {primary.label}
                </button>
              )}
              {progress && (
                <span className="text-[12px] tabular-nums text-ink-secondary">
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
