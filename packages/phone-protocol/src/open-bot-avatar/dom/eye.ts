/** An eye mark on a 2D canvas: its bounds, and its paint. Shared by the flat painter and the fluffy sockets. */
import type { EyeMark, FramePath } from '../render.ts';

export function eyeBox(mark: EyeMark): FramePath['box'] {
  if (mark.shape === 'pill') return { x: mark.x, y: mark.y, w: mark.width, h: mark.height };
  // Quadratics lie within their points' hull; an arc's stroke reaches half its width past it.
  const reach = mark.shape === 'arc' ? mark.strokeWidth : 0;
  const n = (mark.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs) - reach, y = Math.min(...ys) - reach;
  return { x, y, w: Math.max(...xs) + reach - x, h: Math.max(...ys) + reach - y };
}

/** Fill or stroke the mark in the context's current styles. */
export function paintEye(ctx: CanvasRenderingContext2D, mark: EyeMark) {
  if (mark.shape === 'path') {
    ctx.fill(new Path2D(mark.d));
    return;
  }
  if (mark.shape === 'arc') {
    ctx.lineWidth = mark.strokeWidth;
    ctx.stroke(new Path2D(mark.d));
    return;
  }
  const { x, y, width: w, height: h, radius: r } = mark;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else {
    // Safari before 16 and Firefox before 112.
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  ctx.fill();
}
