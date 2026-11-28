// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { PREVIEW_ZOOM_MAX, panBy, wheelPixels, zoomAtPoint, zoomByStep, type PreviewZoom } from "./preview-zoom";

const imagePixelAt = (zoom: PreviewZoom, point: { x: number; y: number }) =>
  ({ x: (point.x - zoom.x) / zoom.scale, y: (point.y - zoom.y) / zoom.scale });

describe("zooming a previewed image at a point", () => {
  it("keeps the pixel under the pointer in place as it zooms in and out", () => {
    const first = { x: 300, y: 40 };
    let zoomed = zoomAtPoint({ scale: 1, x: 0, y: 0 }, -150, first);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(imagePixelAt(zoomed, first)).toEqual({ x: expect.closeTo(300), y: expect.closeTo(40) });

    const second = { x: 120, y: 500 };
    const before = imagePixelAt(zoomed, second);
    for (const deltaY of [-100, -100, 60]) {
      const next = zoomAtPoint(zoomed, deltaY, second);
      expect(imagePixelAt(next, second)).toEqual({ x: expect.closeTo(before.x), y: expect.closeTo(before.y) });
      zoomed = next;
    }
  });

  it("stops at the largest zoom, and fits again once zoomed back out", () => {
    let zoom: PreviewZoom = { scale: 1, x: 0, y: 0 };
    for (let step = 0; step < 40; step++) zoom = zoomAtPoint(zoom, -100, { x: 50, y: 50 });
    expect(zoom.scale).toBe(PREVIEW_ZOOM_MAX);
    for (let step = 0; step < 40; step++) zoom = zoomAtPoint(zoom, 100, { x: 400, y: 10 });
    expect(zoom).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("leaves a fitted image fitted when the wheel turns down", () => {
    expect(zoomAtPoint({ scale: 1, x: 0, y: 0 }, 100, { x: 10, y: 10 })).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("zooms by half again per button step around the given point, and back to fitted", () => {
    const center = { x: 200, y: 150 };
    const once = zoomByStep({ scale: 1, x: 0, y: 0 }, 1, center);
    expect(once.scale).toBeCloseTo(1.5);
    expect(imagePixelAt(once, center)).toEqual({ x: expect.closeTo(200), y: expect.closeTo(150) });
    expect(zoomByStep(zoomByStep(once, 1, center), -1, center).scale).toBeCloseTo(1.5);
    expect(zoomByStep(once, -1, center)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("stops button steps at the largest zoom", () => {
    let zoom: PreviewZoom = { scale: 1, x: 0, y: 0 };
    for (let step = 0; step < 12; step++) zoom = zoomByStep(zoom, 1, { x: 0, y: 0 });
    expect(zoom.scale).toBe(PREVIEW_ZOOM_MAX);
  });

  it("moves a zoomed image by the drag distance, and leaves a fitted image in place", () => {
    expect(panBy({ scale: 2, x: -40, y: 10 }, 15, -25)).toEqual({ scale: 2, x: -25, y: -15 });
    expect(panBy({ scale: 1, x: 0, y: 0 }, 15, -25)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("reads a wheel's lines and pages as pixels", () => {
    expect(wheelPixels({ deltaY: -120, deltaMode: WheelEvent.DOM_DELTA_PIXEL }, 700)).toBe(-120);
    expect(wheelPixels({ deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE }, 700)).toBe(-48);
    expect(wheelPixels({ deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE }, 700)).toBe(-700);
  });
});
