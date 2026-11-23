/**
 * A live avatar in any DOM element, without a framework.
 *
 *   const avatar = mountAvatar(el, { definition, color: '#1f7cf2', followPointer: true });
 *   avatar.update({ state: 'working', mood: 'happy' });
 *   avatar.destroy();
 *
 * Live avatars paint each frame to one canvas (see paint.ts): one compositor
 * layer and a small bitmap per avatar. `renderer: 'scene'` mounts a CSS 3D scene
 * instead, where every cross-section is its own small SVG and each frame only
 * writes a few CSS transforms; it costs a compositor layer per visible slice,
 * and is also the fallback where canvas is unavailable. `still` avatars are a
 * single static SVG and never animate. Every avatar on the page shares one
 * animation loop.
 */
import { createAnimator } from '../animator.ts';
import { pointerGaze } from '../follow.ts';
import { resolveLook } from '../motion.ts';
import { DEFAULT_COLOR, DEFAULT_EYE_COLOR, liveFrame, renderAvatarScene, renderAvatarSvg, sceneFrame, type SceneFrame } from '../render.ts';
import type { AvatarDefinition, AvatarMood, AvatarState, RenderOptions } from '../types.ts';
import { requestFrame, subscribeFrames } from './clock.ts';
import { canvasSupported, mountCanvas, paintCanvas, type CanvasSurface } from './paint.ts';
import { trackPointer } from './pointer.ts';
import { prefersReducedMotion } from './reduced.ts';

export interface AvatarOptions {
  definition: AvatarDefinition;
  /** Body color: #rgb or #rrggbb, or any CSS color (e.g. var(--brand)). */
  color?: string;
  /** Eye color: #rgb or #rrggbb, or any CSS color. Defaults to a near-black ink. */
  eyeColor?: string;
  /** Volume amount 0..14 (6 = natural depth, 0 = flat). */
  depth?: number;
  /** What the bot is doing (default `idle`). Changes ease from what is on screen. */
  state?: AvatarState;
  /**
   * How the bot feels (default `neutral`): it shapes the eyes on top of any state. `idle` and
   * `thinking` are still accepted here from before `state` existed and mean those states.
   */
  mood?: AvatarMood | 'idle' | 'thinking';
  /** Eyes look and the body turns toward the mouse, pen or finger anywhere on the page. */
  followPointer?: boolean;
  /** Fixed look direction (-1..1 per axis, x right, y down). Wins over the pointer. */
  lookAt?: { x: number; y: number } | null;
  /** Keep the current look as it is (e.g. while the user drags the view). */
  holdGaze?: boolean;
  /** Extra view rotation in radians on top of the resting view (e.g. drag-to-turn). */
  view?: { yaw: number; pitch: number };
  /** true or false to force; 'system' (default) follows prefers-reduced-motion. */
  reducedMotion?: boolean | 'system';
  /** Render one static SVG and never animate (thumbnails, lists). */
  still?: boolean;
  /**
   * How a live avatar draws. 'canvas' (default) paints each frame to one canvas: one compositor layer
   * per avatar. 'scene' is a CSS 3D scene with a compositor layer per visible slice: more CPU and
   * layers, but less video memory for a single avatar several hundred pixels wide.
   */
  renderer?: 'canvas' | 'scene';
  /** Accessible name; defaults to the definition's name. "" marks the avatar decorative. */
  label?: string;
}

export interface MountedAvatar {
  /** Change any options; only what changed is redrawn. */
  update(options: Partial<AvatarOptions>): void;
  destroy(): void;
}

/** Handles into a mounted scene, and the last values written, so frames only touch what changed. */
interface Scene {
  key: string;
  geometry: string;
  motion: HTMLElement;
  view: HTMLElement;
  stacks: Record<'z' | 'x', HTMLElement>;
  slices: Record<'z' | 'x', HTMLElement[]>;
  eyes: { root: HTMLElement; pill: HTMLElement; arc: HTMLElement; morph: HTMLElement; path: SVGPathElement }[];
  fx: Record<'back' | 'front', HTMLElement>;
  last: Record<string, string>;
}

function mountScene(el: HTMLElement, definition: AvatarDefinition, depth: number | undefined): Scene {
  el.innerHTML = renderAvatarScene(definition, { depth });
  const q = (s: string) => el.querySelector(s) as HTMLElement;
  const stacks = { z: q('[data-stack="z"]'), x: q('[data-stack="x"]') };
  return {
    key: q('[data-avatar-scene]').dataset.avatarScene ?? '',
    geometry: geometryKey(definition),
    motion: q('[data-motion]'),
    view: q('[data-view]'),
    stacks,
    slices: { z: [...stacks.z.children] as HTMLElement[], x: [...stacks.x.children] as HTMLElement[] },
    eyes: [0, 1].map((i) => {
      const root = q(`[data-eye="${i}"]`);
      const morph = root.querySelector('[data-morph]') as HTMLElement;
      return { root, pill: root.querySelector('i') as HTMLElement, arc: root.querySelector('svg') as unknown as HTMLElement, morph, path: morph.querySelector('path') as SVGPathElement };
    }),
    fx: { back: q('[data-fx="back"]'), front: q('[data-fx="front"]') },
    last: {},
  };
}

