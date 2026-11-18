// Buddy avatar — the Gerer Buddy (BuddyAvatar.tsx), wrapped in the app's
// historical MausAvatar API so call sites stay as they are: the Buddy's
// color fills the body, one-shot motions borrow a state for a moment or play
// a beat, and the eyes follow the pointer.
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAUS_COLORS, PICKABLE_STATES, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { BuddyAvatar, type BuddyAvatarHandle, type BuddyAvatarProps } from "./BuddyAvatar";

/**
 * What a one-shot motion does while it plays: borrow a state for a beat,
 * play a body beat, blink, or add a turn.
 */
const MOTION_FACE: Partial<
  Record<
    Exclude<MausMotion, "none">,
    { state?: MausState; beat?: NonNullable<BuddyAvatarProps["beat"]>; blink?: boolean; spin?: number }
  >
> = {
  arrive: { beat: "pop", spin: 900 },
  switch: { beat: "wiggle" },
  customize: { state: "proud", beat: "hop", blink: true },
  alert: { state: "attention", beat: "nudge" },
  thinking: { state: "thinking" },
  working: { state: "working" },
  launch: { state: "connecting" },
  success: { state: "success" },
  celebrate: { state: "celebrate" },
  blink: { blink: true },
  surprise: { state: "surprised", beat: "hop", blink: true },
  failure: { state: "sad", beat: "nudge" },
};

/** How long a one-shot motion holds its state before the Buddy's own returns. */
const MOTION_FACE_MS = 1600;

export type MausAvatarHandle = BuddyAvatarHandle & {
  /** Show one of the pickable expressions for a moment. */
  setExpression: (index: number) => void;
};

export type MausAvatarProps = {
  color: MausColor;
  /** What the Buddy is doing or how it looks at rest. */
  state?: MausState;
  /** Pin one of the pickable expressions, by index, over the state's look. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  gaze?: { x?: number; y?: number };
  eyeScale?: number;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the state's resting look. */
  animated?: boolean;
};

const pickable = (index: number | undefined): MausState | undefined =>
  index === undefined ? undefined : PICKABLE_STATES[((index % PICKABLE_STATES.length) + PICKABLE_STATES.length) % PICKABLE_STATES.length];

function MausAvatarComponent(
  {
    color,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    gaze,
    eyeScale,
    trackPointer = true,
    animated = true,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const inner = useRef<BuddyAvatarHandle>(null);
  const [heldExpression, setHeldExpression] = useState<MausState | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useImperativeHandle(ref, () => ({
    blink: () => inner.current?.blink(),
    spin: (durationMs?: number) => inner.current?.spin(durationMs),
    setExpression: (index: number) => {
      clearTimeout(holdTimer.current);
      setHeldExpression(pickable(index) ?? null);
      holdTimer.current = setTimeout(() => setHeldExpression(null), MOTION_FACE_MS);
    },
  }));
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  // A one-shot motion borrows the state for a moment, then hands it back.
  const [motionState, setMotionState] = useState<MausState | null>(null);
  const [beatKey, setBeatKey] = useState(0);
  const beat = motion === "none" ? null : (MOTION_FACE[motion]?.beat ?? null);
  useEffect(() => {
    if (motion === "none" || !animated) return;
    const plan = MOTION_FACE[motion];
    if (!plan) return;
    if (plan.blink) inner.current?.blink();
    if (plan.spin) inner.current?.spin(plan.spin);
    if (plan.beat) setBeatKey((k) => k + 1);
    if (!plan.state) return;
    setMotionState(plan.state);
    const timer = setTimeout(() => setMotionState(null), MOTION_FACE_MS);
    return () => clearTimeout(timer);
  }, [motion, motionKey, animated]);

  // Pointer-follow gaze, composed with any gaze the caller pins.
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const following = trackPointer && animated;
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
      y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)),
    });
  };
  const onPointerLeave = () => setPointer({ x: 0, y: 0 });

  return (
    <span
      className="inline-flex shrink-0"
      onPointerMove={following ? onPointerMove : undefined}
      onPointerLeave={following ? onPointerLeave : undefined}
    >
      <BuddyAvatar
        ref={inner}
        color={MAUS_COLORS[color] ?? MAUS_COLORS.green}
        state={motionState ?? heldExpression ?? pickable(expression) ?? state}
        size={size}
        label={label ?? null}
        gaze={{ x: (gaze?.x ?? 0) + pointer.x, y: (gaze?.y ?? 0) + pointer.y }}
        eyeScale={eyeScale}
        beat={beat}
        beatKey={beatKey}
        animated={animated}
      />
    </span>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
