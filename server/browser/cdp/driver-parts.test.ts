import { describe, expect, it } from "vitest";

import type { CdpSession } from "./connection.ts";
import { safeFileName } from "./downloads.ts";
import { parseNetError, staleRefError } from "./errors.ts";
import { humanChecksIn, reportableUrl } from "./health.ts";
import { headedUserAgent, identityDifferences, identityFromProbe } from "./identity.ts";
import { editingCommands, Keyboard, keyDescription, parseChord } from "./keyboard.ts";
import { parseRef, RefCounter, RefTable } from "./refs.ts";
import { pictureScale } from "./screencast.ts";
import { parseSelector } from "./selectors.ts";
import { isSensitiveInput } from "./sensitive.ts";

function recordingSession() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const session = { send: async (method: string, params: Record<string, unknown> = {}) => { sent.push({ method, params }); return {}; } } as unknown as CdpSession;
  return { session, sent };
}

describe("keyboard", () => {
  it("reads chords, aliases and the platform's ControlOrMeta", () => {
    expect(parseChord("Control+Shift+A", false)).toEqual({ modifiers: ["Control", "Shift"], key: "A" });
    expect(parseChord("ControlOrMeta+a", true)).toEqual({ modifiers: ["Meta"], key: "a" });
    expect(parseChord("ControlOrMeta+a", false)).toEqual({ modifiers: ["Control"], key: "a" });
    expect(parseChord("cmd+enter", true)).toEqual({ modifiers: ["Meta"], key: "Enter" });
    expect(parseChord("Shift++", false)).toEqual({ modifiers: ["Shift"], key: "+" });
    expect(parseChord("esc", false).key).toBe("Escape");
    expect(() => parseChord("Hyper+a", false)).toThrow(/Unknown modifier/);
    expect(() => parseChord("NoSuchKey", false)).toThrow(/Unknown key/);
  });

  it("describes keys as Puppeteer's US layout does, Shift and other modifiers included", () => {
    expect(keyDescription("KeyA", 0)).toMatchObject({ key: "a", text: "a", code: "KeyA", keyCode: 65 });
    expect(keyDescription("KeyA", 8)).toMatchObject({ key: "A", text: "A" });
    expect(keyDescription("Digit1", 8)).toMatchObject({ key: "!", text: "!" });
    expect(keyDescription("KeyA", 2)).toMatchObject({ key: "a", text: "" });
    expect(keyDescription("Enter", 0)).toMatchObject({ key: "Enter", text: "\r", keyCode: 13 });
    expect(keyDescription("NumpadEnter", 0)).toMatchObject({ location: 3 });
  });

  it("sends macOS editing shortcuts as commands, and copy and cut everywhere", () => {
    expect(editingCommands("a", 4, true)).toEqual(["selectAll"]);
    expect(editingCommands("a", 2, false)).toEqual([]);
    expect(editingCommands("c", 2, false)).toEqual(["copy"]);
    expect(editingCommands("x", 4, true)).toEqual(["cut"]);
    expect(editingCommands("z", 4 | 8, true)).toEqual(["redo"]);
    expect(editingCommands("a", 4, false)).toEqual([]);
  });

  it("types shifted characters with Shift held, and characters the layout lacks as text", async () => {
    const { session, sent } = recordingSession();
    await new Keyboard(session, { mac: false }).type("Hi é");
    expect(sent.map(({ method, params }) => method === "Input.insertText" ? `insert:${params.text}` : `${params.type}:${params.key}:${params.modifiers}`)).toEqual([
      "rawKeyDown:Shift:8",
      "keyDown:H:8",
      "keyUp:H:8",
      "keyUp:Shift:0",
      "keyDown:i:0",
      "keyUp:i:0",
      "keyDown: :0",
      "keyUp: :0",
      "insert:é",
    ]);
  });

  it("holds modifiers around a chord and lets go of them in reverse", async () => {
    const { session, sent } = recordingSession();
    await new Keyboard(session, { mac: true }).press("ControlOrMeta+Shift+z");
    expect(sent.map(({ params }) => `${params.type}:${params.key}:${params.modifiers}${params.commands ? `:${params.commands}` : ""}`)).toEqual([
      "rawKeyDown:Meta:4",
      "rawKeyDown:Shift:12",
      "rawKeyDown:Z:12:redo",
      "keyUp:Z:12",
      "keyUp:Shift:4",
      "keyUp:Meta:0",
    ]);
  });
});

