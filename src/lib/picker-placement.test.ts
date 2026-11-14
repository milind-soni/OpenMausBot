import { describe, expect, it } from "vitest";
import { PICKER_GAP, PICKER_MARGIN, PICKER_MAX_HEIGHT, pickerPlacement } from "./picker-placement";

const viewport = { width: 1338, height: 870 };
const chip = (left: number, top: number, width = 150, height = 32) => ({ left, right: left + width, top, bottom: top + height });
const menu = { width: 300, height: 352 };

describe("where the model menu floats", () => {
  it("lines its right edge up with a chip in the window's right half and opens below it", () => {
    const placed = pickerPlacement(chip(1100, 10), menu, viewport);
    expect(placed).toMatchObject({ vertical: "below", edge: "right", left: 1250 - 300, width: 300, top: 42 + PICKER_GAP, origin: "top right" });
    expect(placed.bottom).toBeUndefined();
    expect(placed.maxHeight).toBe(PICKER_MAX_HEIGHT);
  });

  it("lines its left edge up with a chip in the window's left half, as in a composer", () => {
    expect(pickerPlacement(chip(420, 300), menu, viewport)).toMatchObject({ edge: "left", left: 420, origin: "top left" });
  });

  it("flips above a chip near the bottom, anchored by its bottom so growing content moves away from the chip", () => {
    const placed = pickerPlacement(chip(420, 800), menu, viewport);
    expect(placed).toMatchObject({ vertical: "above", bottom: 870 - 800 + PICKER_GAP, origin: "bottom left" });
    expect(placed.top).toBeUndefined();
    expect(placed.maxHeight).toBe(PICKER_MAX_HEIGHT);
  });

  it("stays below when it does not fit either way but below has more room, and caps its height to that room", () => {
    const placed = pickerPlacement(chip(420, 380), { width: 300, height: 900 }, viewport);
    expect(placed.vertical).toBe("below");
    expect(placed.maxHeight).toBe(870 - 412 - PICKER_GAP - PICKER_MARGIN);
    expect(pickerPlacement(chip(420, 450), { width: 300, height: 900 }, viewport)).toMatchObject({ vertical: "above", maxHeight: 450 - PICKER_GAP - PICKER_MARGIN });
  });

  it("keeps clear of the window's edges and narrows in a small window", () => {
    expect(pickerPlacement(chip(4, 10, 60), menu, viewport).left).toBe(PICKER_MARGIN);
    expect(pickerPlacement(chip(1310, 10, 28), menu, viewport).left).toBe(1338 - 300 - PICKER_MARGIN);
    expect(pickerPlacement(chip(10, 10, 40), menu, { width: 280, height: 600 })).toMatchObject({ left: PICKER_MARGIN, width: 264 });
  });

  it("lets a taller menu ask for a taller cap", () => {
    expect(pickerPlacement(chip(1100, 10), menu, viewport, undefined, 600).maxHeight).toBe(600);
    expect(pickerPlacement(chip(1100, 300), menu, viewport, undefined, 600).maxHeight).toBe(870 - 332 - PICKER_GAP - PICKER_MARGIN);
  });

  it("keeps the side it opened on while open", () => {
    const opened = pickerPlacement(chip(420, 300), menu, viewport);
    const scrolled = pickerPlacement(chip(800, 700), { width: 300, height: 600 }, viewport, opened);
    expect(scrolled).toMatchObject({ vertical: "below", edge: "left", left: 800 });
    expect(scrolled.maxHeight).toBe(870 - 732 - PICKER_GAP - PICKER_MARGIN);
  });
});
