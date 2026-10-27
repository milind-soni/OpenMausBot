import { describe, expect, it } from "vitest";

import { initialGreeting, setupRequestLine } from "./initial-greeting.ts";

describe("the line after Set me up", () => {
  it("is written in the app's language, by region, with English for any other", () => {
    expect(setupRequestLine("en")).toBe(
      "Great. Tell me what you'd like help with, in your own words, and I'll set myself up for it. For example: \"sort my inbox every morning\" or \"research our competitors every week\".",
    );
    expect(setupRequestLine("es-MX")).toMatch(/^Genial\. Cuéntame/);
    expect(setupRequestLine("pt-BR")).toMatch(/^Ótimo\. Me conte/);
    expect(setupRequestLine("fr")).toBe(setupRequestLine("en"));
    expect(setupRequestLine(undefined)).toBe(setupRequestLine("en"));
  });

  it("leaves the greeting itself as it was", () => {
    expect(initialGreeting("Ava", "en")).toBe("Hi, I'm Ava. What would you like me to do?");
  });
});