describe("refs", () => {
  const session = {} as CdpSession;

  it("accepts @e12, e12 and aria-ref=e12, and nothing else", () => {
    expect(parseRef("@e12")).toBe("e12");
    expect(parseRef("e12")).toBe("e12");
    expect(parseRef(" aria-ref=e12 ")).toBe("e12");
    expect(parseRef('button[aria-ref="save"]')).toBeNull();
    expect(parseRef("css=body >> aria-ref=e1")).toBeNull();
    expect(parseRef("e")).toBeNull();
  });

  it("keeps an element's ref, never reuses a number, and never names another tab's element", () => {
    const counter = new RefCounter();
    const one = new RefTable(counter);
    const two = new RefTable(counter);
    const first = one.refFor({ frameId: "F", session, backendNodeId: 5 });
    expect(one.refFor({ frameId: "F", session, backendNodeId: 5 })).toBe(first);
    const other = two.refFor({ frameId: "G", session, backendNodeId: 5 });
    expect(other).not.toBe(first);
    expect(() => two.resolve(first)).toThrow(/stale or belongs to another tab/);
    one.invalidateAll();
    expect(() => one.resolve(first)).toThrow(/stale/);
    const again = one.refFor({ frameId: "F", session, backendNodeId: 5 });
    expect(again).not.toBe(first);
    expect(again).not.toBe(other);
  });

  it("drops only the refs of frames that navigated", () => {
    const table = new RefTable(new RefCounter());
    const main = table.refFor({ frameId: "main", session, backendNodeId: 1 });
    const child = table.refFor({ frameId: "child", session, backendNodeId: 2 });
    table.invalidateFrames(new Set(["child"]));
    expect(table.resolve(`@${main}`).backendNodeId).toBe(1);
    expect(() => table.resolve(child)).toThrow();
  });

  it("marks a stale ref so a caller can ask for a fresh snapshot", () => {
    expect(staleRefError("e3").detail).toMatchObject({ staleRef: true, ref: "e3" });
  });
});

describe("selectors", () => {
  it("reads CSS, role and text selectors", () => {
    expect(parseSelector("#go")).toEqual({ engine: "css", css: "#go" });
    expect(parseSelector("css=button.primary")).toEqual({ engine: "css", css: "button.primary" });
    expect(parseSelector('button[aria-ref="save"]')).toEqual({ engine: "css", css: 'button[aria-ref="save"]' });
    expect(parseSelector('role=button[name="Save draft"]')).toEqual({ engine: "role", role: "button", name: "Save draft", partial: false });
    expect(parseSelector("role=link[name*='docs']")).toEqual({ engine: "role", role: "link", name: "docs", partial: true });
    expect(parseSelector("role=textbox")).toEqual({ engine: "role", role: "textbox", partial: false });
    expect(parseSelector('text="Sign in"')).toEqual({ engine: "text", text: "Sign in", exact: true });
    expect(parseSelector("text=sign")).toEqual({ engine: "text", text: "sign", exact: false });
    expect(() => parseSelector("role=button[label=x]")).toThrow(/role selector/);
    expect(() => parseSelector(" ")).toThrow(/empty/);
  });
});

