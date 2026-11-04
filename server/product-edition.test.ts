import { describe, expect, it } from "vitest";
import { isFullEdition, isLocalEdition, productEdition } from "./product-edition.ts";

describe("productEdition", () => {
  it("defaults to local", () => {
    expect(productEdition({})).toBe("local");
    expect(isLocalEdition({})).toBe(true);
    expect(isFullEdition({})).toBe(false);
  });

  it("honours MUSTERD_EDITION and OMB_EDITION", () => {
    expect(productEdition({ MUSTERD_EDITION: "full" })).toBe("full");
    expect(productEdition({ OMB_EDITION: "full" })).toBe("full");
    expect(productEdition({ MUSTERD_EDITION: "LOCAL" })).toBe("local");
  });
});
