// The trimming policy, on the shapes real MCP servers actually return.
import { describe, expect, it } from "vitest";

import { DEFAULT_RESULT_BUDGET, trimResultText } from "./mcp-trim.ts";

const product = (i: number) => ({
  id: `p${i}`,
  name: `Protein Bar ${i}`,
  price: 199 + i,
  rating: 4.2,
  description: "x".repeat(300),
  images: ["https://example.test/a.png", "https://example.test/b.png"],
});

describe("trimResultText", () => {
  it("leaves a result that already fits completely alone", () => {
    const text = JSON.stringify({ cart: { items: 1, total: 131 } });
    const out = trimResultText({ text });
    expect(out.trimmed).toBe(false);
    expect(out.text).toBe(text);
  });

  it("keeps whole records from the bulk array and says what it dropped", () => {
    const text = JSON.stringify({ nextOffset: "1", products: Array.from({ length: 200 }, (_, i) => product(i)) });
    const out = trimResultText({ text, spillPath: "/data/tool-results/7.json" });

    expect(out.trimmed).toBe(true);
    expect(out.text.length).toBeLessThan(DEFAULT_RESULT_BUDGET);
    expect(out.originalChars).toBe(text.length);

    const kept = JSON.parse(out.text.slice(0, out.text.indexOf("\n\n[OpenMausBot")));
    // whole records, not a severed one
    expect(kept.products.length).toBeGreaterThan(0);
    expect(kept.products.length).toBeLessThan(200);
    expect(kept.products[0]).toEqual(product(0));
    // fields outside the bulk array survive intact
    expect(kept.nextOffset).toBe("1");

    expect(out.text).toContain(`products ${kept.products.length} of 200`);
    // the path is NOT offered: a model that reads it back costs more than no
    // trimming at all, which is the whole point of the cut
    expect(out.text).not.toContain("/data/tool-results/7.json");
    expect(out.text).toContain("narrower query");
  });

  it("shares the budget across several bulk arrays", () => {
    const text = JSON.stringify({
      restaurants: Array.from({ length: 60 }, (_, i) => product(i)),
      dishes: Array.from({ length: 60 }, (_, i) => product(i)),
    });
    const out = trimResultText({ text });
    const kept = JSON.parse(out.text.slice(0, out.text.indexOf("\n\n[OpenMausBot")));
    expect(kept.restaurants.length).toBeGreaterThan(0);
    expect(kept.dishes.length).toBeGreaterThan(0);
  });

  it("trims a bare array root", () => {
    const text = JSON.stringify(Array.from({ length: 200 }, (_, i) => product(i)));
    const out = trimResultText({ text });
    const kept = JSON.parse(out.text.slice(0, out.text.indexOf("\n\n[OpenMausBot")));
    expect(Array.isArray(kept)).toBe(true);
    expect(kept.length).toBeLessThan(200);
    expect(kept[0]).toEqual(product(0));
    expect(out.text).toContain("items");
  });

  it("falls back to a text cut for a payload that is not JSON", () => {
    const text = "y".repeat(50_000);
    const out = trimResultText({ text, spillPath: "/data/tool-results/9.json" });
    expect(out.trimmed).toBe(true);
    expect(out.text.length).toBeLessThan(DEFAULT_RESULT_BUDGET);
    // the model is told the prefix may not parse, so it does not trust it as JSON
    expect(out.text).toContain("may be incomplete");
    expect(out.text).not.toContain("/data/tool-results/9.json");
  });

  it("names the saved file only when the caller asks for the hint", () => {
    const text = JSON.stringify({ products: Array.from({ length: 200 }, (_, i) => product(i)) });
    const out = trimResultText({ text, spillPath: "/data/tool-results/7.json", spillHint: true });
    expect(out.text).toContain("/data/tool-results/7.json");
    // and it still says reading it is not the cheap option
    expect(out.text).toContain("costs as much as not trimming");
  });

  it("falls back to a text cut when one record is bigger than the whole budget", () => {
    const text = JSON.stringify({ products: [{ id: "p0", blob: "z".repeat(40_000) }] });
    const out = trimResultText({ text });
    expect(out.trimmed).toBe(true);
    expect(out.text.length).toBeLessThan(DEFAULT_RESULT_BUDGET);
  });

  it("never cuts a surrogate pair in half", () => {
    const text = `${"🍵".repeat(20_000)}`;
    const out = trimResultText({ text, budget: 4_000 });
    const body = out.text.slice(0, out.text.indexOf("\n\n[OpenMausBot"));
    expect([...body].every((ch) => ch === "🍵")).toBe(true);
  });

  it("honours a caller's budget and a floor below it", () => {
    const text = JSON.stringify({ products: Array.from({ length: 200 }, (_, i) => product(i)) });
    expect(trimResultText({ text, budget: 20_000 }).text.length).toBeLessThan(20_000);
    // an absurd budget still leaves room for a record and the marker
    const tiny = trimResultText({ text, budget: 1 });
    expect(tiny.trimmed).toBe(true);
    expect(tiny.text.length).toBeLessThan(1_500);
  });

  it("survives a result whose text is empty or tiny", () => {
    expect(trimResultText({ text: "" }).trimmed).toBe(false);
    expect(trimResultText({ text: "ok" }).text).toBe("ok");
  });
});
