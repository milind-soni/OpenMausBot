import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { avatarMarks, type AvatarKind } from "@/lib/avatar-marks";
import { CHROME_EYES, CHROME_GRADIENT, MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { CursorAvatar, type CursorAvatarHandle } from "./CursorAvatar";
import { ACTIVE_STATES } from "./mascot-motion";
import { MOTION_BEAT_MS } from "./mascot-beat";
import { avatarCropRadius, botAvatarProfile, clampAvatarFocus, clampAvatarZoom, mascotBodyColorSchema, mascotFaceInk, mascotMaterialSchema, type BotAvatarCrop, type MascotFaceColor, type MascotMaterial } from "../../shared/bot-avatar";
import { MASCOT_BODIES, botMascotBody } from "../../shared/mascot-bodies";
import { isCarvedBody, type BotBodyId } from "../../shared/bot-body";
import { engineBody } from "../../shared/object-bodies";
import { useFestivalDress, wornBody } from "@/lib/festival-dress";
import { t } from "@/lib/i18n";
import { CarvedAvatar, vivid } from "./CarvedAvatar";
import { ObjectAvatar } from "./ObjectAvatar";
import { steelBodyImage } from "@/lib/steel-body";

export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

const POINTER_GAZE = { forward: 1, authored: 0.25 };

interface MotionFaces
  extends Partial<
    Record<Exclude<MausMotion, "none">, { state?: MausState; blink?: boolean; spin?: number }>
  > {}

const MOTION_FACE: MotionFaces = {
  arrive: { state: "spawning", spin: 900 },
  switch: { state: "waking", spin: 620 },
  customize: { state: "proud", blink: true },
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

function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const va = (a >> shift) & 0xff;
    const vb = (b >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

const gradientFor = (color: MausColor, custom?: string): [string, string, string] => {
  if (!custom && color === "chrome") return CHROME_GRADIENT;
  const fill = custom ?? MAUS_COLORS[color] ?? MAUS_COLORS.green;
  return [mix(fill, "#ffffff", 0.55), fill, mix(fill, "#000000", 0.42)];
};

/** A bot's own body colour when it picked one, else undefined. */
const customFill = (value: unknown): string | undefined => mascotBodyColorSchema.safeParse(value).data;

const roomGradients = new Map<MausColor, [string, string, string]>();

/** One array per colour, so a memoised mascot drawn with it does not draw again. */
export function roomAvatarGradient(color: MausColor): [string, string, string] {
  let gradient = roomGradients.get(color);
  if (!gradient) {
    const fill = `var(--identity-${color})`;
    roomGradients.set(color, (gradient = [`color-mix(in srgb, ${fill} 82%, #ffffff)`, fill, `color-mix(in srgb, ${fill} 82%, #000000)`]));
  }
  return gradient;
}

export type MausAvatarHandle = CursorAvatarHandle;

export type MausAvatarProps = {
  color: MausColor;
  state?: MausState;
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  forward?: boolean;
  lookAround?: number;
  trackPointer?: boolean;
  /** Left out, the mascot moves only while its state is an activity or a beat plays; at rest it holds still until the pointer comes near. */
  animated?: boolean;
  bodyId?: BotBodyId;
  gradient?: [string, string, string];
  faceColor?: MascotFaceColor | null;
  /** A custom `#rrggbb` body colour; it wins over `color` for the body only. */
  bodyColor?: string | null;
  /** The finish (matte, metallic or fluffy fur) of a body the engine draws (the shapes and objects); the cursor and festival bodies stay flat. */
  material?: MascotMaterial | null;
  /** Whose face this is; a decorative mascot has none. */
  kind?: AvatarKind;
};

function MausAvatarComponent(props: MausAvatarProps, ref: React.Ref<MausAvatarHandle>) {
  const { bodyId, color, size, state, motion, motionKey, gaze, trackPointer, animated, label, kind } = props;
  if (isCarvedBody(bodyId)) {
    return (
      <CarvedAvatar
        ref={ref}
        body={bodyId}
        color={color}
        faceColor={props.faceColor}
        size={size}
        state={state}
        motion={motion}
        motionKey={motionKey}
        gaze={gaze}
        trackPointer={trackPointer}
        animated={animated}
        label={label}
        kind={kind}
      />
    );
  }
  const definition = engineBody(bodyId);
  if (definition) {
    return (
      <ObjectAvatar
        definition={definition}
        fill={customFill(props.bodyColor) ?? vivid(MAUS_COLORS[color] ?? MAUS_COLORS.green)}
        material={mascotMaterialSchema.safeParse(props.material).data}
        faceColor={props.faceColor}
        size={size}
        state={state}
        trackPointer={trackPointer}
        animated={animated}
        label={label}
        kind={kind}
      />
    );
  }
  return <GradientAvatar ref={ref} {...props} />;
}

function GradientAvatarComponent(
  {
    color,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn,
    gaze,
    spring,
    eyeScale,
    showMouth,
    mouthStroke,
    forward = true,
    lookAround,
    trackPointer = true,
    animated,
    bodyId,
    gradient,
    faceColor,
    bodyColor,
    kind,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const silhouette = MASCOT_BODIES[botMascotBody(bodyId)];
  const custom = customFill(bodyColor);
  const chrome = color === "chrome" && !custom;
  const paint = custom ? gradientFor(color, custom) : gradient ?? gradientFor(color);
  const faceInk = mascotFaceInk(faceColor);
  const inner = useRef<CursorAvatarHandle>(null);
  useImperativeHandle(ref, () => ({
    blink: () => inner.current?.blink(),
    spin: (durationMs?: number) => inner.current?.spin(durationMs),
    setExpression: (index: number) => inner.current?.setExpression(index),
  }));

  const [motionState, setMotionState] = useState<MausState | null>(null);
  useEffect(() => {
    // A beat's face ends with it: a caller that stops animating mid-beat leaves the bot's own state, not the beat's.
    if (motion === "none" || animated === false) return setMotionState(null);
    const beat = MOTION_FACE[motion];
    if (!beat) return;
    if (beat.blink) inner.current?.blink();
    if (beat.spin) inner.current?.spin(beat.spin);
    if (!beat.state) return;
    setMotionState(beat.state);
    const timer = setTimeout(() => setMotionState(null), MOTION_BEAT_MS);
    return () => clearTimeout(timer);
  }, [motion, motionKey, animated]);

  const live = animated ?? (ACTIVE_STATES.has(state) || motionState !== null);
  return (
    <span
      {...avatarMarks(kind, "mascot")}
      className="inline-flex shrink-0"
    >
      <CursorAvatar
        ref={inner}
        state={motionState ?? state}
        expression={expression}
        size={size}
        silhouette={silhouette}
        gradient={paint}
        picture={chrome && !faceInk ? steelBodyImage(silhouette.id, size, globalThis.devicePixelRatio ?? 1) : null}
        eyeColor={faceInk ?? (chrome ? CHROME_EYES : undefined)}
        title={label ?? null}
        lookAround={lookAround ?? (forward ? 0 : 1)}
        gaze={gaze}
        turn={turn}
        spring={spring}
        eyeScale={eyeScale}
        showMouth={showMouth}
        mouthStroke={mouthStroke}
        resting={!live}
        pointerGaze={trackPointer ? (forward ? POINTER_GAZE.forward : POINTER_GAZE.authored) : 0}
      />
    </span>
  );
}

const GradientAvatar = forwardRef(GradientAvatarComponent);

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color" | "gradient"> & {
  readable?: boolean;
  bot: {
    name?: string;
    color: MausColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
    avatarZoom?: number;
    avatarFocusX?: number;
    avatarFocusY?: number;
    mascotBody?: BotBodyId | null;
    mascotFaceColor?: MascotFaceColor | null;
    mascotBodyColor?: string | null;
    mascotMaterial?: MascotMaterial | null;
  };
};

export type BotAvatarOutcome = "flatImage" | "gradientMascot";

/** Mirrored name for name by resolveBotAvatarOutcome in ios/Sources/CompanionCore/BotAvatarRendering.swift. */
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

export function BotAvatar({ bot, size = 44, label, readable = false, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const festival = useFestivalDress();
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
        bodyId={wornBody(bot.mascotBody, bot.color, festival)}
        {...mascotProps}
        color={bot.color}
        faceColor={bot.mascotFaceColor}
        bodyColor={bot.mascotBodyColor}
        material={bot.mascotMaterial}
        gradient={readable ? roomAvatarGradient(bot.color) : undefined}
        size={size}
        label={label ?? bot.name}
        kind="bot"
      />
    );
  }

  const radius = avatarCropRadius(profile.avatarCrop);
  const zoom = clampAvatarZoom(bot.avatarZoom ?? 1);
  const focusX = clampAvatarFocus(bot.avatarFocusX ?? 0.5);
  const focusY = clampAvatarFocus(bot.avatarFocusY ?? 0.5);
  const origin = `${focusX * 100}% ${focusY * 100}%`;
  return (
    <span
      {...avatarMarks("bot", "picture")}
      className="relative block shrink-0 overflow-hidden bg-raised"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <img
        src={profile.avatarUrl}
        alt={label ?? (bot.name ? t("avatar.alt", { name: bot.name }) : t("avatar.altFallback"))}
        width={size}
        height={size}
        draggable={false}
        onError={() => setImageFailed(true)}
        className="block size-full max-w-none object-cover"
        style={{
          width: size,
          height: size,
          objectPosition: origin,
          transform: zoom === 1 ? undefined : `scale(${zoom})`,
          transformOrigin: origin,
        }}
      />
    </span>
  );
}

export function InitialsAvatar({
  initials,
  avatarUrl,
  size = 32,
  fallback,
  fontSize,
  className,
}: {
  initials: string;
  avatarUrl?: string;
  size?: number;
  className?: string;
  /** drawn instead of the initials, for a person with no name or email to take them from */
  fallback?: ReactNode;
  fontSize?: number;
}) {
  // A picture that is gone (a restored backup carries the address, not the file) falls back to the initials.
  const [failed, setFailed] = useState<string | null>(null);
  if (avatarUrl && failed !== avatarUrl) {
    return <img {...avatarMarks("person", "picture")} src={avatarUrl} alt="" onError={() => setFailed(avatarUrl)} className={cn("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />;
  }
  return (
    <div
      {...avatarMarks("person", "initials")}
      className={cn("flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium", className)}
      style={{ width: size, height: size, fontSize: fontSize ?? size * 0.38 }}
    >
      {fallback ?? initials}
    </div>
  );
}
