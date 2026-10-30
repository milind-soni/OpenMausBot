import { describe, expect, it } from "vitest";

import { isAppOrigin, MAX_WEB_PANELS, newWebPanelId, parseWebPanels, validateWebPanel } from "./web-panels";

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