describe("identity", () => {
  const probe = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36",
    high: { brands: [{ brand: "Chromium", version: "153" }], fullVersionList: [{ brand: "Chromium", version: "153.0.8010.12" }], uaFullVersion: "153.0.8010.12", platform: "macOS", platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"] },
  };

  it("takes the headed user agent and the binary's own metadata, inventing nothing", () => {
    const identity = identityFromProbe(probe, "HeadlessChrome/153.0.8010.12");
    expect(identity.userAgent).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
    expect(identity.userAgentMetadata).toMatchObject({ brands: [{ brand: "Chromium", version: "153" }], fullVersion: "153.0.8010.12", architecture: "arm", platformVersion: "26.3.1" });
    expect(identity.product).toBe("Chrome/153.0.8010.12");
    expect(headedUserAgent("x Chrome/1")).toBe("x Chrome/1");
  });

  it("names the fields where two identities differ", () => {
    const a = identityFromProbe(probe, "Chrome/153");
    const b = identityFromProbe({ ...probe, high: { ...probe.high, architecture: "x86" } }, "Chrome/153");
    expect(identityDifferences(a, a)).toEqual([]);
    expect(identityDifferences(a, b)).toEqual(["userAgentMetadata.architecture"]);
  });
});

describe("small rules", () => {
  it("maps net errors as T3 Code does", () => {
    expect(parseNetError("net::ERR_NAME_NOT_RESOLVED")).toEqual({ description: "ERR_NAME_NOT_RESOLVED", code: -105 });
    expect(parseNetError("net::ERR_SOMETHING_NEW")).toEqual({ description: "ERR_SOMETHING_NEW", code: -2 });
  });

  it("keeps a download's name and nothing that could leave its folder", () => {
    expect(safeFileName("report.pdf")).toBe("report.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a<b>:c?.txt")).toBe("a_b__c_.txt");
    expect(safeFileName("..")).toBe("download");
    expect(Buffer.byteLength(safeFileName(`${"é".repeat(300)}.txt`))).toBeLessThanOrEqual(255);
  });

  it("reports addresses without their queries, and names human checks by their frames", () => {
    expect(reportableUrl("https://shop.example/api/cart?token=secret#x")).toBe("https://shop.example/api/cart");
    expect(reportableUrl("data:text/html,<p>hi")).toBe("data:…");
    expect(humanChecksIn([
      { url: "https://shop.example/", parentId: null },
      { url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0", parentId: "main" },
      { url: "https://www.google.com/recaptcha/api2/anchor?k=1", parentId: "main" },
      { url: "https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html", parentId: "main" },
    ]).map((check) => check.kind)).toEqual(["Cloudflare Turnstile", "reCAPTCHA", "hCaptcha"]);
  });

  it("draws a picture one pixel per CSS pixel up to 1280 wide, 1568 tall and 1.2 megapixels, and in hundredths below that", () => {
    expect(pictureScale({ width: 1280, height: 800 })).toBe(1);
    expect(pictureScale({ width: 390, height: 844 })).toBe(1);
    expect(pictureScale({ width: 1280, height: 937 })).toBe(1);
    expect(pictureScale({ width: 1280, height: 2400 })).toBe(0.62);
    expect(pictureScale({ width: 1280, height: 2560 })).toBe(0.6);
    expect(pictureScale({ width: 2400, height: 1300 })).toBe(0.53);
    expect(pictureScale({ width: 1280, height: 16_384 })).toBe(0.09);
    expect(pictureScale({ width: 0, height: 0 })).toBe(1);
  });

  it("treats passwords, codes and card numbers as values a snapshot never shows", () => {
    expect(isSensitiveInput("password", [])).toBe(true);
    expect(isSensitiveInput("text", ["one-time-code"])).toBe(true);
    expect(isSensitiveInput("text", [null, "cardNumber"])).toBe(true);
    expect(isSensitiveInput("text", ["", "", "", "Enter your PIN"])).toBe(true);
    expect(isSensitiveInput("email", ["email", "username"])).toBe(false);
  });
});
