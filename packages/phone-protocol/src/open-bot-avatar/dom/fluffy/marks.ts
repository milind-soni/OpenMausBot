/**
 * The marks of `thinking` and `blocked` in fluffy: each dot or bar is a small pompom, rendered
 * once per shape, color and size and kept as a sprite, since the three dots and both parts of
 * the exclamation mark only ever move, squash and fade.
 */
import { viewBasis, type FramePath } from '../../render.ts';
import type { Capsule } from './mesh.ts';
import { renderFluffy } from './renderer.ts';

/** Radius of a mark's model, viewBox units: enough for the short pile to read on a small dot. */
const RADIUS = 12;
const FRONT = viewBasis(0, 0);
/** Sprites are rendered a little larger than they are drawn, for the top of a hop. */
const HEADROOM = 1.12;

const models = new Map<number, Capsule>();
const sprites = new Map<string, { canvas: HTMLCanvasElement; radius: number }>();

/**
 * Paint a mark face-on as a fluffy ball or capsule filling `box`, under the context's transform
 * (which animates it). `scale` is device pixels per viewBox unit. False where fluffy can't be
 * drawn: the caller fills the mark's path instead.
 */
export function paintFluffyMark(ctx: CanvasRenderingContext2D, box: FramePath['box'], scale: number, color: string): boolean {
  const aspect = Math.round((1000 * box.h) / box.w) / 1000;
  let model = models.get(aspect);
  if (!model) {
    const halfHeight = RADIUS * aspect;
    model = { radius: RADIUS, bounds: { minX: -RADIUS, maxX: RADIUS, minY: -halfHeight, maxY: halfHeight } };
    models.set(aspect, model);
  }
  /** Drawn units per model unit. */
  const unit = box.w / (2 * RADIUS);
  // Whole powers of two, so a mark that grows or shrinks keeps the same fibers.
  const density = Math.min(8, Math.max(0.5, 2 ** Math.ceil(Math.log2(HEADROOM * scale * unit))));
  const key = `${aspect}|${color}|${density}`;
  let sprite = sprites.get(key);
  if (!sprite) {
    const image = renderFluffy(model, FRONT, { color, ink: color, eyes: [] }, density);
    if (!image) return false;
    // The renderer's canvas is shared with the body: keep a copy.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = image.size;
    const copy = canvas.getContext('2d');
    if (!copy) return false;
    copy.drawImage(image.canvas, image.x, image.y, image.size, image.size, 0, 0, image.size, image.size);
    sprite = { canvas, radius: image.radius };
    if (sprites.size >= 12) sprites.delete(sprites.keys().next().value!);
    sprites.set(key, sprite);
  }
  const radius = sprite.radius * unit;
  ctx.drawImage(sprite.canvas, -radius, -radius, 2 * radius, 2 * radius);
  return true;
}
