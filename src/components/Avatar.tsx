// Bot avatar — the Blob Studio "Cursor" mascot (CursorAvatar.tsx), wrapped
// in the app's historical MausAvatar API so no call site changes: per-bot
// color becomes a solid body, the app's one-shot motion beats borrow the
// face/state for a moment, and the eyes follow the pointer. The previous
// hand-built Maus body + face engine (maus-engine/face/driver) is gone;
// CursorAvatar owns morphing, blinking, drift, body motion and effects.
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAUS_COLORS, MAUS_MOTION_DURATION_MS, type MascotBotProfile, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { CursorAvatar, type CursorAvatarHandle } from "./CursorAvatar";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";
import { MASCOT_BODIES, botMascotBody, type MascotBodyId } from "../../shared/mascot-bodies";

export const EYE_SCALE = 0.72;
export const MOUTH_WEIGHT = 11;

/**
 * How far the pointer may pull the eyes. Facing forward the full range is
 * safe; with the expressions' authored gaze they already start off-centre.
 */
const POINTER_GAZE = { forward: 1, authored: 0.25 };

/**
 * What a one-shot motion does while it plays: CursorAvatar animates the body
 * per state, so borrowing the state for a beat moves body and face together.
 */
interface MotionFaces
  extends Partial<
    Record<Exclude<MausMotion, "none">, { state?: MausState; blink?: boolean; spin?: number }>
  > {}

const MOTION_FACE: MotionFaces = {
  arrive: { state: "spawning", spin: 900 },
  switch: { state: "waking", spin: 620 },
  customize: { state: "humming", spin: 900, blink: true },
  alert: { state: "alerting" },
  thinking: { state: "thinking" },
  working: { state: "working" },
  launch: { state: "loading" },
  success: { state: "happy", blink: true },
  celebrate: { state: "celebrate", spin: 700 },
  blink: { blink: true },
  surprise: { state: "surprised", blink: true },
  failure: { state: "sad" },
};

/** A solid body keeps the small, dark eyes readable at sidebar sizes. */
const gradientFor = (color: MausColor): [string, string, string] => {
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green;
  return [fill, fill, fill];
};

export type MausAvatarHandle = CursorAvatarHandle;

export type MausAvatarProps = {
  color: MausColor;
  /** Named behaviour — drives the expression pool, its cadence and blinking. */
  state?: MausState;
  /** Runtime activity, separate from a face that may also be a resting choice. */
  busy?: boolean;
  activity?: MascotBotProfile["activity"];
  /** Pin one of the 25 faces and stop the state's own drift. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  /** Head turn in degrees. */
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  /**
   * Face the viewer at turn 0, cancelling each expression's authored gaze
   * direction. Off restores the engine's own drawn-in directions.
   */
  forward?: boolean;
  /** How much each expression glances around. Overrides `forward`'s 0-or-1. */
  lookAround?: number;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the state's resting face. */
  animated?: boolean;
  /** Which body the bot wears. Unknown values fall back to the cursor. */
  bodyId?: MascotBodyId;
};