/** Write a style property only when its value changed since the last frame. */
function put(m: Scene, key: string, el: HTMLElement, prop: 'transform' | 'visibility' | 'display', value: string) {
  if (m.last[key] === value) return;
  m.last[key] = value;
  el.style[prop] = value;
}

function apply(m: Scene, frame: SceneFrame) {
  put(m, 'motion', m.motion, 'transform', frame.motion);
  put(m, 'view', m.view, 'transform', frame.view);
  // A body that has given way to a mark holds no layers.
  put(m, 'body', m.view, 'display', frame.body > 0 ? 'block' : 'none');
  for (const side of ['back', 'front'] as const) {
    if (m.last[side] === frame[side]) continue;
    m.last[side] = frame[side];
    m.fx[side].innerHTML = frame[side];
  }
  // display:none, not visibility: hidden slices would still each hold a 3D layer.
  put(m, 'z', m.stacks.z, 'display', frame.stack === 'z' ? 'block' : 'none');
  put(m, 'x', m.stacks.x, 'display', frame.stack === 'x' ? 'block' : 'none');
  const slices = m.slices[frame.stack];
  frame.slices.forEach((shown, i) => slices[i] && put(m, `${frame.stack}${i}`, slices[i], 'display', shown ? 'block' : 'none'));
  frame.eyes.forEach((eye, i) => {
    const e = m.eyes[i];
    put(m, `e${i}`, e.root, 'transform', eye.transform);
    put(m, `v${i}`, e.root, 'visibility', eye.visible ? 'visible' : 'hidden');
    put(m, `p${i}`, e.pill, 'transform', eye.pill);
    put(m, `ph${i}`, e.pill, 'display', eye.happy || eye.d ? 'none' : 'block');
    put(m, `a${i}`, e.arc, 'display', eye.happy && !eye.d ? 'block' : 'none');
    put(m, `m${i}`, e.morph, 'display', eye.d ? 'block' : 'none');
    if (eye.d && m.last[`d${i}`] !== eye.d) {
      m.last[`d${i}`] = eye.d;
      e.path.setAttribute('d', eye.d);
    }
  });
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const isHex = (c: string | undefined) => c === undefined || HEX.test(c);

const keys = new WeakMap<object, string>();
/** Everything in a definition the static scene markup depends on. */
function geometryKey(definition: AvatarDefinition): string {
  let key = keys.get(definition);
  if (key === undefined) {
    key = JSON.stringify([definition?.id, definition?.name, definition?.body?.path, definition?.eyes]);
    keys.set(definition, key);
  }
  return key;
}

/** Midpoint between the eyes as a fraction of the (square, 100-unit) box: the look starts there. */
function eyesOrigin(definition: AvatarDefinition): { x: number; y: number } {
  const { x, y } = definition.eyes ?? {};
  const at = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5);
  return { x: at(x), y: at(y) };
}

/** Avatars smaller than this (CSS px) redraw at SMALL_FPS: the difference doesn't show, and pages often hold many. */
const SMALL_SIZE = 128;
const SMALL_FPS = 30;
/** How far outside the viewport (CSS px) avatars keep animating, so they are already moving as they scroll in. */
const VIEW_MARGIN = 100;
/** Slack so a 60 Hz display reliably draws every other frame rather than drifting between 1 and 3. */
const FRAME_SLACK = 0.004;

