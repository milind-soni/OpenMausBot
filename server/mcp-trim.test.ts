import { describe, expect, it } from "vitest";

import { DEFAULT_RESULT_BUDGET, trimResultText } from "./mcp-trim.ts";

const BANNER = "⚠️ TRUNCATED by OpenMausBot:";
/** What was kept, between the banner at the start and the one at the end. */
const keptBody = (text: string) => text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf(`\n\n${BANNER}`));

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

    const kept = JSON.parse(keptBody(out.text));
    expect(kept.products.length).toBeGreaterThan(0);
    expect(kept.products.length).toBeLessThan(200);
    expect(kept.products[0]).toEqual(product(0));
    expect(kept.nextOffset).toBe("1");

    expect(out.text).toContain(`products ${kept.products.length} of 200`);
    expect(out.text).not.toContain("/data/tool-results/7.json");
    expect(out.text).toContain("narrower query");
    expect(out.text).toContain("never assume you saw everything");
  });

  it("shares the budget across several bulk arrays", () => {
    const text = JSON.stringify({
      restaurants: Array.from({ length: 60 }, (_, i) => product(i)),
      dishes: Array.from({ length: 60 }, (_, i) => product(i)),
    });
    const out = trimResultText({ text });
    const kept = JSON.parse(keptBody(out.text));
    expect(kept.restaurants.length).toBeGreaterThan(0);
    expect(kept.dishes.length).toBeGreaterThan(0);
  });

  it("trims a bare array root", () => {
    const text = JSON.stringify(Array.from({ length: 200 }, (_, i) => product(i)));
    const out = trimResultText({ text });
    const kept = JSON.parse(keptBody(out.text));
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
    expect(out.text).toContain("may be incomplete");
    expect(out.text).not.toContain("/data/tool-results/9.json");
  });

  it("names the saved file only when the caller asks for the hint", () => {
    const text = JSON.stringify({ products: Array.from({ length: 200 }, (_, i) => product(i)) });
    const out = trimResultText({ text, spillPath: "/data/tool-results/7.json", spillHint: true });
    expect(out.text).toContain("/data/tool-results/7.json");
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
    const body = keptBody(out.text);
    expect([...body].every((ch) => ch === "🍵")).toBe(true);
  });

  it("honours a caller's budget and a floor below it", () => {
    const text = JSON.stringify({ products: Array.from({ length: 200 }, (_, i) => product(i)) });
    expect(trimResultText({ text, budget: 20_000 }).text.length).toBeLessThan(20_000);
    const tiny = trimResultText({ text, budget: 1 });
    expect(tiny.trimmed).toBe(true);
    expect(tiny.text.length).toBeLessThanOrEqual(512);
  });

  it("keeps the whole result, banners included, within a small budget", () => {
    const text = JSON.stringify({ products: Array.from({ length: 200 }, (_, i) => product(i)) });
    for (const budget of [512, 700, 1_000, 1_500]) {
      for (const input of [{ text }, { text: "z".repeat(50_000) }, { text, spillPath: "/tmp/omb-results/a-long-thread-name/search_products-1.json", spillHint: true }]) {
        const out = trimResultText({ ...input, budget });
        expect(out.text.length).toBeLessThanOrEqual(budget);
        expect(out.text.startsWith(BANNER)).toBe(true);
        expect(out.text.endsWith("NOT shown. Narrow the call or page.") || out.text.includes("never assume you saw everything")).toBe(true);
      }
    }
    // full banners while they leave the body at least half the budget
    expect(trimResultText({ text: "z".repeat(50_000), budget: 4_000 }).text).toContain("never assume you saw everything");
  });

  it("says it is incomplete at the very start and again at the end", () => {
    // measured: a 110-layer composition cut to 5 layers with only a quiet note
    // at the end, and the bot reported it had checked every layer
    const layers = Array.from({ length: 110 }, (_, i) => ({ id: `#${i + 1}`, name: `Layer ${i + 1}`, props: "p".repeat(500) }));
    const text = JSON.stringify({ comp: "Main", layers });
    const out = trimResultText({ text });
    const kept = JSON.parse(keptBody(out.text));
    const banner = `${BANNER} kept layers ${kept.layers.length} of 110 (${JSON.stringify(kept).length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} chars). The rest was NOT shown. If the tool supports paging (offset/limit/page) or a narrower query or filter, call it again for the remaining items; never assume you saw everything.`;
    expect(out.text.startsWith(`${banner}\n\n`)).toBe(true);
    expect(out.text.endsWith(`\n\n${banner}`)).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(DEFAULT_RESULT_BUDGET);
    expect(out.value).toEqual(kept);
  });

  it("starts a mid-text cut with the banner too", () => {
    const out = trimResultText({ text: "y".repeat(50_000) });
    expect(out.text.startsWith(`${BANNER} kept the first `)).toBe(true);
    expect(out.text).toContain("of 50,000 chars");
    expect(out.text.endsWith("never assume you saw everything.")).toBe(true);
    expect(out.value).toBeUndefined();
  });

  it("stays within budgets well above the default", () => {
    const layers = Array.from({ length: 110 }, (_, i) => ({ id: `#${i + 1}`, props: "p".repeat(500) }));
    const text = JSON.stringify({ layers });
    const out = trimResultText({ text, budget: 40_000 });
    expect(out.text.length).toBeLessThanOrEqual(40_000);
    expect(JSON.parse(keptBody(out.text)).layers.length).toBeGreaterThan(60);
  });

  it("survives a result whose text is empty or tiny", () => {
    expect(trimResultText({ text: "" }).trimmed).toBe(false);
    expect(trimResultText({ text: "ok" }).text).toBe("ok");
  });
});

describe("trimResultText with a held result", () => {
  it("points the model at query_result for the rest instead of at a file or a narrower call", () => {
    const text = JSON.stringify({ nextOffset: "1", products: Array.from({ length: 200 }, (_, i) => product(i)) });
    const out = trimResultText({ text, spillPath: "/data/tool-results/7.json", toolName: "search_products", held: { handle: "r3", shape: "object{nextOffset, products}; products: 200 items{id, name, price, rating, description, images}" } });
    expect(out.trimmed).toBe(true);
    expect(out.text.length).toBeLessThan(DEFAULT_RESULT_BUDGET);
    expect(out.text.startsWith("⚠️ SHAPED by OpenMausBot:")).toBe(true);
    expect(out.text).toContain('query_result {"result":"r3","query":');
    expect(out.text).toContain("200 items{id, name, price");
    expect(out.text).not.toContain("/data/tool-results");
    expect(out.text).not.toContain("Narrow the call");
    // the kept records are still whole
    const kept = JSON.parse(out.text.slice(out.text.indexOf("\n\n") + 2, out.text.lastIndexOf("\n\n⚠️")));
    expect(kept.products[0]).toEqual(product(0));
  });
});
