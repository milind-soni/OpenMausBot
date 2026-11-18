// Small one-color glyphs for Buddies and rooms, drawn to sit beside
// lucide icons: a 24-unit box, currentColor, a 2-unit outline.
import type { SVGProps } from "react";
import type { Bot, Group } from "@/state/store";
import { BUDDY_BODY_PATH, BUDDY_BODY_TRANSFORM, BUDDY_EYE_PATH, BUDDY_EYES } from "./BuddyAvatar";
import { MausAvatar } from "./Avatar";

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

// The Buddy artwork's 1024 canvas, fitted into a 24 box with room for the outline.
const FIT = 20 / 1024;
// A 2-unit outline, expressed in the body path's own (matrix-scaled, ~2.04×) units.
const BODY_STROKE = 2 / FIT / 2.043;

/** A Buddy: scalloped outline, two eyes. Use where a lucide icon would go. */
export function BuddyIcon({ size = 24, ...props }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
      <g transform={`translate(2 2) scale(${FIT})`}>
        <path
          transform={BUDDY_BODY_TRANSFORM}
          d={BUDDY_BODY_PATH}
          stroke="currentColor"
          strokeWidth={BODY_STROKE}
          strokeLinejoin="round"
        />
        {BUDDY_EYES.map((eye, index) => (
          <path key={index} transform={eye.transform} d={BUDDY_EYE_PATH} fill="currentColor" />
        ))}
      </g>
    </svg>
  );
}

/** A room: a house with a Buddy's two eyes in its doorway. */
export function RoomIcon({ size = 24, ...props }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M3.5 10.2 12 3.4l8.5 6.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <rect x="9.1" y="11.6" width="2.1" height="3.6" rx="1.05" fill="currentColor" />
      <rect x="12.8" y="11.6" width="2.1" height="3.6" rx="1.05" fill="currentColor" />
    </svg>
  );
}

/**
 * A room in the conversation list: a house, with its Buddies gathered at
 * the side. The member who is working comes first and shows it.
 */
export function RoomAvatar({ group, members, size = 40 }: { group: Group; members: Bot[]; size?: number }) {
  const queued = new Set(group.queuedBotIds ?? []);
  const ordered = [...members].sort(
    (a, b) => Number(b.id === group.busyBotId) - Number(a.id === group.busyBotId),
  );
  const shown = ordered.slice(0, 2);
  const extra = members.length - shown.length;
  const unit = size / 40;
  const buddy = Math.round(17 * unit);
  const house = Math.round(30 * unit);

  return (
    <span className="relative block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <svg
        width={house}
        height={house}
        viewBox="0 0 32 32"
        className="absolute left-0"
        style={{ top: Math.round(7 * unit) }}
      >
        <path
          d="M3 13.4 16 3l13 10.4V26a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"
          fill="var(--color-raised-hover)"
          stroke="rgb(255 255 255 / 0.22)"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M12.6 29v-5.6a3.4 3.4 0 0 1 6.8 0V29z" fill="var(--color-inset)" />
      </svg>
      {/* The Buddies gather along the house's right wall; the one working sits on top. */}
      {shown.map((bot, index) => (
        <span
          key={bot.id}
          className="absolute right-0 block"
          style={{ top: Math.round((index ? 21 : 2) * unit), zIndex: shown.length - index }}
        >
          <MausAvatar
            color={bot.color}
            state={bot.id === group.busyBotId ? "working" : queued.has(bot.id) ? "queued" : "happy"}
            size={buddy}
            trackPointer={false}
          />
        </span>
      ))}
      {extra > 0 && (
        <span className="absolute -bottom-1 -right-1 z-10 flex h-[14px] min-w-[14px] items-center justify-center rounded-full border border-panel bg-raised px-0.5 text-[8.5px] font-semibold leading-none text-ink">
          +{extra}
        </span>
      )}
    </span>
  );
}
