import { afterEach, describe, expect, it, vi } from "vitest";

import { FACE_BOX } from "../../shared/cursor-face-data.ts";
import { importCustomMascotSvg } from "./custom-mascot-svg.ts";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SIMPLE_PATH = "M 0 0 L 10 0 L 10 10 L 0 10 Z";
const ELLIPSE_PATH = "M20 20A10 5 0 1 0 0 20A10 5 0 1 0 20 20Z";

interface SamplerOptions {
  totalLength?: number;
  pointAtLength?: (distance: number) => { x: number; y: number };
}

function installSampler(options: SamplerOptions = {}) {
  const totalLength = options.totalLength ?? 2 * Math.PI * 10;
  const pointAtLength = options.pointAtLength ?? ((distance: number) => {
    const angle = (distance / totalLength) * 2 * Math.PI;
    return { x: 10 + 10 * Math.cos(angle), y: 20 + 5 * Math.sin(angle) };
  });
  const attributes = new Map<string, string>();
  let sampleCalls = 0;
  let lengthCalls = 0;
  const path = {
    parentNode: null,
    isConnected: false,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getTotalLength() {
      lengthCalls++;
      return totalLength;
    },
    getPointAtLength(distance: number) {
      sampleCalls++;
      return pointAtLength(distance);
    },
  };
  const createElementNS = vi.fn(() => path);
  vi.stubGlobal("document", { createElementNS });

  return { attributes, createElementNS, get lengthCalls() { return lengthCalls; }, get sampleCalls() { return sampleCalls; } };
}

function svg(pathData: string, extraRootAttributes = "", extraPathAttributes = ""): string {
  return '<svg xmlns="' + SVG_NAMESPACE + '" ' + extraRootAttributes + '><path d="' +
    pathData + '" ' + extraPathAttributes + '/></svg>';
}

afterEach(() => vi.unstubAllGlobals());

