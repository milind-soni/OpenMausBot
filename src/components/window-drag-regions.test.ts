import { readFileSync } from "node:fs";
import { createElement, type CSSProperties, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Group } from "@/state/store";

type Chrome = "mac-inset" | "win-caption" | "native";
const PLATFORM: Record<Chrome, string> = { "mac-inset": "darwin", "win-caption": "win32", native: "linux" };
const fixture = { chrome: "native" as Chrome };

vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));

const { ChatView } = await import("./ChatView");
const { GroupView } = await import("./GroupView");
const { DesktopCapabilitiesProvider, WindowDragStrip, captionChrome, windowFramed } = await import("./DesktopCapabilities");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const noDragRule = /\/\* Window drag regions\.[\s\S]*?\*\/\s*([^{]+)\{\s*-webkit-app-region: no-drag;/.exec(css);
const noDragSelector = noDragRule![1].trim();

const CONTROLS = "button, a[href], input, select, textarea, [role=button], [role=menuitem], [tabindex]:not([tabindex='-1'])";

const bot: Bot = {
  id: "bot", threadId: "thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "default" },
};
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [],
  defaultResponder: { kind: "member", botId: "atlas" }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [],
};

const dom = (element: ReactElement) => {
  vi.stubGlobal("window", { ...globalThis.window, ogb: { platform: PLATFORM[fixture.chrome] } });
  const markup = renderToStaticMarkup(createElement(DesktopCapabilitiesProvider, null, createElement(StoreProvider, null, element)));
  const window = new Window();
  window.document.body.innerHTML = markup;
  return window.document;
};
type DomNode = { getAttribute(name: string): string | null; parentElement: DomNode | null; matches(selector: string): boolean };
// Read off the style attribute: happy-dom's CSSStyleDeclaration drops the Electron-only property.
const styleValue = (element: DomNode | null, property: string) =>
  new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(element?.getAttribute("style") ?? "")?.[1].trim() ?? "";
const region = (element: DomNode | null) => styleValue(element, "-webkit-app-region");
const cutOut = (control: DomNode, header: DomNode) => {
  for (let node: DomNode | null = control; node && node !== header; node = node.parentElement) {
    if (region(node) === "no-drag") return true;
  }
  return control.matches(noDragSelector);
};

beforeEach(() => {
  vi.stubGlobal("window", { ogb: undefined, location: { protocol: "http:", search: "" }, innerWidth: 1280 });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("caption chrome", () => {
  it.each<[Chrome, boolean]>([["mac-inset", true], ["win-caption", true], ["native", false]])(
    "%s headers drag: %s",
    (chrome, drags) => {
      const value = captionChrome(chrome);
      expect(value.draggable).toBe(drags);
      expect(value.dragProps["data-window-drag"] === "").toBe(drags);
      const appRegion = (style: CSSProperties | undefined) => (style as Record<string, unknown> | undefined)?.WebkitAppRegion;
      expect(appRegion(value.dragProps.style)).toBe(drags ? "drag" : undefined);
      expect(appRegion(value.noDragStyle)).toBe(drags ? "no-drag" : undefined);
    },
  );

  it("frames the window on macOS and Windows: nothing under the frame's top bar moves out of the window's buttons", () => {
    expect([windowFramed({ windowChrome: "mac-inset" }), windowFramed({ windowChrome: "win-caption" }), windowFramed({ windowChrome: "native" }), windowFramed(undefined)])
      .toEqual([true, true, false, false]);
    expect(windowFramed({ windowChrome: "mac-inset", windowFrame: false }), "the person turned it off").toBe(false);
    expect(captionChrome("mac-inset").draggable, "the headers still drag a window with no title bar of its own").toBe(true);
    for (const chrome of ["mac-inset", "win-caption", "native"] as const) {
      expect(Object.keys(captionChrome(chrome))).not.toContain("padClass");
      expect(Object.keys(captionChrome(chrome))).not.toContain("controlsShiftStyle");
    }
  });

  it("opts controls, menus and dialogs out of a drag region in styles.css", () => {
    const document = new Window().document;
    document.body.innerHTML = `<div data-window-drag><button></button><input><a href="#"></a><span role="button"></span><span></span><div class="field"><select></select><svg></svg></div></div><div role="menu"></div><div class="fixed backdrop"><div role="dialog"></div></div><div class="fixed overlay"><p></p></div><div data-browser-transport="stream"></div>`;
    const matches = [...document.querySelectorAll("button, input, a, span, .field, [role], .backdrop, .overlay, [data-browser-transport]")].map((element) => element.matches(noDragSelector));
    expect(matches).toEqual([true, true, true, true, false, true, true, true, true, false, true]);
  });
});

describe.each([
  ["chat", () => createElement(ChatView, { bot }), "[data-chathead-row]"],
  ["room", () => createElement(GroupView, { group: room }), "[data-roomhead-row]"],
] as const)("%s header", (_name, view, rowSelector) => {
  it.each<Chrome>(["mac-inset", "win-caption"])("is a drag region with every control cut out on %s", (chrome) => {
    fixture.chrome = chrome;
    const document = dom(view());
    const header = document.querySelector(rowSelector)!.parentElement!;
    expect(header.hasAttribute("data-window-drag")).toBe(true);
    expect(region(header)).toBe("drag");
    const controls = [...header.querySelectorAll(CONTROLS)];
    expect(controls.length).toBeGreaterThan(1);
    for (const control of controls) expect(cutOut(control, header), control.outerHTML.slice(0, 120)).toBe(true);
    expect(region(header.querySelector("[data-chathead-identity], [data-roomhead-identity]"))).toBe("no-drag");
  });

  it("keeps the right-hand controls level on Windows too: the caption buttons sit in the frame's top bar above it", () => {
    const controls = (chrome: Chrome) => {
      fixture.chrome = chrome;
      return dom(view()).querySelector("[data-chathead-controls], [data-roomhead-controls]");
    };
    expect(styleValue(controls("win-caption"), "margin-top")).toBe("");
    expect(styleValue(controls("mac-inset"), "margin-top")).toBe("");
  });

  it("leaves Linux's native title bar alone", () => {
    fixture.chrome = "native";
    const document = dom(view());
    expect(document.querySelector("[data-window-drag]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("app-region");
  });
});

describe("headerless views", () => {
  it.each<[Chrome, boolean]>([["mac-inset", true], ["win-caption", true], ["native", false]])(
    "get a top drag strip on %s: %s",
    (chrome, drags) => {
      fixture.chrome = chrome;
      const strip = dom(createElement(WindowDragStrip)).querySelector("[data-window-drag-strip]") as HTMLElement | null;
      expect(Boolean(strip)).toBe(drags);
      if (strip) {
        expect(region(strip)).toBe("drag");
        expect(strip.getAttribute("aria-hidden")).toBe("true");
        expect(strip.className).toContain("pointer-events-none");
      }
    },
  );
});
