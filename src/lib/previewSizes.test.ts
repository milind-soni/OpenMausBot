import { describe, expect, it } from "vitest";
import {
  applyRotation,
  assignCanvasHeaderLanes,
  CANVAS_HEADER_LANE_HEIGHT,
  CANVAS_HEADER_MAX_WIDTH_PX,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  clampCustomDimension,
  clampCustomSize,
  computeCanvasFit,
  computeCanvasFitForArtboards,
  computeCanvasZoomAt,
  computeFrameScale,
  DEFAULT_CANVAS_SIZE_IDS,
  DEFAULT_MOBILE_DEVICE_PRESET_ID,
  layoutCanvasArtboards,
  MAX_CUSTOM_DIMENSION,
  MAX_LIVE_CANVAS_FRAMES,
  MIN_CUSTOM_DIMENSION,
  MOBILE_DEVICE_PRESETS,
  PREVIEW_SIZE_GROUPS,
  PREVIEW_SIZE_PRESETS,
  resolveLiveArtboardIds,
  resolvePreviewSize,
} from "./previewSizes";
import {
  DEFAULT_MOBILE_DEVICE_PRESET_ID as REEXPORTED_DEFAULT_ID,
  MOBILE_DEVICE_PRESETS as REEXPORTED_PRESETS,
} from "./mobileDevicePresets";

describe("previewSizes catalog and helpers", () => {
  it("groups phone, tablet, laptop, and desktop presets in order", () => {
    expect(PREVIEW_SIZE_GROUPS.map((g) => g.group)).toEqual(["phone", "tablet", "laptop", "desktop"]);
    expect(PREVIEW_SIZE_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_CANVAS_SIZE_IDS).toEqual(["iphone-16", "ipad-mini", "laptop-1280", "desktop-1440"]);
  });

  it("re-exports legacy mobileDevicePresets names for backward compatibility", () => {
    expect(REEXPORTED_PRESETS).toEqual(MOBILE_DEVICE_PRESETS);
    expect(REEXPORTED_DEFAULT_ID).toBe(DEFAULT_MOBILE_DEVICE_PRESET_ID);
    expect(resolvePreviewSize("iphone-14-pro").id).toBe("iphone-16");
    expect(resolvePreviewSize("pixel-7").id).toBe("pixel");
  });

  it("clamps custom size bounds between 240 and 3840", () => {
    expect(clampCustomDimension(100)).toBe(MIN_CUSTOM_DIMENSION);
    expect(clampCustomDimension(9000)).toBe(MAX_CUSTOM_DIMENSION);
    expect(clampCustomDimension(Number.NaN, 800)).toBe(800);
    expect(clampCustomSize({ width: 120, height: 5000 })).toEqual({
      width: MIN_CUSTOM_DIMENSION,
      height: MAX_CUSTOM_DIMENSION,
    });
    const custom = resolvePreviewSize("custom", { width: 640, height: 480 });
    expect(custom).toMatchObject({
      id: "custom",
      group: "custom",
      width: 640,
      height: 480,
      rotatable: true,
    });
  });

  it("rotates dimensions by swapping width and height", () => {
    const base = { width: 393, height: 852 };
    expect(applyRotation(base, false)).toEqual({ width: 393, height: 852 });
    expect(applyRotation(base, true)).toEqual({ width: 852, height: 393 });
  });

  it("computes frame scale for fit and fixed zoom levels", () => {
    expect(computeFrameScale({ width: 1440, height: 900 }, { width: 700, height: 700 }, "50")).toBe(0.5);
    expect(computeFrameScale({ width: 1440, height: 900 }, { width: 700, height: 700 }, "75")).toBe(0.75);
    expect(computeFrameScale({ width: 1440, height: 900 }, { width: 700, height: 700 }, "100")).toBe(1);
    const fit = computeFrameScale({ width: 1000, height: 500 }, { width: 532, height: 600 }, "fit", 16);
    expect(fit).toBeCloseTo(0.5, 4);
  });
});

