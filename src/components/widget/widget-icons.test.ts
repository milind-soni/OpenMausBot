import { Dot } from "lucide-react";
import { describe, expect, it } from "vitest";

import { WIDGET_ICON_NAMES } from "../../../shared/widget";
import { isWidgetDot, WIDGET_ICONS, widgetIcon, widgetIconFilled } from "./widget-icons";

describe("widget icons", () => {
  it("has a lucide icon for every canonical name, and no name of its own", () => {
    expect(WIDGET_ICON_NAMES.filter((name) => !Object.hasOwn(WIDGET_ICONS, name))).toEqual([]);
    expect(Object.keys(WIDGET_ICONS).filter((name) => !WIDGET_ICON_NAMES.includes(name))).toEqual([]);
    for (const name of WIDGET_ICON_NAMES) expect(widgetIcon(name), name).toBe(WIDGET_ICONS[name]);
  });

  it("draws the dot for a name it does not know, and only `dot` maps to it", () => {
    for (const unknown of ["rocket", "", "constructor", "__proto__", undefined, null, 7]) {
      expect(widgetIcon(unknown)).toBe(Dot);
      expect(isWidgetDot(unknown)).toBe(true);
    }
    expect(WIDGET_ICON_NAMES.filter((name) => WIDGET_ICONS[name] === Dot)).toEqual(["dot"]);
    expect(isWidgetDot("check")).toBe(false);
  });

  it("fills only the filled star", () => {
    expect(WIDGET_ICON_NAMES.filter(widgetIconFilled)).toEqual(["star-filled"]);
  });
});
