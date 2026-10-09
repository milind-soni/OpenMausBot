import { describe, expect, it } from "vitest";

import type { DataColumn } from "../../shared/data-surface.ts";
import { compileChart } from "./chart-compiler.ts";
import { chartRenderer, coerceRows, parseTemporal } from "./render.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** IHDR is the first chunk: width is the big-endian uint32 at byte 16. */
const pngWidth = (png: Buffer): number => png.readUInt32BE(16);

const source: DataColumn[] = [
  { name: "region", type: "VARCHAR" },
  { name: "amount", type: "DECIMAL(10,2)" },
];
const { vegaLite } = compileChart({ type: "bar", x: "region", y: "amount" }, source, "sales");
// What the reduced SQL returns: x as text, the sum as a decimal — a string in JSON.
const columns: DataColumn[] = [
  { name: "x", type: "VARCHAR" },
  { name: "y", type: "DECIMAL(38,2)" },
];
const rows = [
  ["north", "1200.50"],
  ["south", "830.00"],
  ["west", "410.25"],
];

describe("coerceRows", () => {
  it("turns numeric strings into numbers and leaves text and nulls alone", () => {
    const out = coerceRows(
      [
        ["a", "12", "9007199254740993", 1.5, null],
        [null, null, "0", 2, true],
      ],
      [
        { name: "s", type: "VARCHAR" },
        { name: "i", type: "BIGINT" },
        { name: "h", type: "HUGEINT" },
        { name: "d", type: "DOUBLE" },
        { name: "b", type: "BOOLEAN" },
      ],
    );
    expect(out[0]).toEqual({ s: "a", i: 12, h: 9007199254740992, d: 1.5, b: null });
    expect(out[1]).toEqual({ s: null, i: null, h: 0, d: 2, b: true });
  });

  it("parses dates and naive timestamps as local wall-clock time", () => {
    const date = parseTemporal("2024-03-01") as Date;
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2024, 2, 1, 0]);
    const ts = parseTemporal("2024-03-01 12:30:15.250") as Date;
    expect([ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds()]).toEqual([12, 30, 15, 250]);
    const micros = parseTemporal("2024-03-01T12:30:15.123456") as Date;
    expect(micros.getMilliseconds()).toBe(123);
  });

  it("honours a zone when the column has one and keeps what it cannot parse", () => {
    const zoned = parseTemporal("2024-01-01 05:30:00+05:30") as Date;
    expect(zoned.getTime()).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
    expect(parseTemporal("infinity")).toBe("infinity");
    const out = coerceRows([["2024-03-01", "x"]], [{ name: "d", type: "DATE" }, { name: "t", type: "TIMESTAMP" }]);
    expect(out[0]!.d).toBeInstanceOf(Date);
    expect(out[0]!.t).toBe("x");
  });
});

describe("chartRenderer", () => {
  it("renders SVG with the axis titles and a bar per row", async () => {
    const svg = await chartRenderer.svg(vegaLite, rows, columns, { theme: "light" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(">region</text>");
    expect(svg).toContain(">sum(amount)</text>");
    expect(svg).toContain(">north</text>");
    // Three bars: the y strings became numbers, so each has a height.
    const bars = svg.match(/<path class="background"|role="graphics-symbol" aria-roledescription="bar"/g) ?? [];
    expect(bars.length).toBeGreaterThanOrEqual(3);
    expect(svg).toContain('font-family="&quot;Inter&quot;, -apple-system');
  });

  it("takes the width it is given in place of the container", async () => {
    const narrow = await chartRenderer.svg(vegaLite, rows, columns, { theme: "light", width: 300 });
    const wide = await chartRenderer.svg(vegaLite, rows, columns, { theme: "light", width: 900 });
    const width = (svg: string): number => Number(/<svg[^>]* width="(\d+)"/.exec(svg)![1]);
    expect(width(wide)).toBeGreaterThan(width(narrow));
    expect(width(wide) - width(narrow)).toBe(600);
  });

  it("inks a dark chart with the dark text colour and a light one with the light", async () => {
    const dark = await chartRenderer.svg(vegaLite, rows, columns, { theme: "dark" });
    const light = await chartRenderer.svg(vegaLite, rows, columns, { theme: "light" });
    expect(dark).toContain('fill="#a3a3a3"');
    expect(dark).not.toContain('fill="#6b6559"');
    expect(dark).toContain('stroke="#333333"');
    expect(light).toContain('fill="#6b6559"');
    expect(light).not.toContain('fill="#a3a3a3"');
    expect(light).toContain('stroke="#c8bda8"');
  });

  it("renders a PNG that is twice as wide at scale 2 and carries the surface", async () => {
    const one = await chartRenderer.png(vegaLite, rows, columns, { theme: "dark", width: 400 });
    const two = await chartRenderer.png(vegaLite, rows, columns, { theme: "dark", width: 400, scale: 2 });
    expect(one.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(two.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngWidth(one)).toBe(400);
    expect(pngWidth(two)).toBe(800);
    expect(two.length).toBeGreaterThan(one.length);
  });
});
