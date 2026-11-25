import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { avatarMarks } from "@/lib/avatar-marks";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { EFFECTS, glyphAmount } from "./CursorAvatar";
import { FACE_BOX } from "./cursor-face-data";
import { useBeatState } from "./mascot-beat";
import { mascotClock, put, usePrefersReducedMotion, type MascotTicket } from "./mascot-clock";
import { ACTIVE_STATES, COMPACT_MASCOT_PX, MOTION, PoseBlend, REST_POSE, VIEW_SPAN, bodyPose, frameFloorMs, loopSeed, nextFrameAt, type BodyMotion, type Pose } from "./mascot-motion";
import { objectLook } from "./ObjectAvatar";

/** The mascot body's pose as a CSS transform for a picture `size` pixels wide. */
export function pictureTransform(pose: Pose, size: number): string {
  const unit = size / VIEW_SPAN;
  const dx = pose.x * unit;
  const dy = pose.y * unit;
  const parts: string[] = [];
  if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) parts.push(`translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`);
  if (Math.abs(pose.rotate) >= 0.005) parts.push(`rotate(${pose.rotate.toFixed(2)}deg)`);
  if (Math.abs(pose.scale - 1) >= 0.00005) parts.push(`scale(${pose.scale.toFixed(4)})`);
  if (Math.abs(pose.sx - 1) >= 0.00005 || Math.abs(pose.sy - 1) >= 0.00005) {
    const ground = (size / 2).toFixed(2);
    parts.push(`translateY(${ground}px) scale(${pose.sx.toFixed(4)}, ${pose.sy.toFixed(4)}) translateY(-${ground}px)`);
  }
  return parts.join(" ");
}

export type BotPictureProps = {
  src?: string;
  alt: string;
  size: number;
  radius: string;
  zoom: number;
  origin: string;
  color: MausColor;
  state?: MausState;
  motion?: MausMotion;
  motionKey?: number;
  animated?: boolean;
  onError: () => void;
};

const CENTRE = FACE_BOX / 2;

/** A bot's own picture. It moves as the mascot's body would in the same state, blending each change in as the mascot's
 * body does, and gives way to the mascot's "!" or "?" glyph on the same beat, under the mascot's rule: only while the
 * state is an activity, unless the caller says otherwise, and never with reduced motion. */
export function BotPicture({ src, alt, size, radius, zoom, origin, color, state: own = "idle", motion, motionKey, animated, onError }: BotPictureProps) {
  const frame = useRef<HTMLSpanElement>(null);
  const photo = useRef<HTMLImageElement>(null);
  const glyphLayer = useRef<SVGGElement>(null);
  const reduced = usePrefersReducedMotion();
  const beat = useBeatState(motion, motionKey, animated);
  const state = beat ?? own;
  const live = !reduced && (animated ?? (ACTIVE_STATES.has(own) || beat !== null));
  const latest = useRef({ state, live, color, reduced });
  const ticket = useRef<MascotTicket | null>(null);
  const uid = useId();
  const [seed] = useState(() => loopSeed(uid));

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let drawn: MausState | null = null;
    let since = 0;
    const blend = new PoseBlend();
    let shownPose: Pose = REST_POSE;
    let poseKey = "";
    const showGlyph = (markup: string | null, amount: number) => {
      const layer = glyphLayer.current;
      if (layer) {
        if ((layer.getAttribute("data-glyph") ?? "") !== (markup ?? "")) {
          put(layer, "data-glyph", markup);
          layer.innerHTML = markup ?? "";
        }
        put(layer, "opacity", String(amount));
        put(layer, "transform", `translate(${CENTRE} ${CENTRE}) scale(${(0.72 + 0.28 * amount).toFixed(3)}) translate(${-CENTRE} ${-CENTRE})`);
      }
      if (photo.current) photo.current.style.opacity = amount > 0 ? String(1 - amount) : "";
    };
    const step = (now: number) => {
      const { state: shown, live: moving, color: paint, reduced: still } = latest.current;
      if (shown !== drawn) {
        drawn = shown;
        since = now;
      }
      const motion: BodyMotion = MOTION[shown];
      const target = moving ? bodyPose(motion, now - since, 1, { seed, compact: size <= COMPACT_MASCOT_PX }) : REST_POSE;
      const key = `${shown}|${moving}`;
      if (key !== poseKey) {
        if (poseKey && !motion.enter && !still) blend.retarget(now, shownPose, target);
        poseKey = key;
      }
      shownPose = still ? target : blend.apply(now, target);
      element.style.transform = pictureTransform(shownPose, size);
      const glyph = moving ? EFFECTS[shown]?.glyph : undefined;
      showGlyph(glyph ? glyph.markup.replace(/\{\{GRADIENT\}\}/g, MAUS_COLORS[paint]) : null, glyph ? glyphAmount(glyph, now - since) : 0);
      return moving || (blend.blending && !still) ? nextFrameAt(now, frameFloorMs(size)) : Infinity;
    };
    const added = mascotClock().add(step, element);
    ticket.current = added;
    return () => {
      added.remove();
      ticket.current = null;
      element.style.transform = "";
      showGlyph(null, 0);
    };
  }, [size, seed]);

  useLayoutEffect(() => {
    latest.current = { state, live, color, reduced };
    ticket.current?.wake();
  }, [state, live, color, reduced]);

  return (
    <span
      ref={frame}
      {...avatarMarks("bot", "picture")}
      data-picture-state={objectLook(state).state}
      className="relative block shrink-0 overflow-hidden bg-raised"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <img
        ref={photo}
        src={src}
        alt={alt}
        width={size}
        height={size}
        draggable={false}
        onError={onError}
        className="block size-full max-w-none object-cover"
        style={{
          width: size,
          height: size,
          objectPosition: origin,
          transform: zoom === 1 ? undefined : `scale(${zoom})`,
          transformOrigin: origin,
        }}
      />
      {live && EFFECTS[state]?.glyph && (
        <svg viewBox={`-15 -15 ${VIEW_SPAN} ${VIEW_SPAN}`} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
          <g ref={glyphLayer} opacity="0" />
        </svg>
      )}
    </span>
  );
}
