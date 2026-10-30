import { createElement, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  advanced: false,
  effects: [] as Array<() => void | (() => void)>,
  portal: null as { node: ReactElement<{ ref: RefObject<HTMLDivElement | null> }>; target: unknown } | null,
}));
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useLayoutEffect: (effect: () => void | (() => void)) => fixture.effects.push(effect) };
});
vi.mock("react-dom", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom")>();
  return { ...original, createPortal: (node: ReactNode, target: unknown) => {
    fixture.portal = { node: node as NonNullable<typeof fixture.portal>["node"], target };
    return node;
  } };
});
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [bot, { ...bot, id: "other" }] }, dispatch: vi.fn() }) };
});

const { BotContextMenu } = await import("./Sidebar");
const { t } = await import("@/lib/i18n");
const bot: Bot = {
  id: "dumpling", threadId: "thread", name: "Dumpling", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "test", model: "test" },
};
const listeners = new Map<string, () => void>();
beforeEach(() => {
  fixture.advanced = false;
  fixture.effects = [];
  fixture.portal = null;
  listeners.clear();
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", {
    innerWidth: 1_000, innerHeight: 800,
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  });
});
afterEach(() => vi.unstubAllGlobals());

function render(x = 990, y = 795) {
  return renderToStaticMarkup(createElement(BotContextMenu, {
    menu: { botId: bot.id, x, y }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(),
    onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(),
  }));
}
/**
 * Runs this render's layout effects in order, as React does after a commit: the pop motion registers one ahead of
 * placement.
 */
function layoutEffects() {
  const cleanups = fixture.effects.map((effect) => effect());
  return () => cleanups.forEach((cleanup) => cleanup?.());
}
function measuredMenu(width: number, height: number) {
  const element = { style: { top: "", left: "" }, getBoundingClientRect: () => ({ width, height }) };
  fixture.portal!.node.props.ref.current = element as unknown as HTMLDivElement;
  return element;
}

describe("bot actions menu viewport placement", () => {
  it("measures the complete menu so bottom-row Archive stays inside the viewport", () => {
    const html = render();
    const element = measuredMenu(228, 468);
    const cleanup = layoutEffects();
    expect(element.style).toEqual({ top: "324px", left: "764px" });
    expect(html).toContain(">Archive</button>");
    expect(fixture.portal?.target).toBe(document.body);
    expect(html).toContain("data-sidebar");
    expect(listeners.has("resize")).toBe(true);
    cleanup();
    expect(listeners.has("resize")).toBe(false);
  });

  it("caps the menu and permits scrolling on short or narrow windows", () => {
    window.innerWidth = 220;
    window.innerHeight = 300;
    const html = render();
    const element = measuredMenu(204, 284);
    layoutEffects();
    expect(element.style).toEqual({ top: "8px", left: "8px" });
    expect(html).toContain("max-h-[calc(100dvh-16px)]");
    expect(html).toContain("max-w-[calc(100vw-16px)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("overscroll-contain");
    expect(html).not.toContain("overflow-hidden");
  });

  it("repositions after resizing and clamps negative context-menu anchors", () => {
    render();
    const element = measuredMenu(228, 468);
    layoutEffects();
    window.innerHeight = 600;
    listeners.get("resize")!();
    expect(element.style.top).toBe("124px");
    fixture.effects = [];
    render(-20, -10);
    const negative = measuredMenu(228, 468);
    layoutEffects();
    expect(negative.style).toEqual({ top: "8px", left: "8px" });
  });

  it("keeps Advanced's flat list of bot actions, drawn on the shared menu sheet", () => {
    fixture.advanced = true;
    const html = render();
    for (const key of ["task.newShort", "folder.new", "task.deleteAll", "sidebar.bot.pin", "sidebar.bot.makeChief", "sidebar.bot.moveToSection", "sidebar.bot.markUnread", "sidebar.bot.editProfile", "sidebar.bot.duplicate", "sidebar.copyConversationId", "sidebar.bot.archive", "common.delete"] as const) {
      expect(html, key).toContain(t(key));
    }
    expect(html).not.toContain(t("sidebar.bot.more"));
    expect(html).toContain("rounded-[var(--radius-menu)]");
    expect(html).not.toContain("shadow-2xl");
  });
});
