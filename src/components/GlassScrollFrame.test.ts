// The frame tells its scroller how tall the glass bars are, so rows rest
// clear of them and the scrollbar runs only between them.
import { describe, expect, it } from "vitest";

import { publishGlassInsets } from "./GlassScrollFrame";

function child(glassBar: string | undefined, height: number) {
  return { dataset: glassBar === undefined ? {} : { glassBar }, getBoundingClientRect: () => ({ height }) };
}

function frame(children: ReturnType<typeof child>[]) {
  const vars = new Map<string, string>();
  const element = { children, style: { setProperty: (name: string, value: string) => vars.set(name, value) } };
  publishGlassInsets(element as unknown as HTMLElement);
  return vars;
}

describe("publishGlassInsets", () => {
  it("publishes each bar's height, rounded up so no row ever tucks under a sub-pixel edge", () => {
    const vars = frame([child("top", 120.4), child(undefined, 900), child("bottom", 186)]);
    expect(vars.get("--glass-top")).toBe("121px");
    expect(vars.get("--glass-bottom")).toBe("186px");
  });

  it("publishes 0px for an edge without a bar, so a header-only frame keeps no bottom gap", () => {
    const vars = frame([child("top", 64), child(undefined, 500)]);
    expect(vars.get("--glass-top")).toBe("64px");
    expect(vars.get("--glass-bottom")).toBe("0px");
  });

  it("ignores everything that is not a bar, the scroller included", () => {
    const vars = frame([child(undefined, 700), child("sideways", 40)]);
    expect(vars.get("--glass-top")).toBe("0px");
    expect(vars.get("--glass-bottom")).toBe("0px");
  });
});
