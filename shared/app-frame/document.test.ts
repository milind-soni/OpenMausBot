import { describe, expect, it } from "vitest";

import { BOT_HTML_CSP, mcpAppCsp } from "./csp.ts";
import { botHtmlDocument, buildSrcdoc, CSP_META_PREFIX, mcpAppDocument, stripDocumentPreamble } from "./document.ts";
import { APP_HELPER_SOURCE, APP_THEME_STYLE } from "./helper.ts";
import { APP_POINT_SOURCE } from "./point.ts";

const CSP = "default-src 'none'";
const head = `${CSP_META_PREFIX}default-src 'none'">`;

describe("buildSrcdoc", () => {
  it("puts the meta first and the content after it", () => {
    expect(CSP_META_PREFIX).toBe('<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="');
    expect(buildSrcdoc({ html: "<p>hi</p>", csp: CSP })).toBe(`${head}<p>hi</p>`);
  });

  it.each([
    ["a BOM", "﻿<html><body>x</body></html>", "<html><body>x</body></html>"],
    ["whitespace and a BOM after it", " \n﻿\t<p>x</p>", "<p>x</p>"],
    ["a leading script", "<script>alert(1)</script><p>x</p>", "<script>alert(1)</script><p>x</p>"],
    ["its own doctype", "<!DOCTYPE html><html><head></head><body>x</body></html>", "<html><head></head><body>x</body></html>"],
    ["an uppercase legacy doctype", "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\">\n<HTML><BODY>x</BODY></HTML>", "<HTML><BODY>x</BODY></HTML>"],
    ["comments around the doctype", "<!-- a --><!--b--> <!doctype html><!-- c --><html>x</html>", "<html>x</html>"],
    ["a comment that hides a tag", "<!-- <meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"> --><p>x</p>", "<p>x</p>"],
    ["an xml declaration", "<?xml version=\"1.0\"?><html>x</html>", "<html>x</html>"],
    ["a fragment", "Hello <b>there</b>", "Hello <b>there</b>"],
    ["an unterminated comment", "<!-- never closed <p>x</p>", ""],
  ])("with %s: meta first, nothing of the app before it", (_name, html, after) => {
    const srcdoc = buildSrcdoc({ html, csp: CSP });
    expect(srcdoc.startsWith(head)).toBe(true);
    expect(srcdoc.slice(head.length)).toBe(after);
    expect(srcdoc.indexOf("<meta")).toBe("<!DOCTYPE html>".length);
  });

  it("escapes the policy into the attribute so it cannot close it", () => {
    const srcdoc = buildSrcdoc({ html: "x", csp: "default-src 'none'\"><script>alert(1)</script>" });
    expect(srcdoc).toBe(`${CSP_META_PREFIX}default-src 'none'&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x`);
  });

  it("puts the theme style and the helper after the meta, before the content, only for bot HTML", () => {
    const bot = buildSrcdoc({ html: "<p>x</p>", csp: CSP, botHelper: true });
    expect(bot).toBe(`${head}<style>${APP_THEME_STYLE}</style><script>${APP_HELPER_SOURCE}</script><script>${APP_POINT_SOURCE}</script><p>x</p>`);
    expect(buildSrcdoc({ html: "<p>x</p>", csp: CSP })).not.toContain("mausbot");
  });

  it("keeps the helper free of anything that would end its script element", () => {
    expect(APP_HELPER_SOURCE).not.toMatch(/<\/script/i);
    expect(APP_POINT_SOURCE).not.toMatch(/<\/script|<!--/i);
    expect(APP_THEME_STYLE).not.toMatch(/<\/style/i);
  });

  it("strips the preamble repeatedly and leaves content alone", () => {
    expect(stripDocumentPreamble("<!doctype html><!doctype html><p><!-- kept --></p>")).toBe("<p><!-- kept --></p>");
    expect(stripDocumentPreamble("<p>x</p><!doctype html>")).toBe("<p>x</p><!doctype html>");
  });
});

describe("documents", () => {
  it("a bot page carries exactly the bot policy, its network set and no server calls", () => {
    const doc = botHtmlDocument({ messageId: "m1", rev: 2, html: "<!DOCTYPE html><html><body>hi</body></html>" });
    expect(doc).toMatchObject({ v: 1, messageId: "m1", rev: 2, csp: BOT_HTML_CSP });
    expect(doc.srcdoc.startsWith(`${CSP_META_PREFIX}${BOT_HTML_CSP}">`)).toBe(true);
    expect(doc.can).toEqual({ serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true });
    expect(doc.tool).toBeUndefined();
  });

  it("an MCP app carries the construction from its filtered network set", () => {
    const network = { connect: ["https://esm.sh"], resources: ["https://esm.sh"] };
    const doc = mcpAppDocument({
      messageId: "m2", rev: 0, html: "<html><body>app</body></html>", network,
      tool: { name: "create_view" }, toolInput: { a: 1 }, toolResult: { content: [{ type: "text", text: "ok" }] },
      can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true },
    });
    expect(doc.csp).toBe(mcpAppCsp(network));
    expect(doc.srcdoc).toBe(`${CSP_META_PREFIX}${mcpAppCsp(network)}"><html><body>app</body></html>`);
    expect(doc).toMatchObject({ tool: { name: "create_view" }, toolInput: { a: 1 }, network });
  });
});
