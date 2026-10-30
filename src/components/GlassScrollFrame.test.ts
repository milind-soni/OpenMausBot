import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GlassBar, GlassScrollFrame, GlassScroller, publishGlassInsets, watchScrollFade } from "./GlassScrollFrame";

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

describe("the scroll fade", () => {
  const resized: (() => void)[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    resized.length = 0;
  });

  function list(scrollHeight: number, clientHeight = 500) {
    const listeners = new Map<string, () => void>();
    const element = {
      scrollTop: 0, scrollHeight, clientHeight, children: [{}],
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); },
      scrollTo: (top: number) => { element.scrollTop = top; listeners.get("scroll")?.(); },
    };
    return element;
  }
  function frame() {
    const attributes = new Map<string, string>();
    return {
      fade: () => attributes.get("data-scroll-fade") ?? null,
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
    };
  }
  const watch = (scroller: ReturnType<typeof list>, target: ReturnType<typeof frame>) => watchScrollFade(scroller as unknown as HTMLElement, target as unknown as HTMLElement);
  const frameHtml = (fade: boolean) => renderToStaticMarkup(createElement(GlassScrollFrame, { fade, children: [
    createElement(GlassBar, { key: "head", edge: "top", children: "head" }),
    createElement(GlassScroller, { key: "rows", children: "rows" }),
    createElement(GlassBar, { key: "foot", edge: "bottom", children: "foot" }),
  ] }));

  it("fades only the bottom at the top of a long list, both edges in the middle, and only the top at its end", () => {
    const rows = list(2000);
    const target = frame();
    const stop = watch(rows, target);
    expect(target.fade()).toBe("end");
    rows.scrollTo(700);
    expect(target.fade()).toBe("both");
    rows.scrollTo(1500);
    expect(target.fade()).toBe("start");
    rows.scrollTo(1499.5);
    expect(target.fade()).toBe("start");
    rows.scrollTo(0);
    expect(target.fade()).toBe("end");
    stop();
    expect(target.fade()).toBeNull();
  });

  it("shows no fade on a list that fits, and drops both when a scrolled list shrinks to fit", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized.push(callback); }
      observe() {}
      disconnect() {}
    });
    const short = frame();
    watch(list(480), short);
    expect(short.fade()).toBeNull();
    const rows = list(2000);
    const target = frame();
    watch(rows, target);
    rows.scrollTo(700);
    expect(target.fade()).toBe("both");
    rows.scrollHeight = 500;
    rows.scrollTop = 0;
    for (const callback of resized) callback();
    expect(target.fade()).toBeNull();
  });

  it("stacks the bars around the list and draws a 24px band of the surface colour at each edge, shown only by its own edge", () => {
    const html = frameHtml(true);
    expect(html).toMatch(/^<div data-glass-frame="" class="relative min-h-0 flex flex-col">/);
    expect(html).toContain('<div data-glass-bar="top" class="relative z-10 shrink-0">head</div>');
    expect(html).toContain('<div data-glass-bar="bottom" class="relative z-10 shrink-0">foot</div>');
    expect(html).not.toContain("glass-bar ");
    expect(html).not.toContain("glass-scroller");
    const band = (edge: string) => new RegExp(`data-scroll-fade-edge="${edge}" class="([^"]*)"`).exec(html)![1]!;
    for (const edge of ["top", "bottom"]) {
      expect(band(edge)).toMatch(/^pointer-events-none absolute inset-x-0 z-10 h-6 bg-\[var\(--scroll-fade-surface,var\(--color-panel\)\)\] opacity-0 transition-opacity duration-150 ease-out /);
      expect(band(edge)).not.toMatch(/blur|backdrop|shadow/);
    }
    expect(band("top")).toContain("top-0 [mask-image:linear-gradient(to_bottom,black,transparent)]");
    expect(band("top").match(/scroll-fade=(\w+)/g)).toEqual(["scroll-fade=start", "scroll-fade=both"]);
    expect(band("bottom")).toContain("bottom-0 [mask-image:linear-gradient(to_top,black,transparent)]");
    expect(band("bottom").match(/scroll-fade=(\w+)/g)).toEqual(["scroll-fade=end", "scroll-fade=both"]);
  });

  it("keeps the floating glass bars when the frame does not fade", () => {
    const html = frameHtml(false);
    expect(html).toContain('<div data-glass-bar="top" class="glass-bar absolute inset-x-0 z-10 top-0">head</div>');
    expect(html).toContain('<div class="glass-scroller h-full overflow-y-auto"><div class="glass-scroller-content">rows</div></div>');
    expect(html).not.toContain("data-scroll-fade-edge");
  });
});

describe("a fading bar", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[[\]().:"]/g, "\\$&")} \\{[^}]*\\}`))?.[0] ?? "";

  it("marks itself, and a plain bar stays glass", () => {
    const fading = renderToStaticMarkup(createElement(GlassBar, { edge: "top", fade: true, children: "x" }));
    const glass = renderToStaticMarkup(createElement(GlassBar, { edge: "top", children: "x" }));
    expect(fading).toContain('data-glass-fade=""');
    expect(glass).not.toContain("data-glass-fade");
  });

  it("fades into the canvas with no tint or blur: hidden at the edge, full strength over its last 60px", () => {
    const fade = rule('.glass-bar[data-glass-fade]::before');
    expect(fade).toContain("linear-gradient(to bottom, var(--color-app), var(--color-app) calc(100% - var(--glass-fade)), transparent)");
    expect(fade).toMatch(/[^-]backdrop-filter: none/);
    expect(fade).toContain("mask-image: none");
    expect(rule('.glass-bar[data-glass-fade]')).toContain("--glass-fade: 60px");
  });
});