function MausAvatarComponent(
  {
    color,
    state = "idle",
    busy,
    activity,
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn,
    gaze,
    spring,
    eyeScale = EYE_SCALE,
    showMouth = false,
    mouthStroke,
    forward = true,
    lookAround,
    trackPointer = true,
    animated = true,
    bodyId,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const silhouette = MASCOT_BODIES[botMascotBody(bodyId)];
  const inner = useRef<CursorAvatarHandle>(null);
  useImperativeHandle(ref, () => ({
    blink: () => inner.current?.blink(),
    spin: (durationMs?: number) => inner.current?.spin(durationMs),
    cancelMotion: () => inner.current?.cancelMotion(),
    setExpression: (index: number) => inner.current?.setExpression(index),
  }));

  // A one-shot motion borrows the state for a moment, then hands it back.
  const [motionState, setMotionState] = useState<MausState | null>(null);
  // Selecting or customizing a bot must not cover attention with a new beat.
  const needsAttention = activity === "waiting-on-you" || activity === "no-signal" || activity === "dead";
  const lastMotion = useRef<{
    motion: MausMotion; key: number; state: MausState; busy?: boolean;
    expiresAt: number; canceled: boolean;
  } | null>(null);
  useEffect(() => {
    setMotionState(null);
    const previous = lastMotion.current;
    const sameEvent = previous?.motion === motion && previous.key === motionKey;
    const phaseChanged = sameEvent && (previous.state !== state || previous.busy !== busy);
    // Completion can arrive just before the final idle snapshot. Keep that
    // confirmed result for its remaining lifetime, but let new work take over.
    const finishing = phaseChanged && previous.busy === true && busy === false &&
      ["success", "celebrate", "failure"].includes(motion);
    const event = {
      motion, key: motionKey, state, busy,
      expiresAt: sameEvent ? previous.expiresAt : Date.now() + MAUS_MOTION_DURATION_MS,
      canceled: !animated || needsAttention || (sameEvent && (previous.canceled || (phaseChanged && !finishing))),
    };
    lastMotion.current = event;
    if (!sameEvent || event.canceled || motion === "none") inner.current?.cancelMotion();
    const remaining = event.expiresAt - Date.now();
    if (motion === "none" || event.canceled || remaining <= 0) return;
    const beat = MOTION_FACE[motion];
    if (!beat) return;
    if (!finishing) {
      if (beat.blink) inner.current?.blink();
      if (beat.spin) inner.current?.spin(beat.spin);
    }
    if (beat.state) setMotionState(beat.state);
    const timer = setTimeout(() => setMotionState(null), remaining);
    return () => clearTimeout(timer);
  }, [motion, motionKey, animated, state, busy, needsAttention]);

  // Pointer-follow gaze, composed with any gaze the caller pins.
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const range = forward ? POINTER_GAZE.forward : POINTER_GAZE.authored;
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!trackPointer || !animated) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)) * range,
      y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)) * range,
    });
  };
  const onPointerLeave = () => setPointer({ x: 0, y: 0 });

  return (
    <span
      className="inline-flex shrink-0"
      onPointerMove={trackPointer && animated ? onPointerMove : undefined}
      onPointerLeave={trackPointer && animated ? onPointerLeave : undefined}
    >
      <CursorAvatar
        ref={inner}
        state={needsAttention ? state : motionState ?? state}
        expression={expression}
        size={size}
        silhouette={silhouette}
        gradient={gradientFor(color)}
        eyeColor="#17211d"
        title={label ?? null}
        lookAround={lookAround ?? (forward ? 0 : 1)}
        gaze={{ x: (gaze?.x ?? 0) + pointer.x, y: (gaze?.y ?? 0) + pointer.y }}
        turn={turn}
        spring={spring}
        eyeScale={eyeScale}
        showMouth={showMouth}
        mouthStroke={mouthStroke}
        paused={!animated}
      />
    </span>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color"> & {
  bot: {
    name?: string;
    busy?: boolean;
    activity?: MascotBotProfile["activity"];
    color: MausColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
    mascotBody?: MascotBodyId | null;
  };
};

export type BotAvatarOutcome = "flatImage" | "gradientMascot";

/**
 * Pick which of the two ways to render a bot's avatar, given the parsed
 * profile plus whether the image has already failed to load. Kept as a pure
 * function — independent of React state and effects — so both arms can be
 * unit-tested directly: `imageFailed` is set by the `<img>`'s own `onError`,
 * which `renderToStaticMarkup` never fires, so the failure fallback is
 * unreachable from a synchronous render test.
 *
 * The iOS half of this decision is `resolveBotAvatarOutcome` in
 * `ios/Sources/CompanionCore/BotAvatarRendering.swift`, which mirrors this
 * union name for name so the two renderers can be read side by side.
 */
export function resolveBotAvatarOutcome(params: {
  avatarCrop: BotAvatarCrop;
  hasUrl: boolean;
  imageFailed: boolean;
}): BotAvatarOutcome {
  const { avatarCrop, hasUrl, imageFailed } = params;
  if (!hasUrl) return "gradientMascot";
  if (avatarCrop === "mascot") return "gradientMascot";
  if (imageFailed) return "gradientMascot";
  return "flatImage";
}

/**
 * The one renderer for a bot's chosen profile image. Malformed persisted
 * values and images that fail to load both fall back to the animated mascot,
 * so an old/corrupt profile can never leave a broken-image icon in the app.
 */
export function BotAvatar({ bot, size = 44, label, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  const outcome = resolveBotAvatarOutcome({
    avatarCrop: profile.avatarCrop,
    hasUrl: Boolean(profile.avatarUrl),
    imageFailed,
  });

  if (outcome !== "flatImage") {
    return (
      <MausAvatar
        bodyId={bot.mascotBody ?? undefined}
        busy={bot.busy}
        activity={bot.activity}
        {...mascotProps}
        color={bot.color}
        size={size}
        label={label ?? bot.name}
      />
    );
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  return (
    <img
      src={profile.avatarUrl}
      alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
      width={size}
      height={size}
      draggable={false}
      onError={() => setImageFailed(true)}
      className="block shrink-0 bg-raised object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

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
