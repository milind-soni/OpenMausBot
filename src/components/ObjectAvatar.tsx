import { memo, useEffect, useRef } from "react";
import type { MausState } from "@/lib/mascot";
import { avatarMarks, type AvatarKind } from "@/lib/avatar-marks";
import { mascotFaceInk, type MascotFaceColor } from "../../shared/bot-avatar";
import { mountAvatar, type AvatarOptions, type MountedAvatar } from "../../packages/phone-protocol/src/open-bot-avatar/dom/index.ts";
import type { AvatarDefinition, AvatarMood, AvatarState } from "../../packages/phone-protocol/src/open-bot-avatar/types.ts";
import { usePrefersReducedMotion } from "./mascot-clock";
import { ACTIVE_STATES } from "./mascot-motion";

export type ObjectLook = { state: AvatarState; mood: AvatarMood };

const look = (state: AvatarState, mood: AvatarMood = "neutral"): ObjectLook => ({ state, mood });
const IDLE = look("idle");
const WORKING = look("working");
const WAITING = look("waiting");
const HAPPY = look("idle", "happy");

const LOOKS: Partial<Record<MausState, ObjectLook>> = {
  thinking: look("thinking"),
  working: WORKING, writing: WORKING, loading: WORKING, searching: WORKING, radar: WORKING, orbit: WORKING,
  progress: WORKING, uploading: WORKING, sending: WORKING, receiving: WORKING,
  alerting: WAITING, notifying: WAITING,
  sad: look("blocked"),
  celebrate: look("done"),
  happy: HAPPY, laughing: HAPPY, proud: HAPPY, playful: HAPPY,
};

export const objectLook = (state: MausState): ObjectLook => LOOKS[state] ?? IDLE;

export type ObjectAvatarProps = {
  /** Engine definition: an Open Bot Avatar object or one of our shapes. */
  definition: AvatarDefinition;
  /** Body colour as a hex. */
  fill: string;
  faceColor?: MascotFaceColor | null;
  size?: number;
  state?: MausState;
  trackPointer?: boolean;
  animated?: boolean;
  label?: string;
  kind?: AvatarKind;
};

function ObjectAvatarComponent({ definition, fill, faceColor, size = 44, state = "idle", trackPointer = true, animated, label, kind }: ObjectAvatarProps) {
  const reduced = usePrefersReducedMotion();
  const live = !reduced && (animated ?? ACTIVE_STATES.has(state));
  const options: AvatarOptions = {
    definition,
    color: fill,
    eyeColor: mascotFaceInk(faceColor),
    followPointer: trackPointer,
    still: !live,
    label: label ?? "",
    ...objectLook(state),
  };
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  useEffect(() => {
    const mounted = mountAvatar(host.current!, options);
    avatar.current = mounted;
    return () => {
      mounted.destroy();
      avatar.current = null;
    };
  }, []);
  useEffect(() => avatar.current?.update(options));
  return (
    <span
      {...avatarMarks(kind, "mascot")}
      ref={host}
      className="inline-block shrink-0"
      style={{ width: size, height: size }}
      data-object-body={definition.id}
    />
  );
}

export const ObjectAvatar = memo(ObjectAvatarComponent);