describe("importCustomMascotSvg", () => {
  it("returns only a normalized name and bounded, aspect-preserving numeric outline", () => {
    const sampler = installSampler();
    const result = importCustomMascotSvg(
      svg(ELLIPSE_PATH, "", 'fill="#4f46e5"'),
      "C:\\exports\\  Élodie fox.svg",
    );
    const x = result.outline.map(([value]) => value);
    const y = result.outline.map(([, value]) => value);

    expect(result.name).toBe("Élodie fox");
    expect(Object.keys(result).sort()).toEqual(["name", "outline"]);
    expect(result).not.toHaveProperty("d");
    expect(result.outline).toHaveLength(512);
    expect(result.outline.every(([px, py]) => Number.isFinite(px) && Number.isFinite(py))).toBe(true);
    expect(Math.min(...x)).toBe(0);
    expect(Math.max(...x)).toBe(FACE_BOX);
    expect((Math.max(...x) - Math.min(...x)) / (Math.max(...y) - Math.min(...y))).toBeCloseTo(2, 2);
    expect(sampler.createElementNS).toHaveBeenCalledWith(SVG_NAMESPACE, "path");
    expect(sampler.attributes).toEqual(new Map([["d", ELLIPSE_PATH]]));
    expect(sampler.lengthCalls).toBe(1);
    expect(sampler.sampleCalls).toBe(512);
  });

  it("accepts the supported absolute and relative command families with strict arity", () => {
    const sampler = installSampler();
    const absolute = "M 0 0 L 1 1 H 2 V 3 C 1 2 3 4 5 6 S 1 2 3 4 Q 1 2 3 4 T 1 2 A 1 2 3 0 1 4 5 Z";
    const relative = "m 0 0 l 1 1 h 2 v 3 c 1 2 3 4 5 6 s 1 2 3 4 q 1 2 3 4 t 1 2 a 1 2 3 1 0 4 5 z";

    expect(() => importCustomMascotSvg(svg(absolute), "absolute.svg")).not.toThrow();
    expect(() => importCustomMascotSvg(svg(relative), "relative.svg")).not.toThrow();
    expect(sampler.createElementNS).toHaveBeenCalledTimes(2);
  });

  it("accepts compact adjacent flags in absolute and relative arc commands", () => {
    const sampler = installSampler();
    const absolute = "M-1e1 -1e1A1e1 1e1 0e0 011e1 1e1 1e1 1e1 0e0 102e1 1e1L+3e1 -1e1Z";
    const relative = "m0 0a10 10 0 1010 10l10 0z";

    expect(() => importCustomMascotSvg(svg(absolute), "absolute.svg")).not.toThrow();
    expect(() => importCustomMascotSvg(svg(relative), "relative.svg")).not.toThrow();
    expect(sampler.createElementNS).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["incomplete line parameters", "M0 0L10Z"],
    ["missing close command", "M0 0L10 10"],
    ["multiple subpaths", "M0 0L10 10M20 20Z"],
    ["unsupported command", "M0 0R10 10Z"],
    ["invalid number", "M0 0Lnope 10Z"],
    ["non-finite number", "M0 0L1e999 10Z"],
    ["out-of-range coordinate", "M0 0L1000001 10Z"],
    ["incomplete curve parameters", "M0 0C1 2 3Z"],
    ["invalid arc flag", "M0 0A10 10 0 2 0 20 20Z"],
    ["non-integral arc flag", "M0 0A10 10 0 0.0 1 20 20Z"],
    ["negative arc radius", "M0 0A-1 10 0 0 1 20 20Z"],
    ["duplicate close command", "M0 0L10 10ZZ"],
    ["trailing comma", "M0 0L10 10,Z"],
  ])("rejects %s", (_label, pathData) => {
    expect(() => importCustomMascotSvg(svg(pathData), "invalid.svg")).toThrow(/Invalid custom mascot SVG:/u);
  });

  it.each([
    ["a document type declaration", '<!DOCTYPE svg><svg xmlns="' + SVG_NAMESPACE + '"><path d="' + SIMPLE_PATH + '"/></svg>'],
    ["a nested group", '<svg xmlns="' + SVG_NAMESPACE + '"><g><path d="' + SIMPLE_PATH + '"/></g></svg>'],
    ["a second path", '<svg xmlns="' + SVG_NAMESPACE + '"><path d="' + SIMPLE_PATH + '"/><path d="' + SIMPLE_PATH + '"/></svg>'],
    ["an active child element", '<svg xmlns="' + SVG_NAMESPACE + '"><script>alert(1)</script><path d="' + SIMPLE_PATH + '"/></svg>'],
    ["an event attribute", svg(SIMPLE_PATH, "", 'onload="alert(1)"')],
    ["a transform", svg(SIMPLE_PATH, 'transform="scale(2)"')],
    ["a style resource", svg(SIMPLE_PATH, "", 'style="fill:url(https://example.test/a.svg#paint)"')],
    ["a foreign path reference", svg(SIMPLE_PATH, "", 'href="https://example.test/shape.svg"')],
    ["an entity reference", svg("M0 0L10 10&amp;Z")],
    ["a missing SVG namespace", '<svg><path d="' + SIMPLE_PATH + '"/></svg>'],
    ["mismatched closing markup", '<svg xmlns="' + SVG_NAMESPACE + '"><path d="' + SIMPLE_PATH + '"></svg>'],
    ["non-whitespace text", '<svg xmlns="' + SVG_NAMESPACE + '">text<path d="' + SIMPLE_PATH + '"/></svg>'],
  ])("rejects %s", (_label, markup) => {
    expect(() => importCustomMascotSvg(markup, "invalid.svg")).toThrow(/Invalid custom mascot SVG:/u);
  });

  it("enforces byte and command limits before creating a path", () => {
    const oversized = "<svg>" + " ".repeat(128 * 1024) + "</svg>";
    const tooManyCommands = "M0 0" + "L1 1".repeat(4_097) + "Z";

    expect(() => importCustomMascotSvg(oversized, "large.svg")).toThrow(/file is larger/u);
    expect(() => importCustomMascotSvg(svg(tooManyCommands), "complex.svg")).toThrow(/too many commands/u);
  });

  it("rejects non-finite browser samples and paths with intersecting sampled edges", () => {
    installSampler({ pointAtLength: () => ({ x: Number.NaN, y: 5 }) });
    expect(() => importCustomMascotSvg(svg(SIMPLE_PATH), "nan.svg")).toThrow(/sampled path coordinate/u);

    const crossing = [
      [0, 0], [10, 10], [0, 10], [10, 0],
    ] as const;
    installSampler({
      totalLength: crossing.length,
      pointAtLength: (distance) => {
        const segment = Math.floor(distance);
        const progress = distance - segment;
        const start = crossing[segment % crossing.length]!;
        const end = crossing[(segment + 1) % crossing.length]!;
        return {
          x: start[0] + (end[0] - start[0]) * progress,
          y: start[1] + (end[1] - start[1]) * progress,
        };
      },
    });
    expect(() => importCustomMascotSvg(svg("M0 0L10 10L0 10L10 0Z"), "crossing.svg")).toThrow(/simple closed outline/u);
  });

  it("uses a safe fallback name and caps normalized names", () => {
    installSampler();
    expect(importCustomMascotSvg(svg(ELLIPSE_PATH), ".svg").name).toBe("Custom Mascot");
    const longName = "x".repeat(100) + ".svg";
    expect(importCustomMascotSvg(svg(ELLIPSE_PATH), longName).name).toBe("x".repeat(80));
    const longEmojiName = "\u{1f600}".repeat(100) + ".svg";
    expect(importCustomMascotSvg(svg(ELLIPSE_PATH), longEmojiName).name).toBe("\u{1f600}".repeat(40));
  });
});
