// A typed search forces every section it filters open and locks its toggle:
// the query is hiding what a collapsed section held, so folding it away would
// hide the very rows the person is looking for. The Tools footer is the
// exception — the search never matches its rows, so a query must neither force
// it open nor lock its toggle. Bots (and every other section) keep the
// search-aware behaviour.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { BOTS_SECTION_ID, FOOTER_TOOLS_SECTION_ID } from "@/lib/sidebar-layout";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY } from "@/lib/sidebar-preferences";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  collapsed: [] as string[],
  bots: [] as unknown[],
}));

// The sidebar's state is ordinary hooks; this suite has no DOM, so the hooks
// hold their values here and a render re-reads them — enough to type into the
// search box, render again, and see what the wiring did with the query.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    return (fixture.values[index] ??= { current: initial }) as { current: unknown };
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
// The mascot canvas only attaches through a DOM ref this suite has none of.
vi.mock("./CursorAvatar", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CursorAvatar")>(),
  CursorAvatar: () => null,
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const original = await importOriginal<typeof import("./DesktopCapabilities")>();
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { ...original, useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities(), ready: true }) };
});
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => false,
}));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, bots: fixture.bots as Bot[] },
      dispatch: vi.fn(),
    }),
  };
});

import { Sidebar } from "./Sidebar";

const bot: Bot = {
  id: "atlas", threadId: "last-selected", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: true,
  modelSelection: { instanceId: "fake", model: "test" }, messages: [],
};

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
/** Render the sidebar as an element tree, so a control's handler can be called. */
function tree() {
  fixture.index = 0;
  fixture.effects = [];
  const element = nodes(Sidebar({ open: true, onClose: () => {} }));
  // Only the sidebar's own hooks ran here. Anything past them was written by
  // the children of an earlier markup render, whose layout may not be the one
  // being rendered next — so children start from their own initial values.
  fixture.values.length = fixture.index;
  return element;
}
/** Render the sidebar to markup on the state the handlers left behind. */
function render() {
  tree();
  fixture.index = 0;
  return renderToStaticMarkup(createElement(Sidebar, { open: true, onClose: () => {} }));
}
function typeInSearch(value: string) {
  const input = tree().find((node) => node.props["aria-label"] === t("sidebar.searchAria"));
  expect(input, "the sidebar search box").toBeDefined();
  (input!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
/** The Tools toggle and the 400 characters that follow it. */
function toolsToggle(markup: string) {
  const at = markup.indexOf('data-testid="sidebar-footer-tools-toggle"');
  expect(at, "the Tools toggle").toBeGreaterThan(-1);
  return markup.slice(at, at + 400);
}

beforeEach(() => {
  fixture.values = [];
  fixture.effects = [];
  fixture.collapsed = [];
  fixture.bots = [bot];
  setLocale("en");
  vi.stubGlobal("window", {
    innerWidth: 1280, innerHeight: 800,
    location: { protocol: "http:", search: "" },
    ogb: undefined, setTimeout, clearTimeout,
  });
  vi.stubGlobal("document", { body: {}, querySelector: () => null });
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === SIDEBAR_COLLAPSED_SECTIONS_KEY ? JSON.stringify(fixture.collapsed) : null),
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("sidebar search and the Tools footer", () => {
  it("keeps a saved Tools collapse and a working toggle while a query is typed", () => {
    fixture.collapsed = [FOOTER_TOOLS_SECTION_ID];
    const idle = render();
    expect(toolsToggle(idle)).toContain('aria-expanded="false"');
    expect(idle).not.toContain('data-sidebar-nav="routines"');

    typeInSearch("atlas");
    const searched = render();
    // collapsed, because the saved state still says so …
    expect(toolsToggle(searched)).toContain('aria-expanded="false"');
    expect(searched).not.toContain('data-sidebar-nav="routines"');
    // … and toggleable: a search that never matches these rows must not
    // disable the control the way it does for every other section.
    expect(toolsToggle(searched)).not.toContain('disabled=""');
  });

  it("still opens a bot section the query matches, while the Tools footer holds its state", () => {
    fixture.collapsed = [BOTS_SECTION_ID, FOOTER_TOOLS_SECTION_ID];
    const idle = render();
    // both sections are collapsed until the query arrives
    expect(idle).not.toContain('data-sidebar-bot-row="atlas"');
    expect(toolsToggle(idle)).toContain('aria-expanded="false"');

    typeInSearch("atlas");
    const searched = render();
    // the query matches Atlas, so the section opens to show what it holds
    expect(searched).toContain('data-sidebar-bot-row="atlas"');
    // the Tools rows the query cannot match stay exactly as saved
    expect(toolsToggle(searched)).toContain('aria-expanded="false"');
    expect(searched).not.toContain('data-sidebar-nav="routines"');
  });

  it("leaves a Tools toggle that was left open open through a search", () => {
    typeInSearch("atlas");
    const searched = render();
    expect(toolsToggle(searched)).toContain('aria-expanded="true"');
    expect(toolsToggle(searched)).not.toContain('disabled=""');
    expect(searched).toContain('data-sidebar-nav="routines"');
  });
});