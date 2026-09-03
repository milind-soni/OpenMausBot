import { describe, expect, it } from "vitest";

import { affectedBotNames, reachSummary } from "./BrowserExtensionsRow";

describe("reachSummary", () => {
  it("says plainly when an extension runs everywhere", () => {
    // The single most important thing for a person to see before enabling.
    for (const pattern of ["<all_urls>", "*://*/*", "https://*/*", "http://*/*"]) {
      expect(reachSummary({ hostPermissions: [pattern] })).toBe("runs on every page");
    }
  });

  it("names a single site, and counts several", () => {
    expect(reachSummary({ hostPermissions: ["https://example.com/*"] })).toBe("runs on https://example.com/*");
    expect(reachSummary({ hostPermissions: ["https://a.test/*", "https://b.test/*"] }))
      .toBe("runs on 2 site patterns");
  });

  it("reports no site access at all", () => {
    expect(reachSummary({ hostPermissions: [] })).toBe("no site access");
  });

  it("prefers the everywhere warning even when specific sites are also listed", () => {
    expect(reachSummary({ hostPermissions: ["https://example.com/*", "<all_urls>"] }))
      .toBe("runs on every page");
  });
});

describe("affectedBotNames", () => {
  it("names every visible bot, because extensions load per session", () => {
    expect(affectedBotNames([{ name: "Ada" }, { name: "Grace" }])).toEqual(["Ada", "Grace"]);
  });

  it("leaves hidden bots out of the warning", () => {
    expect(affectedBotNames([{ name: "Ada" }, { name: "Archived", hidden: true }])).toEqual(["Ada"]);
  });

  it("copes with no bots", () => {
    expect(affectedBotNames([])).toEqual([]);
  });
});
