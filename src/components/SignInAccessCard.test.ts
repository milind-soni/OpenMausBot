import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeAccessEntry, SignInAccessCard, withEntry, withoutEntry } from "./SignInAccessCard";

describe("who may sign in with an emailed code", () => {
  it("accepts an address or an @domain and nothing else", () => {
    expect(normalizeAccessEntry(" Her@Example.com ")).toBe("her@example.com");
    expect(normalizeAccessEntry("@Agentada.cc")).toBe("@agentada.cc");
    expect(normalizeAccessEntry("nope")).toBeNull();
    expect(normalizeAccessEntry("@nodot")).toBeNull();
    expect(normalizeAccessEntry("two words@x.com")).toBeNull();
    expect(normalizeAccessEntry("")).toBeNull();
  });

  it("moves an entry between the lists instead of duplicating it, and removes from both", () => {
    const start = { admins: ["a@x.com"], members: ["b@x.com"] };
    expect(withEntry(start, "b@x.com", "admin")).toEqual({ admins: ["a@x.com", "b@x.com"], members: [] });
    expect(withEntry(start, "a@x.com", "member")).toEqual({ admins: [], members: ["b@x.com", "a@x.com"] });
    expect(withEntry(start, "@y.com", "member")).toEqual({ admins: ["a@x.com"], members: ["b@x.com", "@y.com"] });
    expect(withoutEntry(start, "a@x.com")).toEqual({ admins: [], members: ["b@x.com"] });
  });

  it("renders nothing until it knows who is asking", () => {
    expect(renderToStaticMarkup(createElement(SignInAccessCard))).toBe("");
  });
});
