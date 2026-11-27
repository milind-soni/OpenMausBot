import { afterEach, describe, expect, it, vi } from "vitest";

import { preparedVolume } from "../packages/phone-protocol/src/open-bot-avatar/render.ts";
import { SHAPE_BODIES } from "./object-bodies.ts";

/** A 2D canvas that draws nothing: the renderer's color reader and texture tiles. */
function blankCanvas() {
  const ctx = new Proxy({}, { get: (_, name) => (name === "getImageData" ? () => ({ data: [255, 0, 0, 255] }) : () => {}) });
  return { width: 0, height: 0, getContext: () => ctx };
}

/**
 * A WebGL2 stand-in that keeps one flag per pixel: set wherever a draw may have painted (its
 * whole viewport), cleared by a clear (inside the scissor box). Rows count from the bottom.
 */
function fakeCanvas() {
  const canvas = { width: 0, height: 0, addEventListener() {}, getContext: () => gl };
  let painted = new Uint8Array(0);
  let size = 0;
  let scissor = [0, 0, 0, 0];
  let viewport = [0, 0, 0, 0];
  const sync = () => {
    if (canvas.width === size) return;
    size = canvas.width;
    painted = new Uint8Array(size * size);
  };
  const fill = ([x, y, w, h]: number[], value: number) => {
    sync();
    for (let row = y; row < Math.min(size, y + h); row++) painted.fill(value, row * size + x, row * size + Math.min(size, x + w));
  };
  const draw = () => fill(viewport, 1);
  const calls: Record<string, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => false,
    scissor: (...box: number[]) => (scissor = box),
    viewport: (...box: number[]) => (viewport = box),
    clear: () => fill(scissor, 0),
    drawElements: draw,
    drawArraysInstanced: draw,
  };
  const gl = new Proxy({}, { get: (_, name: string) => calls[name] ?? (() => ({})) });
  return { canvas, isPainted: (x: number, y: number) => (sync(), painted[y * size + x] === 1) };
}

describe("fluffy coat images", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leave no earlier, larger image around a smaller one for the painter's smoothing to pick up", async () => {
    const fake = fakeCanvas();
    // The renderer's own canvas comes first; the rest are 2D scratch canvases.
    let created = 0;
    vi.stubGlobal("document", { createElement: () => (created++ === 0 ? fake.canvas : blankCanvas()) });
    const { renderFluffy } = await import("../packages/phone-protocol/src/open-bot-avatar/dom/fluffy/renderer.ts");
    const shape = preparedVolume(SHAPE_BODIES.squircle, 1).vol;
    const view = { cY: 1, sY: 0, cP: 1, sP: 0, facing: 1 };
    const look = { color: "#f97316", ink: "#000", eyes: [] };

    const big = renderFluffy(shape, view, look, 1.2)!;
    const small = renderFluffy(shape, view, look, 0.88)!;
    expect(small.size).toBeLessThan(big.size);

    // The painter scales the image a little as the avatar moves, so its edge blends with the
    // pixels just outside it: the row above and the column to the right must be empty.
    const leftover = { above: 0, right: 0 };
    for (let i = 0; i <= small.size; i++) {
      if (fake.isPainted(i, small.size)) leftover.above++;
      if (fake.isPainted(small.size, i)) leftover.right++;
    }
    expect(leftover).toEqual({ above: 0, right: 0 });
  });
});