describe("canvas board math and live-frame cap", () => {
  it("lays out artboards left-to-right with gap and rotation", () => {
    const layout = layoutCanvasArtboards(["iphone-se", "ipad-mini"], {
      rotatedById: { "iphone-se": true },
      gap: 120,
    });
    expect(layout.artboards).toHaveLength(2);
    // iphone-se rotated: 667x375 at left=0
    expect(layout.artboards[0]).toMatchObject({ id: "iphone-se", left: 0, width: 667, height: 375, rotated: true });
    // ipad-mini: 744x1133 at left=667+120=787
    expect(layout.artboards[1]).toMatchObject({ id: "ipad-mini", left: 787, width: 744, height: 1133, rotated: false });
    expect(layout.boardWidth).toBe(667 + 120 + 744);
    expect(layout.boardHeight).toBe(1133 + 48);
  });

  it("fits the board inside the viewport and zooms around a pointer anchor", () => {
    const fit = computeCanvasFit({ width: 1280, height: 800 }, { width: 4217, height: 1181 }, 48);
    expect(fit.k).toBeGreaterThanOrEqual(CANVAS_MIN_ZOOM);
    expect(fit.k).toBeLessThanOrEqual(CANVAS_MAX_ZOOM);
    expect(fit.x).toBeGreaterThan(0);
    expect(fit.y).toBeGreaterThan(0);

    const anchor = { x: 400, y: 300 };
    const zoomed = computeCanvasZoomAt(fit, 1.5, anchor);
    expect(zoomed.k).toBeCloseTo(fit.k * 1.5, 5);
    // Point under the anchor in board coordinates stays invariant.
    const boardXBefore = (anchor.x - fit.x) / fit.k;
    const boardXAfter = (anchor.x - zoomed.x) / zoomed.k;
    expect(boardXAfter).toBeCloseTo(boardXBefore, 5);
  });

  it("caps live frames at 6 and promotes hovered/clicked artboards", () => {
    const allEight = PREVIEW_SIZE_PRESETS.map((p) => p.id);
    expect(allEight.length).toBe(8);

    const initialLive = resolveLiveArtboardIds(allEight);
    expect(initialLive.size).toBe(MAX_LIVE_CANVAS_FRAMES);
    expect([...initialLive]).toEqual(allEight.slice(0, 6));
    expect(initialLive.has(allEight[7])).toBe(false);

    // Promoting the 8th and 7th artboard puts them in the live set and drops the 5th/6th.
    const promotedLive = resolveLiveArtboardIds(allEight, [allEight[7], allEight[6]]);
    expect(promotedLive.size).toBe(MAX_LIVE_CANVAS_FRAMES);
    expect(promotedLive.has(allEight[7])).toBe(true);
    expect(promotedLive.has(allEight[6])).toBe(true);
    expect(promotedLive.has(allEight[5])).toBe(false);
    expect(promotedLive.has(allEight[4])).toBe(false);
  });

  it("assigns non-overlapping 2D header lanes when all 8 presets are fitted at 1280x800", () => {
    const allEight = PREVIEW_SIZE_PRESETS.map((p) => p.id);
    const layout = layoutCanvasArtboards(allEight);
    const fit = computeCanvasFitForArtboards(
      { width: 1280, height: 800 },
      { width: layout.boardWidth, height: layout.boardHeight, artboards: layout.artboards },
      48,
    );
    const { lanes } = assignCanvasHeaderLanes(layout.artboards, fit.k);

    const boxes = layout.artboards.map((artboard) => {
      const lane = lanes[artboard.id] ?? 0;
      const left = fit.x + artboard.left * fit.k;
      const top = fit.y + 40 * fit.k - (lane + 1) * CANVAS_HEADER_LANE_HEIGHT;
      return {
        id: artboard.id,
        lane,
        left,
        right: left + CANVAS_HEADER_MAX_WIDTH_PX,
        top,
        bottom: top + 30,
      };
    });

    for (let i = 0; i < boxes.length; i += 1) {
      expect(boxes[i].top).toBeGreaterThanOrEqual(0);
      for (let j = i + 1; j < boxes.length; j += 1) {
        const horizOverlap = boxes[i].left < boxes[j].right && boxes[j].left < boxes[i].right;
        const vertOverlap = boxes[i].top < boxes[j].bottom && boxes[j].top < boxes[i].bottom;
        expect(horizOverlap && vertOverlap).toBe(false);
      }
    }
  });
});
