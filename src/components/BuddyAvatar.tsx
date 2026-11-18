// The Gerer Buddy: the scalloped body and two eyes from Assets/Buddy Avater,
// drawn as one inline SVG on the placement guide's 1024×1024 canvas. Only the
// body turns; the face stays upright and readable. Every look and movement is
// CSS (BuddyAvatar.css) keyed off data-mood, so a state change is one
// attribute and the browser does the animating.
import { forwardRef, memo, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { MausState } from "@/lib/mascot";
import "./BuddyAvatar.css";

/** BuddyBody.svg's path and matrix; the export's -9.82 slice offset is removed, centring it on 512,512. */
export const BUDDY_BODY_TRANSFORM = "matrix(1.769343,1.021531,-1.021531,1.769343,97.81171,-1319.392747)";
export const BUDDY_BODY_PATH =
  "M623.767,424.333C660.019,424.333 692.739,442.428 709.774,467.298C739.405,461.757 775.336,472.099 800.971,497.733C826.605,523.368 836.947,559.299 831.406,588.93C856.276,605.965 874.371,638.685 874.371,674.937C874.371,711.19 856.276,743.91 831.406,760.944C836.947,790.575 826.605,826.507 800.971,852.141C775.336,877.776 739.405,888.117 709.774,882.576C692.739,907.447 660.019,925.542 623.767,925.542C587.514,925.542 554.794,907.447 537.76,882.576C508.129,888.117 472.197,877.776 446.563,852.141C420.929,826.507 410.587,790.575 416.128,760.944C391.257,743.91 373.162,711.19 373.162,674.937C373.162,638.685 391.257,605.965 416.128,588.93C410.587,559.299 420.929,523.368 446.563,497.733C472.197,472.099 508.129,461.757 537.76,467.298C554.794,442.428 587.514,424.333 623.767,424.333Z";

/** The eye path both eye SVGs share. */
export const BUDDY_EYE_PATH =
  "M253,341C289.426,341 319,377.079 319,421.517L319,518.483C319,562.921 289.426,599 253,599C216.574,599 187,562.921 187,518.483L187,421.517C187,377.079 216.574,341 253,341Z";

/**
 * Eye placement from "Buddy placement guides.png": 183×292 eyes at y 284,
 * x 210 (BuddyRightEye, on the viewer's left) and x 472.74 (BuddyLeftEye),
 * 80.5 apart. The matrices are the exports' own with their slice offsets removed.
 */
export const BUDDY_EYES = [
  { x: 210, y: 284, width: 183, height: 292, transform: "matrix(1.380726,0,0,1.131783,-48.195736,-101.937984)" },
  { x: 472.744186, y: 284, width: 183, height: 292, transform: "matrix(1.380726,0,0,1.131783,214.54845,-101.937984)" },
] as const;

export const BUDDY_EYE_FILL = "#FBEAFF";

/** Visual moods the stylesheet draws. Every MausState resolves to one. */
export type BuddyMood =
  | "idle"
  | "working"
  | "thinking"
  | "writing"
  | "searching"
  | "preview"
  | "testing"
  | "listening"
  | "queued"
  | "connecting"
  | "attention"
  | "notifying"
  | "error"
  | "limited"
  | "paused"
  | "success"
  | "celebrate"
  | "happy"
  | "curious"
  | "excited"
  | "proud"
  | "playful"
  | "shy"
  | "drowsy"
  | "sleeping"
  | "suspicious"
  | "confused"
  | "sad"
  | "surprised";

/** Retired engine states, drawn as their nearest Buddy look. */
const RETIRED_MOOD: Partial<Record<MausState, BuddyMood>> = {
  waking: "idle",
  angry: "suspicious",
  bored: "drowsy",
  laughing: "happy",
  scared: "surprised",
  orbit: "working",
  radar: "searching",
  progress: "working",
  spawning: "celebrate",
  humming: "happy",
  loading: "connecting",
  dictating: "listening",
  sending: "working",
  receiving: "writing",
  uploading: "working",
  alerting: "attention",
  bouncing: "excited",
  dragging: "curious",
  "powering-down": "sleeping",
};

export function moodFor(state: MausState): BuddyMood {
  return RETIRED_MOOD[state] ?? (state as BuddyMood);
}

/** Below this size the badges, brackets and sparkles become noise; motion and eyes carry the state. */
export const BUDDY_DETAIL_MIN_SIZE = 32;

const BADGE: Partial<Record<BuddyMood, string>> = { attention: "!", error: "!", limited: "◷" };

export type BuddyAvatarHandle = {
  blink: () => void;
  /** One extra full turn of the body, on top of whatever it is doing. */
  spin: (durationMs?: number) => void;
};

export type BuddyAvatarProps = {
  /** Body color, any CSS color. */
  color: string;
  state?: MausState;
  size?: number;
  label?: string | null;
  /** Gaze offset, -1..1 on each axis. */
  gaze?: { x: number; y: number };
  /** Multiplies eye size. */
  eyeScale?: number;
  /** A one-shot beat played over the current state, replayed whenever `beatKey` changes. */
  beat?: "pop" | "hop" | "wiggle" | "nudge" | null;
  beatKey?: number;
  /** Off renders the state's resting look, still. */
  animated?: boolean;
};

// One listener for every Buddy: a hidden window stops all their animation.
let visibilityWired = false;
function pauseWhenHidden() {
  if (visibilityWired || typeof document === "undefined") return;
  visibilityWired = true;
  const sync = () => document.documentElement.toggleAttribute("data-buddies-hidden", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}

const BEAT_MS = { pop: 700, hop: 900, wiggle: 650, nudge: 900 } as const;

function BuddyAvatarComponent(
  { color, state = "idle", size = 44, label, gaze, eyeScale, beat = null, beatKey = 0, animated = true }: BuddyAvatarProps,
  ref: React.Ref<BuddyAvatarHandle>,
) {
  useEffect(pauseWhenHidden, []);
  const mood = moodFor(state);
  const shadeId = `buddy-shade-${useId().replace(/:/g, "")}`;

  // Imperative beats restart their CSS animation by re-keying the element.
  const [blinkKey, setBlinkKey] = useState(0);
  const [spin, setSpin] = useState<{ key: number; ms: number } | null>(null);
  const spinTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useImperativeHandle(ref, () => ({
    blink: () => setBlinkKey((k) => k + 1),
    spin: (ms = 800) => {
      clearTimeout(spinTimer.current);
      setSpin((prev) => ({ key: (prev?.key ?? 0) + 1, ms }));
      spinTimer.current = setTimeout(() => setSpin(null), ms);
    },
  }));
  useEffect(() => () => clearTimeout(spinTimer.current), []);

  const [activeBeat, setActiveBeat] = useState<BuddyAvatarProps["beat"]>(null);
  useEffect(() => {
    if (!beat || !animated) return;
    setActiveBeat(beat);
    const timer = setTimeout(() => setActiveBeat(null), BEAT_MS[beat]);
    return () => clearTimeout(timer);
  }, [beat, beatKey, animated]);

  const detailed = size >= BUDDY_DETAIL_MIN_SIZE;
  const badge = detailed ? BADGE[mood] : undefined;
  const look = { x: Math.max(-1, Math.min(1, gaze?.x ?? 0)) * 34, y: Math.max(-1, Math.min(1, gaze?.y ?? 0)) * 26 };

  return (
    <span
      className="buddy"
      data-mood={mood}
      data-still={animated ? undefined : ""}
      data-compact={detailed ? undefined : ""}
      data-beat={activeBeat ?? undefined}
      role={label ? "img" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, ["--buddy-eye-scale" as string]: eyeScale ?? 1 }}
    >
      <span className="buddy-float">
        <span className="buddy-shake">
          <span className="buddy-beat" key={activeBeat ? `${activeBeat}-${beatKey}` : "rest"}>
            <svg viewBox="0 0 1024 1024" focusable="false" aria-hidden="true" style={{ color }}>
              <defs>
                <radialGradient id={shadeId} cx="0.36" cy="0.3" r="0.78">
                  <stop offset="0" stopColor="#fff" stopOpacity="0.24" />
                  <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
              </defs>
              {detailed && <ellipse className="buddy-halo" cx="512" cy="512" rx="540" ry="530" />}
              <g className="buddy-spin" key={spin ? `spin-${spin.key}` : "spin"}>
                <g
                  className="buddy-extra-spin"
                  style={spin ? { animationDuration: `${spin.ms}ms` } : undefined}
                  data-on={spin ? "" : undefined}
                >
                  <path transform={BUDDY_BODY_TRANSFORM} d={BUDDY_BODY_PATH} fill="currentColor" />
                </g>
              </g>
              {/* Light that stays put while the body turns: a disc inside the scallops' inner radius (459). */}
              <circle cx="512" cy="512" r="456" fill={`url(#${shadeId})`} />
              <g className="buddy-look" style={{ transform: `translate(${look.x}px, ${look.y}px)` }}>
                <g className="buddy-face">
                  {BUDDY_EYES.map((eye, index) => (
                    <g key={index} className={`buddy-eye buddy-eye-${index ? "b" : "a"}`}>
                      <g className="buddy-lid" key={blinkKey} data-blink={blinkKey ? "" : undefined}>
                        <path transform={eye.transform} d={BUDDY_EYE_PATH} fill={BUDDY_EYE_FILL} />
                      </g>
                    </g>
                  ))}
                </g>
              </g>
              {detailed && mood === "preview" && (
                <path className="buddy-brackets" d="M120 250v-90h90m604 0h90v90M120 774v90h90m604 0h90v-90" />
              )}
              {detailed && mood === "testing" && (
                <g className="buddy-testdots">
                  <circle cx="400" cy="720" r="26" />
                  <circle cx="480" cy="720" r="26" />
                  <circle cx="560" cy="720" r="26" />
                </g>
              )}
              {detailed && mood === "writing" && (
                <path className="buddy-caret" d="M330 720h300" />
              )}
              {detailed && mood === "thinking" && (
                <g className="buddy-thought">
                  <circle cx="800" cy="230" r="34" />
                  <circle cx="880" cy="140" r="48" />
                </g>
              )}
              {detailed && mood === "sleeping" && (
                <text className="buddy-zzz" x="820" y="240">z</text>
              )}
              {badge && (
                <g className="buddy-badge">
                  <circle cx="872" cy="848" r="112" />
                  <text x="872" y="896">{badge}</text>
                </g>
              )}
              {detailed && (mood === "success" || mood === "celebrate") && (
                <path
                  className="buddy-sparkles"
                  d="M90 65l12 37 37 12-37 12-12 37-12-37-37-12 37-12zM930 70l12 37 37 12-37 12-12 37-12-37-37-12 37-12zM985 600l12 37 37 12-37 12-12 37-12-37-37-12 37-12zM40 640l9 27 27 9-27 9-9 27-9-27-27-9 27-9z"
                />
              )}
            </svg>
          </span>
        </span>
      </span>
    </span>
  );
}

export const BuddyAvatar = memo(forwardRef(BuddyAvatarComponent));
