import { describe, expect, it } from "vitest";

import { APP_LIMITS, appBlockedText, htmlFallbackText, htmlVisibleText, mcpAppFallbackText, parseShowHtmlInput, parseUpdateHtmlInput, utf8Bytes, wrapHtmlFragment } from "./app.ts";

describe("parseShowHtmlInput", () => {
  it("keeps a whole document as written, trimmed", () => {
    const html = "<!DOCTYPE html><html><body><p>Hi</p></body></html>";
    expect(parseShowHtmlInput({ html: `  ${html}\n`, title: "Greeting" })).toEqual({ ok: true, value: { html, title: "Greeting" } });
  });

  it("wraps a fragment, and sees <html or <body in any case", () => {
    expect(parseShowHtmlInput({ html: "<div>x</div>", title: "t" })).toMatchObject({
      ok: true, value: { html: "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><div>x</div></body></html>" },
    });
    expect(wrapHtmlFragment("<BODY onload=x>y</BODY>")).toBe("<BODY onload=x>y</BODY>");
    expect(wrapHtmlFragment("<Html lang=en>y")).toBe("<Html lang=en>y");
    expect(wrapHtmlFragment("<bodyguard>y</bodyguard>")).toContain("<body><bodyguard>");
  });

  it("refuses an empty or oversized page, counted in UTF-8 bytes", () => {
    expect(parseShowHtmlInput({ html: "   ", title: "t" })).toMatchObject({ ok: false, error: expect.stringMatching(/^html: is empty/) });
    expect(parseShowHtmlInput({ html: 7, title: "t" })).toMatchObject({ ok: false, error: expect.stringMatching(/^html:/) });
    expect(parseShowHtmlInput({ html: "a".repeat(APP_LIMITS.htmlBytes), title: "t" }).ok).toBe(true);
    expect(parseShowHtmlInput({ html: "a".repeat(APP_LIMITS.htmlBytes + 1), title: "t" })).toMatchObject({ ok: false, error: expect.stringContaining("over the 262144-byte limit") });
    expect(parseShowHtmlInput({ html: "é".repeat(APP_LIMITS.htmlBytes / 2 + 1), title: "t" }).ok).toBe(false);
  });

  it("puts the title on one line, 1 to 80 characters", () => {
    expect(parseShowHtmlInput({ html: "x", title: " Sales\n\tby  month " })).toMatchObject({ ok: true, value: { title: "Sales by month" } });
    expect(parseShowHtmlInput({ html: "x", title: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/^title:/) });
    expect(parseShowHtmlInput({ html: "x", title: "t".repeat(81) })).toMatchObject({ ok: false, error: expect.stringMatching(/^title:/) });
    expect(parseShowHtmlInput({ html: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/^title:/) });
  });

  it("clamps the height to 80..720 and checks the fallback", () => {
    expect(parseShowHtmlInput({ html: "x", title: "t", height: 20 })).toMatchObject({ ok: true, value: { height: 80 } });
    expect(parseShowHtmlInput({ html: "x", title: "t", height: 5000 })).toMatchObject({ ok: true, value: { height: 720 } });
    expect(parseShowHtmlInput({ html: "x", title: "t", height: 300.6 })).toMatchObject({ ok: true, value: { height: 301 } });
    expect(parseShowHtmlInput({ html: "x", title: "t", height: "tall" })).toMatchObject({ ok: false, error: expect.stringMatching(/^height:/) });
    expect(parseShowHtmlInput({ html: "x", title: "t", fallback_text: "f".repeat(1_501) })).toMatchObject({ ok: false, error: expect.stringMatching(/^fallback_text:/) });
    expect(parseShowHtmlInput({ html: "x", title: "t", fallback_text: "  Plain  " })).toMatchObject({ ok: true, value: { fallbackText: "Plain" } });
    expect(parseShowHtmlInput({ html: "x", title: "t", fallback_text: null, height: null })).toEqual({ ok: true, value: expect.not.objectContaining({ height: expect.anything() }) });
    expect(parseShowHtmlInput("nope").ok).toBe(false);
  });
});

describe("parseUpdateHtmlInput", () => {
  it("needs the id show_html returned and a page; the title is optional", () => {
    expect(parseUpdateHtmlInput({ app_id: "m_1", html: "<p>x</p>" })).toMatchObject({ ok: true, value: { appId: "m_1", html: expect.stringContaining("<body><p>x</p>") } });
    expect(parseUpdateHtmlInput({ app_id: "m_1", html: "x", title: "New" })).toMatchObject({ ok: true, value: { title: "New" } });
    expect(parseUpdateHtmlInput({ html: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/^app_id:/) });
    expect(parseUpdateHtmlInput({ app_id: "../etc", html: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/^app_id:/) });
    expect(parseUpdateHtmlInput({ app_id: "m_1", html: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/^html:/) });
  });
});

describe("fallback text", () => {
  it("is the bot's fallback_text when given", () => {
    expect(htmlFallbackText("Chart", "<p>ignored</p>", "Revenue rose 12%")).toBe("Revenue rose 12%");
  });

  it("is [App] <title> and up to 600 characters of what a person would read", () => {
    const html = "<html><head><title>T</title><style>p{color:red}</style><script>var secret = 1;</script></head>" +
      "<body><!-- note --><h1>Revenue</h1><p>Up&nbsp;12% &amp; rising &lt;fast&gt; &#8364;5 &#x1F600;</p></body></html>";
    expect(htmlFallbackText("Sales", html)).toBe("[App] Sales\nRevenue Up 12% & rising <fast> €5 😀");
    const long = htmlFallbackText("Long", `<p>${"word ".repeat(400)}</p>`);
    expect(long.split("\n")[1]!.length).toBeLessThanOrEqual(APP_LIMITS.fallbackExcerpt);
    expect(long.endsWith("…")).toBe(true);
    expect(htmlFallbackText("Blank", "<script>x()</script>")).toBe("[App] Blank");
    expect(htmlVisibleText("<p>a</p><script>never closed")).toBe("a");
  });

  it("reads an MCP row as <server> · <tool> and the result's text", () => {
    expect(mcpAppFallbackText("Excalidraw", "Create view", { content: [{ type: "text", text: "Diagram\nready" }, { type: "image", data: "x" }] }))
      .toBe("Excalidraw · Create view\nDiagram ready");
    expect(mcpAppFallbackText("Debug", "debug-tool", undefined)).toBe("Debug · debug-tool");
  });

  it("names why a frame's server calls are off", () => {
    expect(appBlockedText("signed-out", "Asana")).toBe("Sign in to Asana again");
    expect(appBlockedText("server-removed", "Debug")).toBe("Debug is no longer connected");
    expect(appBlockedText("too-large")).toBe("This app is too large to store");
  });
});

describe("utf8Bytes", () => {
  it("counts like the encoder does", () => {
    for (const text of ["", "abc", "é", "€", "😀", "a😀é€", "\ud800 lone"]) expect(utf8Bytes(text), text).toBe(new TextEncoder().encode(text).length);
  });
});
