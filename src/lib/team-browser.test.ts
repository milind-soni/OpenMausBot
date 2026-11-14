import { describe, expect, it } from "vitest";

import { browserScope, withBrowserScope } from "./team-browser";

describe("which browser a view of a bot names", () => {
  it("names the conversation shown on a Team Cloud, and nothing elsewhere", () => {
    expect(browserScope({ id: "team-acme-1", name: "Acme" }, "ada-chat")).toEqual({ threadId: "ada-chat" });
    expect(browserScope(undefined, "ada-chat")).toEqual({});
    expect(browserScope({ id: "team-acme-1", name: "Acme" }, undefined)).toEqual({});
  });

  it("adds it to a view's address, leaving an address unchanged when there is nothing to add", () => {
    expect(withBrowserScope("/api/bots/scout/browser/action", {})).toBe("/api/bots/scout/browser/action");
    expect(withBrowserScope("/api/bots/scout/browser/action", { threadId: "ada-chat" })).toBe("/api/bots/scout/browser/action?threadId=ada-chat");
    expect(withBrowserScope("?resume=v1", { threadId: "ada-chat" })).toBe("?resume=v1&threadId=ada-chat");
  });
});
