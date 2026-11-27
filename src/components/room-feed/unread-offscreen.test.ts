import { describe, expect, it } from "vitest";
import { hiddenMark } from "./unread-offscreen";

const view = { top: 100, bottom: 500 };

describe("an unread row out of the feed's sight", () => {
  it("is none while every marked row shows, even one partly under the header", () => {
    expect(hiddenMark(view, [])).toBeNull();
    expect(hiddenMark(view, [{ top: 120, bottom: 180 }, { top: 80, bottom: 140 }])).toBeNull();
  });

  it("points to the nearest hidden one, above or below", () => {
    expect(hiddenMark(view, [{ top: -300, bottom: -240 }, { top: 20, bottom: 90 }, { top: 300, bottom: 360 }])).toEqual({ dir: "above", index: 1 });
    expect(hiddenMark(view, [{ top: -300, bottom: -240 }, { top: 520, bottom: 580 }])).toEqual({ dir: "below", index: 1 });
  });
});
