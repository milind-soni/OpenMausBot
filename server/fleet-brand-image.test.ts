import { describe, expect, it } from "vitest";

import { MAX_FAVICON_CHARS, MAX_LOGO_CHARS } from "./brand-schema.ts";
import { checkImageDataUri, imageDataUri, inspectImage, maxRawBytes, sniffImage } from "./fleet-brand-image.ts";
import { dataUri, GIF, HTML_NAMED_PNG, ICO, JPEG, PNG, SVG, WEBP } from "./testing/fleet-brand-fixtures.ts";

const svg = (body: string) => Uint8Array.from(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`));

describe("brand images are recognised by their bytes", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
    ["svg", SVG, "image/svg+xml"],
  ] as const)("accepts a %s logo and names its type itself", (format, bytes, mime) => {
    expect(sniffImage(bytes)).toBe(format);
    expect(imageDataUri(bytes, "logo", "logo.dat")).toBe(dataUri(mime, bytes));
    expect(imageDataUri(bytes, "favicon", "icon.dat")).toBe(dataUri(mime, bytes));
  });

  it("takes an ICO for the favicon only", () => {
    expect(sniffImage(ICO)).toBe("ico");
    expect(imageDataUri(ICO, "favicon", "icon.ico")).toBe(dataUri("image/x-icon", ICO));
    expect(() => imageDataUri(ICO, "logo", "logo.ico")).toThrow("ICO file");
  });

  it("accepts an SVG with an XML prolog, a byte-order mark, comments and an svg doctype", () => {
    const text = '﻿<?xml version="1.0"?>\n<!-- made in a tool -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg viewBox="0 0 1 1"/>';
    expect(sniffImage(Uint8Array.from(Buffer.from(text)))).toBe("svg");
  });

  it("refuses HTML named like a picture, text, an empty file and a truncated signature", () => {
    expect(() => imageDataUri(HTML_NAMED_PNG, "logo", "logo.png")).toThrow("logo.png is not a PNG, JPEG, WebP, GIF or SVG image");
    expect(() => imageDataUri(Uint8Array.from(Buffer.from("just words")), "logo", "notes.png")).toThrow("not a PNG");
    expect(() => imageDataUri(new Uint8Array(), "logo", "empty.png")).toThrow("is empty");
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffImage(Uint8Array.from(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1")))).toBeNull();
    expect(sniffImage(Uint8Array.from([0, 0, 1, 0, 0, 0]))).toBeNull();
  });
});

describe("brand image size", () => {
  it("keeps the data URI inside the schema limit for each field and type", () => {
    for (const [kind, limit] of [["logo", MAX_LOGO_CHARS], ["favicon", MAX_FAVICON_CHARS]] as const) {
      const room = maxRawBytes(kind, "png");
      const exact = Uint8Array.from([...PNG, ...new Uint8Array(room - PNG.length)]);
      const uri = imageDataUri(exact, kind, "edge.png");
      expect(uri.length).toBeLessThanOrEqual(limit);
      expect(limit - uri.length).toBeLessThan(4 + 3);
      const over = Uint8Array.from([...exact, 0]);
      expect(() => imageDataUri(over, kind, "edge.png")).toThrow(new RegExp(`the ${kind} must be at most`));
    }
  });

  it("measures the limit per type, because the data URI prefix differs", () => {
    expect(maxRawBytes("logo", "svg")).toBeLessThan(maxRawBytes("logo", "png"));
    expect(maxRawBytes("favicon", "png")).toBeLessThan(maxRawBytes("logo", "png"));
  });

  it("refuses a large svg before decoding it as text", () => {
    const huge = svg("x".repeat(maxRawBytes("logo", "svg")));
    expect(() => inspectImage(huge, "logo", "big.svg")).toThrow("must be at most");
  });
});

describe("hostile SVG", () => {
  it.each([
    ["a script element", '<script>alert(1)</script>', "<script"],
    ["a spaced script element", "<  SCRIPT >alert(1)</script>", "<script"],
    ["an onload attribute", '<rect onload="alert(1)"/>', "event attribute"],
    ["an onclick attribute in single quotes", "<g\nonclick = 'x()'/>", "event attribute"],
    ["a foreignObject", '<foreignObject><div/></foreignObject>', "<foreignObject"],
    ["a javascript link", '<a href="javascript:alert(1)"><rect/></a>', "javascript: link"],
    ["a javascript link split by whitespace", '<a href="java\nscript:alert(1)"><rect/></a>', "javascript: link"],
    ["a javascript link spelled with character references", '<a href="&#106;avascript&#58;alert(1)"><rect/></a>', "javascript: link"],
    ["an embedded iframe", "<iframe src='x'/>", "embedded document"],
  ])("refuses %s", (_name, body, reason) => {
    expect(() => imageDataUri(svg(body), "logo", "evil.svg")).toThrow(reason);
    expect(() => imageDataUri(svg(body), "favicon", "evil.svg")).toThrow(reason);
  });

  it.each([
    ["a namespaced script element", '<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>', "<script"],
    ["an upper-case namespaced script element", "<SVG:SCRIPT>alert(1)</SVG:SCRIPT>", "<script"],
    ["a script element spaced around its prefix", "< s : script >alert(1)</s:script>", "<script"],
    ["an SVG Tiny handler element", '<handler type="application/ecmascript">alert(1)</handler>', "<script"],
    ["a namespaced foreignObject", '<h:foreignObject xmlns:h="http://www.w3.org/2000/svg"><div/></h:foreignObject>', "<foreignObject"],
    ["a namespaced iframe", "<x:iframe src='x'/>", "embedded document"],
    ["a namespaced event attribute", '<rect x:onload="alert(1)"/>', "event attribute"],
    ["a data: link", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="><rect/></a>', "outside reference"],
    ["a remote image", '<image href="https://evil.test/track.png"/>', "outside reference"],
    ["a remote image by xlink:href", '<image xlink:href="https://evil.test/track.png"/>', "outside reference"],
    ["a remote image spelled with character references", '<image href="&#104;ttps://evil.test/track.png"/>', "outside reference"],
    ["a protocol-relative feImage", '<filter id="f"><feImage href="//evil.test/x.png"/></filter>', "outside reference"],
    ["a use of another file", '<use href="sprite.svg#icon"/>', "outside reference"],
    ["a remote href hidden behind an attribute holding '>'", '<image title=">" href="https://evil.test/track.png"/>', "outside reference"],
    ["an empty href", '<image href=""/>', "outside reference"],
    ["a fragment followed by more", '<use href="#a https://evil.test/x"/>', "outside reference"],
    ["an xml-stylesheet instruction", '<?xml-stylesheet href="https://evil.test/x.css"?>', "outside reference"],
    ["an xml:base", '<g xml:base="https://evil.test/"><use href="#a"/></g>', "outside reference"],
    ["an animation that sets an href", '<image href="#a"><set attributeName="href" to="https://evil.test/t.png"/></image>', "outside reference"],
    ["a data: value in another attribute", '<animate attributeName="fill" values="data:text/html,x"/>', "data: address"],
    ["an entity declaration in a DOCTYPE", '<!DOCTYPE svg [<!ENTITY x "y">]>', "entity declaration"],
    ["a DOCTYPE", '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">', "DOCTYPE"],
    ["a CSS @import", "<style>@import url(https://evil.test/x.css);</style>", "@import"],
    ["a CSS @import with an escape", '<style>@\\69mport "https://evil.test/x.css";</style>', "@import"],
    ["a CSS url() to another server", '<rect style="fill:url(https://evil.test/p.svg#p)"/>', "CSS url()"],
    ["a CSS url() with an escaped name", "<style>rect{fill:u\\72l(https://evil.test/p.svg#p)}</style>", "CSS url()"],
    ["a presentation url() to another file", '<rect filter="url(other.svg#f)"/>', "CSS url()"],
    ["a CSS image-set", '<style>rect{mask-image:image-set("https://evil.test/m.png" 1x)}</style>', "CSS url()"],
  ])("refuses %s", (_name, body, reason) => {
    expect(() => imageDataUri(svg(body), "logo", "evil.svg")).toThrow(reason);
    expect(() => checkImageDataUri(dataUri("image/svg+xml", svg(body)), "favicon", "favicon")).toThrow(reason);
  });

  it("accepts a plain logo with paths, gradients, a clip path, a style sheet and same-document references", () => {
    const logo = Uint8Array.from(Buffer.from([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" width="64" height="64">',
      "  <defs>",
      '    <linearGradient id="paint0_linear" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">',
      '      <stop offset="0" stop-color="#C2510A"/><stop offset="1" stop-color="#F59E0B" stop-opacity="0.8"/>',
      "    </linearGradient>",
      '    <linearGradient id="SVGID_1_" xlink:href="#paint0_linear" gradientTransform="rotate(90)"/>',
      '    <clipPath id="clip0"><rect width="64" height="64" rx="12"/></clipPath>',
      "    <style>.mark { fill: url(#SVGID_1_); stroke: url( '#paint0_linear' ); }</style>",
      "  </defs>",
      '  <g clip-path="url(#clip0)">',
      '    <path class="mark" d="M8 8h48v48H8z"/>',
      '    <circle id="dot" cx="32" cy="32" r="6" fill="url(&quot;#paint0_linear&quot;)"/>',
      '    <use href=" #dot " x="4"/><use xlink:href="#dot" y="4"/><a href="#dot"><rect width="1" height="1"/></a>',
      "  </g>",
      '  <text x="4" y="60" font-family="Sans" opacity="1">Big data: on and on</text>',
      "</svg>",
    ].join("\n")));
    expect(sniffImage(logo)).toBe("svg");
    expect(imageDataUri(logo, "logo", "logo.svg")).toBe(dataUri("image/svg+xml", logo));
    expect(() => checkImageDataUri(dataUri("image/svg+xml", logo), "favicon", "favicon")).not.toThrow();
  });

  it("does not refuse the word 'on' or a harmless attribute that merely starts with it", () => {
    expect(() => imageDataUri(svg('<text x="1" y="2">on and on</text><rect opacity="1" font-family="Sans"/>'), "logo", "ok.svg")).not.toThrow();
  });

  it("never prints the file's content in the refusal", () => {
    expect(() => imageDataUri(svg("<script>SECRET-PAYLOAD</script>"), "logo", "evil.svg")).toThrow(/^(?!.*SECRET-PAYLOAD)/);
  });
});

describe("a data URI someone else wrote", () => {
  it("passes when it is base64, of an allowed type, and is what it says", () => {
    expect(() => checkImageDataUri(dataUri("image/png", PNG), "logo", "logo")).not.toThrow();
    expect(() => checkImageDataUri(dataUri("image/svg+xml", SVG), "favicon", "favicon")).not.toThrow();
    expect(() => checkImageDataUri(dataUri("image/vnd.microsoft.icon", ICO), "favicon", "favicon")).not.toThrow();
  });

  it("is refused when it lies about its type, hides HTML, is not base64, or is hostile", () => {
    expect(() => checkImageDataUri(dataUri("image/png", JPEG), "logo", "logo")).toThrow("says image/png but its content is image/jpeg");
    expect(() => checkImageDataUri(dataUri("image/png", HTML_NAMED_PNG), "logo", "logo")).toThrow("not a PNG");
    expect(() => checkImageDataUri("data:image/svg+xml,<svg/>", "logo", "logo")).toThrow("base64 data:image/");
    expect(() => checkImageDataUri("data:text/html;base64,PGh0bWw+", "logo", "logo")).toThrow("base64 data:image/");
    expect(() => checkImageDataUri(dataUri("image/svg+xml", svg("<script/>")), "logo", "logo")).toThrow("<script");
    expect(() => checkImageDataUri(dataUri("image/x-icon", ICO), "logo", "logo")).toThrow("ICO");
  });
});
