import { describe, expect, it } from "vitest";

import { DataFailure } from "./types.ts";
import { validateVegaLite } from "./vega-lite-validator.ts";

const bar = {
  mark: "bar",
  encoding: { x: { field: "region", type: "nominal" }, y: { field: "amount", type: "quantitative" } },
};

async function refused(spec: unknown): Promise<DataFailure> {
  try {
    await validateVegaLite(spec);
  } catch (error) {
    if (error instanceof DataFailure) return error;
    throw error;
  }
  throw new Error("expected spec_invalid");
}

describe("validateVegaLite", () => {
  it("passes a valid spec and binds it to the dataset named table", async () => {
    const out = await validateVegaLite(bar);
    expect(out.data).toEqual({ name: "table" });
    expect(out.$schema).toBe("https://vega.github.io/schema/vega-lite/v6.json");
    expect(out.width).toBe("container");
    expect(out.mark).toBe("bar");
    // The input is not touched.
    expect(bar).not.toHaveProperty("data");
  });

  it("keeps a spec's own width and leaves concat specs unsized", async () => {
    expect((await validateVegaLite({ ...bar, width: 300 })).width).toBe(300);
    const concat = await validateVegaLite({ hconcat: [{ ...bar, data: { name: "table" } }, { ...bar, data: { name: "table" } }] });
    expect(concat.width).toBeUndefined();
  });

  it("refuses inline values, URLs and generators wherever they sit", async () => {
    for (const spec of [
      { ...bar, data: { values: [{ region: "a", amount: 1 }] } },
      { ...bar, data: { url: "https://example.com/rows.csv" } },
      { ...bar, data: { sequence: { start: 0, stop: 10 } } },
      { layer: [{ ...bar, data: { values: [] } }] },
      { hconcat: [{ ...bar, data: { url: "x.json" } }] },
      { ...bar, transform: [{ lookup: "region", from: { data: { values: [{ region: "a", n: 1 }] }, key: "region", fields: ["n"] } }] },
    ]) {
      const error = await refused(spec);
      expect(error.error.code).toBe("spec_invalid");
      expect(error.error.message).toContain("inline data is not allowed");
    }
  });

  it("refuses datasets and a dataset by any other name", async () => {
    expect((await refused({ ...bar, datasets: { rows: [] } })).error.message).toContain("datasets");
    expect((await refused({ ...bar, data: { name: "rows" } })).error.message).toBe('data: data must be {name: "table"}');
    // null is "no data", the same as absent: it becomes the table.
    expect((await validateVegaLite({ ...bar, data: null })).data).toEqual({ name: "table" });
  });

  it("refuses an unknown mark with the validator's own words", async () => {
    const error = await refused({ ...bar, mark: "sparkle" });
    expect(error.error.code).toBe("spec_invalid");
    expect(error.error.message).toMatch(/^mark: must be equal to one of the allowed values: \[/);
    expect(error.error.message).toContain('"bar"');
  });

  it("points at the wrong field, not at the top-level branch that failed", async () => {
    const error = await refused({ ...bar, encoding: { ...bar.encoding, x: { field: "region", type: "categorical" } } });
    expect(error.error.message).toMatch(/^encoding\.x\.type: must be equal to one of the allowed values/);
    expect(error.error.message).toContain('"nominal"');
    expect((await refused({ ...bar, height: "tall" })).error.message).toMatch(/^height: /);
  });

  it("refuses a schema-valid spec that Vega cannot compile", async () => {
    const broken = { ...bar, transform: [{ calculate: "datum.amount +", as: "z" }] };
    const error = await refused(broken);
    expect(error.error.code).toBe("spec_invalid");
    expect(error.error.message).toMatch(/^Vega-Lite spec does not compile: /);
    const label = { ...bar, encoding: { ...bar.encoding, x: { ...bar.encoding.x, axis: { labelExpr: "datum.value +" } } } };
    expect((await refused(label)).error.message).toContain("does not compile");
  });

  it("refuses what is not an object", async () => {
    expect((await refused("mark: bar")).error.message).toBe("vegaLite must be an object");
    expect((await refused([bar])).error.message).toBe("vegaLite must be an object");
  });
});
