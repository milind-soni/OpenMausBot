import { memo, useEffect, useRef, useState } from "react";
import type { MausState } from "@/lib/mascot";
import { avatarMarks, type AvatarKind } from "@/lib/avatar-marks";
import { mascotFaceInk, type MascotFaceColor, type MascotMaterial } from "../../shared/bot-avatar";
import { mountAvatar, type AvatarOptions, type MountedAvatar } from "../../packages/phone-protocol/src/open-bot-avatar/dom/index.ts";
import type { AvatarDefinition, AvatarMood, AvatarState } from "../../packages/phone-protocol/src/open-bot-avatar/types.ts";
import { DONE_TURN_S } from "../../packages/phone-protocol/src/open-bot-avatar/motion.ts";
import { usePrefersReducedMotion } from "./mascot-clock";
import { ACTIVE_STATES } from "./mascot-motion";

export type ObjectLook = { state: AvatarState; mood: AvatarMood };

const look = (state: AvatarState, mood: AvatarMood = "neutral"): ObjectLook => ({ state, mood });
const IDLE = look("idle");
const WORKING = look("working");
const WAITING = look("waiting");
const HAPPY = look("idle", "happy");
const DONE = look("done");

const LOOKS: Partial<Record<MausState, ObjectLook>> = {
  thinking: look("thinking"),
  working: WORKING, writing: WORKING, loading: WORKING, searching: WORKING, radar: WORKING, orbit: WORKING,
  progress: WORKING, uploading: WORKING, sending: WORKING, receiving: WORKING,
  alerting: WAITING, notifying: WAITING,
  sad: look("blocked"),
  celebrate: DONE,
  happy: HAPPY, laughing: HAPPY, proud: HAPPY, playful: HAPPY,
};

export const objectLook = (state: MausState): ObjectLook => LOOKS[state] ?? IDLE;

/** How long a bot celebrates after it finishes: one Done turn of the ribbon cage, and its settle. */
const CHEER_MS = DONE_TURN_S * 1000 + 300;

/** True for one celebration after the bot goes from thinking or working back to idle. */
function useFinishCheer(state: MausState): boolean {
  const [cheering, setCheering] = useState(false);
  const was = useRef(state);
  useEffect(() => {
    const before = objectLook(was.current).state;
    was.current = state;
    if (objectLook(state).state !== "idle" || (before !== "working" && before !== "thinking")) return;
    setCheering(true);
    const timer = setTimeout(() => setCheering(false), CHEER_MS);
    return () => {
      clearTimeout(timer);
      setCheering(false);
    };
  }, [state]);
  return cheering;
}

export type ObjectAvatarProps = {
  /** Engine definition: an Open Bot Avatar object or one of our shapes. */
  definition: AvatarDefinition;
  /** Body colour as a hex. */
  fill: string;
  faceColor?: MascotFaceColor | null;
  material?: MascotMaterial;
  size?: number;
  state?: MausState;
  trackPointer?: boolean;
  animated?: boolean;
  label?: string;
  kind?: AvatarKind;
};

function ObjectAvatarComponent({ definition, fill, faceColor, material, size = 44, state = "idle", trackPointer = true, animated, label, kind }: ObjectAvatarProps) {
  const reduced = usePrefersReducedMotion();
  const cheering = useFinishCheer(state);
  const live = !reduced && (animated ?? (ACTIVE_STATES.has(state) || cheering));
  const shown = cheering && live ? DONE : objectLook(state);
  const options: AvatarOptions = {
    definition,
    color: fill,
    eyeColor: mascotFaceInk(faceColor),
    material,
    followPointer: trackPointer,
    still: !live,
    label: label ?? "",
    ...shown,
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
      data-object-state={shown.state}
    />
  );
}

export const ObjectAvatar = memo(ObjectAvatarComponent);
