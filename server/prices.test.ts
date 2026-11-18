import { describe, expect, it } from "vitest";

import { billableFor, priceFor } from "./prices.ts";

const driverPrice = { inputPerMillion: 1, outputPerMillion: 2 };
const modelPrice = { inputPerMillion: 3, outputPerMillion: 4 };
const defaultPrice = { inputPerMillion: 5, outputPerMillion: 6 };

describe("priceFor", () => {
  it("keeps the driver/model -> model -> default precedence", () => {
    const prices = { "openai/gpt": driverPrice, gpt: modelPrice, default: defaultPrice };
    expect(priceFor({ driverKind: "openai", model: "gpt" }, prices)).toEqual(driverPrice);
    expect(priceFor({ driverKind: "else", model: "gpt" }, prices)).toEqual(modelPrice);
    expect(priceFor({ driverKind: "else", model: "unknown" }, prices)).toEqual(defaultPrice);
    expect(priceFor({ driverKind: "else", model: "unknown" }, {})).toBeNull();
  });

  it("never returns an Object.prototype member as a price", () => {
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(priceFor({ driverKind: "openai", model: key }, {})).toBeNull();
    }
  });

  it("billing stays null instead of producing NaN for a prototype key", () => {
    expect(billableFor({ driverKind: "openai", model: "toString", input: 100, output: 10 }, {})).toBeNull();
  });
});
