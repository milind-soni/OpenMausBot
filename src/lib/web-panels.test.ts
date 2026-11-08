import { describe, expect, it } from "vitest";

import { findPinnedPage, isAppOrigin, MAX_WEB_PANELS, newWebPanelId, parseWebPanels, pinnedPageName, togglePinnedPage, validateWebPanel } from "./web-panels";

describe("pinned web panels", () => {
  it("accepts absolute http and https pages and trims the name", () => {
    expect(validateWebPanel({ name: "  Board ", url: "http://127.0.0.1:7841/" })).toEqual({
      ok: true, name: "Board", url: "http://127.0.0.1:7841/",
    });
    expect(validateWebPanel({ name: "CI", url: " https://ci.example.com/runs?x=1 " })).toMatchObject({ ok: true });
  });

  it.each([
    ["javascript:alert(1)"], ["data:text/html,hi"], ["file:///etc/hosts"], ["/relative"], [""],
    ["ftp://example.com"], ["https://user:secret@example.com/"], ["https://user@example.com/"],
  ])("refuses %s", (url) => {
    expect(validateWebPanel({ name: "x", url })).toEqual({ ok: false, error: "url" });
  });

  it("refuses a page on the app's own origin, which the frame would run with the app's access", () => {
    expect(validateWebPanel({ name: "Me", url: "http://127.0.0.1:5173/settings" }, "http://127.0.0.1:5173")).toEqual({ ok: false, error: "self" });
    expect(validateWebPanel({ name: "Board", url: "http://127.0.0.1:7841/" }, "http://127.0.0.1:5173")).toMatchObject({ ok: true });
    expect(isAppOrigin("not a url", "http://127.0.0.1:5173")).toBe(false);
  });

  it("needs a name of 1 to 40 characters", () => {
    expect(validateWebPanel({ name: "  ", url: "https://a.example" })).toEqual({ ok: false, error: "name" });
    expect(validateWebPanel({ name: "a".repeat(40), url: "https://a.example" })).toMatchObject({ ok: true });
    expect(validateWebPanel({ name: "a".repeat(41), url: "https://a.example" })).toEqual({ ok: false, error: "name" });
  });

  it("reads a stored list defensively: bad entries dropped, duplicates ignored, at most six", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, url: `https://p${i}.example/` }));
    expect(parseWebPanels(JSON.stringify(many))).toHaveLength(MAX_WEB_PANELS);
    const mixed = [
      { id: "a", name: "A", url: "https://a.example/" },
      { id: "a", name: "dup", url: "https://dup.example/" },
      { id: "b", name: "B", url: "javascript:alert(1)" },
      { name: "no id", url: "https://c.example/" },
      "nonsense",
    ];
    expect(parseWebPanels(JSON.stringify(mixed))).toEqual([{ id: "a", name: "A", url: "https://a.example/" }]);
    expect(parseWebPanels("{not json")).toEqual([]);
    expect(parseWebPanels(null)).toEqual([]);
    expect(parseWebPanels('{"id":"x"}')).toEqual([]);
  });

  it("gives each new panel an unused id", () => {
    expect(newWebPanelId([])).toBe("panel-1");
    expect(newWebPanelId([{ id: "panel-2", name: "A", url: "https://a.example/" }])).toBe("panel-3");
    expect(newWebPanelId([{ id: "panel-1", name: "A", url: "https://a.example/" }, { id: "panel-2", name: "B", url: "https://b.example/" }]))
      .toBe("panel-3");
  });
});

describe("a bot's chat page pinned to the sidebar", () => {
  const page = { botId: "b1", threadId: "t1", messageId: "m1" };

  it("pins a chat page under its title and unpins it again", () => {
    const pinned = togglePinnedPage([], page, "  Company   dashboard ");
    expect(pinned).toEqual([{ id: "panel-1", name: "Company dashboard", page }]);
    expect(findPinnedPage(pinned, page)).toBe(pinned[0]);
    expect(togglePinnedPage(pinned, page, "Company dashboard")).toEqual([]);
  });

  it("keeps web panels beside it and never pins onto a full list", () => {
    const web = [{ id: "panel-1", name: "CI", url: "https://ci.example/" }];
    expect(togglePinnedPage(web, page, "Sales")).toEqual([...web, { id: "panel-2", name: "Sales", page }]);
    const full = Array.from({ length: MAX_WEB_PANELS }, (_, i) => ({ id: `p${i}`, name: `P${i}`, url: `https://p${i}.example/` }));
    expect(togglePinnedPage(full, page, "Sales")).toBe(full);
  });

  it("names a page after its title, cut to 40 characters, or Page when it has none", () => {
    expect(pinnedPageName("a".repeat(60))).toHaveLength(40);
    expect(togglePinnedPage([], page, "   ")[0]?.name).toBe("Page");
  });

  it("reads a pinned chat page back from storage, and drops a broken one", () => {
    const stored = [
      { id: "a", name: "Sales", page },
      { id: "b", name: "No ref", page: { botId: "b1", threadId: "", messageId: "m1" } },
      { id: "c", name: "Bad ref", page: "t1/m1" },
      { id: "d", name: "", page },
      { id: "e", name: "Web", url: "https://e.example/" },
    ];
    expect(parseWebPanels(JSON.stringify(stored))).toEqual([
      { id: "a", name: "Sales", page },
      { id: "e", name: "Web", url: "https://e.example/" },
    ]);
  });
});
