import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PRODUCT_NAME } from "./brand";

// The packaged Linux smoke reads document.title once the page has loaded, before /api/brand has answered, and a person
// sees the same name in the window title at that moment: the product's name is set before anything is fetched.
describe("the window's name at boot", () => {
  it("is the product's name before the brand file is asked for", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const title = main.indexOf("document.title = productName();");
    const fetch = main.indexOf("bootstrapBrand()");
    expect(title).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(title);
    expect(PRODUCT_NAME).toBe("MausBot");
  });
});
