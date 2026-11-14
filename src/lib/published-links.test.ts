// @vitest-environment happy-dom
import { createElement, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isNetlifySiteUrl, type PublishedApp } from "../../shared/published-apps";

const opened = vi.hoisted(() => [] as string[]);
const store = vi.hoisted(() => ({ ref: null as null | { dispatch: (action: unknown) => void; state: () => unknown } }));
vi.mock("./app-links", () => ({ openExternalLink: async (url: string) => { opened.push(url); } }));
vi.mock("@/state/store-ref", () => ({ useOptionalStoreRef: () => store.ref }));

const { closeAppPreview, useAppPreview } = await import("./app-preview");
const { publishedLink, usePageOpener, withPageOpen } = await import("./page-open");
const { appInitial, rememberPublishedApps } = await import("./published-apps");

const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
const STAND_IN: PublishedApp = { id: "netlify-mira-s1", source: "netlify", title: "Bakery order page", url: "http://127.0.0.1:4010/live/abc/", bot: { id: "mira", name: "Mira" }, publishedAt: 1, access: "netlify-team", canDelete: true };

afterEach(() => { rememberPublishedApps([]); closeAppPreview(); opened.length = 0; store.ref = null; });

describe("a link to something a bot put online", () => {
  it("is a Netlify site's own address, a published page, or an app in the loaded list, and nothing that only looks like one", () => {
    for (const link of ["https://bright-bakery.netlify.app", "https://bright-bakery.netlify.app/menu?x=1#top", "https://6913a0c2e4b0a1000812f3aa--bright-bakery.netlify.app/", PAGE]) expect(publishedLink(link), link).not.toBeNull();
    for (const link of ["http://bright-bakery.netlify.app/", "https://netlify.app/", "https://app.netlify.com/projects/x", "https://bright-bakery.netlify.app.evil.test/", "https://evil.test/bright-bakery.netlify.app",
      "https://a.b.netlify.app/", "https://user:pw@bright-bakery.netlify.app/", "https://bright-bakery.netlify.app:8443/", "https://-x.netlify.app/", "https://example.com/", STAND_IN.url, "javascript:alert(1)", "", undefined, null]) {
      expect(publishedLink(link), String(link)).toBeNull();
    }
    expect(isNetlifySiteUrl("https://Bright-Bakery.Netlify.App/")).toBe(true);
  });

  it("is named by the app's own title once the list has it, and marked when the site asks for a login", () => {
    expect(publishedLink("https://bright-bakery.netlify.app/menu")).toEqual({ url: "https://bright-bakery.netlify.app/menu", title: "bright-bakery.netlify.app" });
    rememberPublishedApps([STAND_IN]);
    expect(publishedLink(`${STAND_IN.url}index.html`)).toEqual({ url: `${STAND_IN.url}index.html`, title: "Bakery order page", loginOnly: true });
    expect(publishedLink("http://127.0.0.1:4010/live/abcd/")).toBeNull();
    expect(publishedLink("http://127.0.0.1:4011/live/abc/")).toBeNull();
  });

  it("gets the click in a message; any other link keeps its own", () => {
    const open = vi.fn();
    const click = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    type Anchor = { href?: string; onClick?: (event: MouseEvent<HTMLElement>) => void };
    withPageOpen<Anchor>("https://bright-bakery.netlify.app/", open, {}).onClick!(click as unknown as MouseEvent<HTMLElement>);
    expect(open).toHaveBeenCalledWith("https://bright-bakery.netlify.app/");
    expect(click.defaultPrevented).toBe(true);
    const plain: Anchor = { href: "https://example.com/" };
    expect(withPageOpen("https://example.com/", open, plain)).toBe(plain);
  });

  it("uses the app's first letter or digit for its tile", () => {
    expect([appInitial("bakery"), appInitial("  “Élan” site"), appInitial("3 cups"), appInitial("🎂 cake"), appInitial("—")]).toEqual(["B", "É", "3", "C", "·"]);
  });
});

describe("where a published link in a message opens", () => {
  const roots: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const root of roots.splice(0)) root.unmount(); });
  function mount(options?: { beside?: boolean }) {
    const seen: { open?: (url: string) => void; preview?: unknown } = {};
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    function Probe() { seen.open = usePageOpener(options); seen.preview = useAppPreview(); return null; }
    flushSync(() => root.render(createElement(Probe)));
    return seen;
  }
  const chat = () => {
    const actions: unknown[] = [];
    store.ref = { dispatch: (action) => actions.push(action), state: () => ({ selectedId: "mira", bots: [{ id: "mira" }], groups: [], config: null }) };
    return actions;
  };

  it("beside the chat, in place of the other side panels, without leaving the app", () => {
    const actions = chat(), seen = mount({ beside: true });
    flushSync(() => seen.open!("https://bright-bakery.netlify.app/menu"));
    expect(seen.preview).toEqual({ url: "https://bright-bakery.netlify.app/menu", title: "bright-bakery.netlify.app" });
    expect(actions).toEqual([{ type: "toggleComputer", open: false }, { type: "toggleSettings", open: false }, { type: "toggleInspector", open: false }, { type: "toggleActivity", open: false }]);
    expect(opened).toEqual([]);
  });

  it("outside the app for any other link, for a card's own Open, and where there is no chat around it", () => {
    chat();
    const beside = mount({ beside: true });
    flushSync(() => beside.open!("https://example.com/"));
    const button = mount();
    flushSync(() => button.open!("https://bright-bakery.netlify.app/"));
    store.ref = null;
    const alone = mount({ beside: true });
    flushSync(() => alone.open!(PAGE));
    expect(opened).toEqual(["https://example.com/", "https://bright-bakery.netlify.app/", PAGE]);
    expect(beside.preview).toBeNull();
  });
});
