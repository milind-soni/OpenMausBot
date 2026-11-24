import { useEffect, useState } from "react";
import type { MausMotion } from "@/lib/mascot";

/** How long a motion beat (a blink, a spin, a face for a moment) plays; the longest beat fits inside it. */
export const MOTION_BEAT_MS = 1400;

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