export function mountAvatar(host: HTMLElement, initial: AvatarOptions): MountedAvatar {
  let opts: AvatarOptions = { ...initial };
  const animator = createAnimator();
  let rect: DOMRect | null = null;
  let scene: Scene | null = null;
  let surface: CanvasSurface | null = null;
  let lastStill = '';
  let failed = false;
  let dirty = true;
  let releasePointer: (() => void) | null = null;
  let size = host.clientWidth;
  const resize = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(([entry]) => {
        const next = entry.contentRect.width;
        if (next === size) return;
        size = next;
        requestFrame();
      });
  resize?.observe(host);

  /** Whether the host is in or near the viewport. Offscreen, a live avatar only redraws after a change. */
  let visible = true;
  const intersect = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          const next = entries[entries.length - 1].isIntersecting;
          if (next === visible) return;
          visible = next;
          if (visible) requestFrame();
        },
        { rootMargin: `${VIEW_MARGIN}px` },
      );
  intersect?.observe(host);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const syncHost = () => {
    host.style.color = opts.color ?? DEFAULT_COLOR;
    host.style.setProperty('--avatar-ink', opts.eyeColor ?? DEFAULT_EYE_COLOR);
    const decorative = opts.label === '';
    if (decorative) {
      host.removeAttribute('role');
      host.removeAttribute('aria-label');
      host.setAttribute('aria-hidden', 'true');
    } else {
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', opts.label ?? opts.definition?.name ?? 'Avatar');
      host.removeAttribute('aria-hidden');
    }
    const wantsPointer = !!opts.followPointer && !opts.still;
    if (wantsPointer && !releasePointer) releasePointer = trackPointer();
    else if (!wantsPointer && releasePointer) {
      releasePointer();
      releasePointer = null;
    }
  };

  const clear = () => {
    host.textContent = '';
    scene = null;
    surface = null;
    lastStill = '';
  };

  const draw = (time: number, pointer: { x: number; y: number } | null): boolean => {
    const p = opts;
    const reducedMotion = p.reducedMotion === 'system' || p.reducedMotion === undefined ? prefersReducedMotion() : p.reducedMotion;
    const now = performance.now();
    // `mood: 'idle' | 'thinking'` are the states they were before `state` existed.
    const look = resolveLook({ state: p.state, mood: p.mood, motion: p.mood });
    try {
      if (p.still) {
        if (scene || surface) clear();
        const svg = renderAvatarSvg(p.definition, {
          color: p.color,
          eyeColor: p.eyeColor,
          depth: p.depth,
          state: look.state,
          mood: look.mood,
          view: p.view,
          gaze: p.lookAt ?? undefined,
          reducedMotion: true,
        });
        // The engine derives SVG ids from geometry, so repeated avatars can share them safely.
        if (svg !== lastStill) {
          host.innerHTML = svg;
          lastStill = svg;
        }
        failed = false;
        return false;
      }
      if (lastStill) clear();

      const target = p.lookAt
        ? p.lookAt
        : p.followPointer && pointer && rect && rect.width > 0
          ? pointerGaze(pointer, rect, eyesOrigin(p.definition))
          : null;
      const step = animator.step({ now, state: look.state, mood: look.mood, target, hold: p.holdGaze, reducedMotion });
      const options: RenderOptions = {
        depth: p.depth,
        state: look.state,
        mood: look.mood,
        stateAge: step.stateAge,
        motionBlend: step.motionBlend,
        size: size || undefined,
        time,
        gaze: step.gaze,
        view: p.view,
        reducedMotion,
      };
      if (p.renderer !== 'scene' && canvasSupported()) {
        if (scene) clear();
        const flat = liveFrame(p.definition, { ...options, color: p.color, eyeColor: p.eyeColor });
        const key = `${geometryKey(p.definition)}|${p.depth}`;
        if (!surface || surface.key !== key || !host.contains(surface.canvas)) surface = mountCanvas(host, key, p.definition, p.depth);
        // Any CSS color works, as in the scene: one that is not hex is read back every frame from the
        // host's computed `color` and --avatar-ink (which syncHost sets), so themes apply live.
        const css = isHex(p.color) && isHex(p.eyeColor) ? null : getComputedStyle(host);
        const fill = css && !isHex(p.color) ? css.color || flat.color : flat.color;
        const ink = css && !isHex(p.eyeColor) ? css.getPropertyValue('--avatar-ink').trim() || flat.ink : flat.ink;
        paintCanvas(surface, flat, size, fill, ink);
        failed = false;
        return !reducedMotion || step.moving;
      }
      if (surface) clear();
      const frame = sceneFrame(p.definition, { ...options, color: p.color });
      if (!scene || scene.key !== frame.scene || scene.geometry !== geometryKey(p.definition) || !host.contains(scene.view)) {
        scene = mountScene(host, p.definition, p.depth);
      }
      apply(scene, frame);
      failed = false;
      return !reducedMotion || step.moving;
    } catch (error) {
      if (!failed) {
        clear();
        console.error('open-bot-avatar: render failed', error);
        failed = true;
      }
      return false;
    }
  };

  syncHost();
  const unsubscribe = subscribeFrames({
    measure: () => {
      rect = visible && opts.followPointer && !opts.still && !opts.holdGaze && !opts.lookAt ? host.getBoundingClientRect() : null;
    },
    draw: (time, pointer) => {
      // Stills, and live avatars out of view, only redraw after a change; live avatars in view every
      // frame they ask for. A change still draws offscreen, so the content is current when printed.
      if ((opts.still || !visible) && !dirty) return false;
      dirty = false;
      const more = draw(time, pointer);
      if (!visible) return false;
      return more && size > 0 && size < SMALL_SIZE ? 1 / SMALL_FPS - FRAME_SLACK : more;
    },
  });

  return {
    update(next) {
      opts = { ...opts, ...next };
      syncHost();
      dirty = true;
      requestFrame();
    },
    destroy() {
      unsubscribe();
      resize?.disconnect();
      intersect?.disconnect();
      releasePointer?.();
      releasePointer = null;
      clear();
    },
  };
}
