// NATION soft-tower faces are used on every avatar surface, including pickers.
import { forwardRef, memo, useEffect, useImperativeHandle, useState } from "react";
import { NATION_COLOR_NAMES, type NationColor, type NationMotion, type NationState } from "@/lib/mascot";
import { apiUrl } from "@/lib/api-client";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";
import type { MascotBodyId } from "../../shared/mascot-bodies";

export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;
export type NationAvatarHandle = { blink: () => void; spin: (durationMs?: number) => void; setExpression: (index: number) => void };
export type NationAvatarProps = {
  color: NationColor;
  /** Named behaviour — drives the expression pool, its cadence and blinking. */
  state?: NationState;
  /** Pin one of the 25 faces and stop the state's own drift. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: NationMotion;
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

function NationAvatarComponent({ color, size = 44, label }: NationAvatarProps, ref: React.Ref<NationAvatarHandle>) {
  useImperativeHandle(ref, () => ({ blink() {}, spin() {}, setExpression() {} }));
  return <img src={softTowerUrl(color)} alt={label ?? "NATION teammate"} width={size} height={size}
    className="block shrink-0 object-contain" style={{ width: size, height: size }} draggable={false} />;
}
export const NationAvatar = memo(forwardRef(NationAvatarComponent));

export type BotAvatarProps = Omit<NationAvatarProps, "color"> & {
  bot: {
    name?: string;
    color: NationColor;
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

/** Six soft-tower faces used as the default NATION avatar set, in order. */
const SOFT_TOWER_FACES = [
  "coordinator",
  "researcher",
  "builder",
  "analyst",
  "creator",
  "operator",
] as const;

/** Map a bot's stored colour to one of the six soft-tower face names,
 * deterministically and without gaps (modulo on the colour index). */
function softTowerFace(color: NationColor): (typeof SOFT_TOWER_FACES)[number] {
  const idx = NATION_COLOR_NAMES.indexOf(color);
  return SOFT_TOWER_FACES[(idx < 0 ? 0 : idx) % SOFT_TOWER_FACES.length]!;
}

/** URL for a bot's default avatar. Respects the Vite base path so the image
 * resolves correctly whether the app runs at / or /swarm/. */
function softTowerUrl(color: NationColor): string {
  return `${import.meta.env.BASE_URL}bot-faces/${softTowerFace(color)}.png`;
}

/**
 * The one renderer for a bot's chosen profile image. When no custom image is
 * set (or the crop is "mascot"), a soft-tower face from public/bot-faces/ is
 * shown, chosen deterministically from the bot's colour. Custom uploaded
 * images continue to work unchanged.
 */
export function BotAvatar({ bot, size = 44, label }: BotAvatarProps) {
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
      <img
        src={softTowerUrl(bot.color)}
        alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
        width={size}
        height={size}
        draggable={false}
        className="block shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    );
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  // Stored as server paths (/api/attachments/…, /bot-faces/…); the app may be
  // served under a base such as /swarm/, and only that prefix reaches it.
  return (
    <img
      src={profile.avatarUrl && apiUrl(profile.avatarUrl)}
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
