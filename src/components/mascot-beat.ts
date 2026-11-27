import { useEffect, useState } from "react";
import type { MausMotion, MausState } from "@/lib/mascot";

/** How long a motion beat (a blink, a spin, a face for a moment) plays; the longest beat fits inside it. */
export const MOTION_BEAT_MS = 1400;

interface MotionFaces
  extends Partial<
    Record<Exclude<MausMotion, "none">, { state?: MausState; blink?: boolean; spin?: number }>
  > {}

export const MOTION_FACE: MotionFaces = {
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

/** The state a beat puts on the face while it plays. A beat's face ends with it: a caller that stops animating mid-beat
 * leaves the bot's own state, not the beat's, and a beat with no face of its own (a blink) that cuts a face beat short
 * ends that face too, so the bot never keeps it. */
export function useBeatState(motion: MausMotion | undefined, motionKey: number | undefined, animated: boolean | undefined): MausState | null {
  const [face, setFace] = useState<MausState | null>(null);
  useEffect(() => {
    if (motion === undefined || motion === "none" || animated === false) return setFace(null);
    const state = MOTION_FACE[motion]?.state;
    if (!state) return setFace(null);
    setFace(state);
    const timer = setTimeout(() => setFace(null), MOTION_BEAT_MS);
    return () => clearTimeout(timer);
  }, [motion, motionKey, animated]);
  return face;
}

/** The store keeps the last beat it played for a bot, so a beat counts as playing only from the render that brings its
 * key until MOTION_BEAT_MS later. A face that animates "while a beat plays" then rests again once it ends, instead of
 * moving at the frame rate for as long as the chat stays open. */
export function useMotionBeat(motion: MausMotion | undefined, motionKey: number): boolean {
  const [ended, setEnded] = useState<{ motion: MausMotion; key: number } | null>(null);
  const beat = motion !== undefined && motion !== "none";
  useEffect(() => {
    if (!beat) return;
    const timer = setTimeout(() => setEnded({ motion, key: motionKey }), MOTION_BEAT_MS);
    return () => clearTimeout(timer);
  }, [beat, motion, motionKey]);
  return beat && (ended?.motion !== motion || ended.key !== motionKey);
}
