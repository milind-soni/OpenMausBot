// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishedApp } from "../../../shared/published-apps";
import type { Message } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  state: { computerOpen: false, settingsOpen: false, inspectorOpen: false, activityOpen: false, activeView: "chat" },
  framing: "allowed",
  listed: [] as unknown[],
  api: vi.fn(),
  opened: [] as string[],
  dispatched: [] as unknown[],
  withStore: true,
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: () => {} }) }));
vi.mock("@/state/store-ref", () => ({ useOptionalStoreRef: () => (fixture.withStore ? { dispatch: (action: unknown) => fixture.dispatched.push(action), state: () => fixture.state } : null) }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: async (url: string) => { fixture.opened.push(url); } }));

const { closeAppPreview } = await import("@/lib/app-preview");
const { rememberPublishedApps, SITE_FRAME_SANDBOX } = await import("@/lib/published-apps");
const { AppPreviewPanel } = await import("./AppPreviewPanel");
const { PublishedSiteCards } = await import("./PublishedSiteCards");

const SITE = "https://bright-bakery.netlify.app/";
const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
const app = (id: string, url: string, title: string, fields: Partial<PublishedApp> = {}): PublishedApp =>
  ({ id, source: "netlify", title, url, bot: { id: "mira", name: "Mira" }, publishedAt: 1, access: "public", canDelete: true, ...fields });
const OWN = [
  app("netlify-mira-bakery", SITE, "Bright Bakery"),
  app("page-1", PAGE, "Opening hours", { source: "page", access: "link" }),
  ...["one", "two", "three", "four"].map((name) => app(`netlify-mira-${name}`, `https://${name}.netlify.app/`, name)),
];
const reply = (text: string, fields: Partial<Message> = {}) => ({ id: "m1", role: "bot", kind: "text", text, at: 1, ...fields }) as Message;
const tokens = (value: string | null) => (value ?? "").split(/\s+/).filter(Boolean).sort();

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => (path.startsWith("/api/published-apps/framing") ? { framing: fixture.framing } : { apps: fixture.listed }));
  fixture.framing = "allowed";
  fixture.listed = OWN;
  fixture.opened.length = 0;
  fixture.dispatched.length = 0;
  fixture.withStore = true;
  rememberPublishedApps(OWN);
  // happy-dom's observer never reports, so every card counts as on screen.
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => { closeAppPreview(); root.unmount(); }); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const show = (...messages: Message[]) => act(async () => root.render(createElement(Fragment, null, ...messages.map((message) => createElement(PublishedSiteCards, { key: message.id, message })))));
const cards = () => [...host.querySelectorAll<HTMLElement>("[data-published-site]")];
const sites = () => cards().map((card) => card.getAttribute("data-published-site"));
const press = (card: HTMLElement, label: string) => act(() => [...card.querySelectorAll("button")].find((button) => button.textContent === label || button.getAttribute("aria-label") === label)!.click());
const framingChecks = () => fixture.api.mock.calls.filter(([path]) => String(path).startsWith("/api/published-apps/framing"));
const listReads = () => fixture.api.mock.calls.filter(([path]) => path === "/api/published-apps");

describe("a published site's card in the chat", () => {
  it("draws the person's own live site small, in the card picture's sandbox, never inside a button", async () => {
    await show(reply(`Your bakery site is live: [bright-bakery](${SITE}). Anyone with the link can open it.`));
    const [card] = cards();
    expect(sites()).toEqual([SITE]);
    expect(card!.textContent).toContain("Bright Bakery");
    expect(card!.textContent).toContain("bright-bakery.netlify.app");
    const frame = card!.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe(SITE);
    for (const token of tokens(frame.getAttribute("sandbox"))) expect(tokens(SITE_FRAME_SANDBOX), token).toContain(token);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("tabindex")).toBe("-1");
    expect(frame.closest("button")).toBeNull();
    expect(card!.querySelector("[data-app-preview-fallback]")).toBeNull();

    press(card!, "Open in browser");
    expect(fixture.opened).toEqual([SITE]);
    expect(fixture.dispatched).toEqual([]);
  });

  it("opens the preview beside the chat from Open, the picture and the address", async () => {
    const panel = document.createElement("div");
    document.body.append(panel);
    const side = createRoot(panel);
    try {
      await show(reply(`Here it is: ${SITE}`));
      for (const open of ["Open", "Preview Bright Bakery"]) {
        press(cards()[0]!, open);
        await act(async () => side.render(createElement(AppPreviewPanel)));
        expect(panel.querySelector("aside")?.getAttribute("data-app-preview"), open).toBe(SITE);
        expect(panel.querySelector("h2")?.textContent).toBe("Bright Bakery");
        act(() => closeAppPreview());
      }
      act(() => { cards()[0]!.querySelector("a")!.click(); });
      await act(async () => side.render(createElement(AppPreviewPanel)));
      expect(panel.querySelector("aside")?.getAttribute("data-app-preview")).toBe(SITE);
      expect(fixture.dispatched).toContainEqual({ type: "toggleComputer", open: false });
      expect(fixture.opened).toEqual([]);
    } finally {
      act(() => side.unmount());
      panel.remove();
    }
  });

  it("opens in the browser when there is no app around the message to show a preview in", async () => {
    fixture.withStore = false;
    await show(reply(`Here it is: ${SITE}`));
    press(cards()[0]!, "Open");
    expect(fixture.opened).toEqual([SITE]);
  });

  it("shows the login line and no frame for a site that asks for a login", async () => {
    fixture.framing = "login";
    await show(reply(`Published at ${SITE}`));
    const card = cards()[0]!;
    expect(card.querySelector("iframe")).toBeNull();
    expect(card.querySelector("[data-app-preview-fallback]")?.textContent).toBe("This site asks for a Netlify login. Open it in your browser instead.");
    expect(card.textContent).toContain("Open in browser");

    act(() => root.unmount());
    root = createRoot(host);
    fixture.api.mockClear();
    rememberPublishedApps([app("netlify-mira-s1", SITE, "Bakery order page", { access: "netlify-team" })]);
    await show(reply(`Published at ${SITE}menu`));
    expect(cards()[0]!.querySelector("iframe")).toBeNull();
    expect(cards()[0]!.textContent).toContain("Bakery order page");
    expect(cards()[0]!.querySelector("[data-app-preview-fallback]")).not.toBeNull();
    expect(framingChecks()).toEqual([]);
  });

  it("draws no card for a Netlify site that is not the person's own, and asks for the list once about it", async () => {
    const lure = "https://paypa1-account-verify.netlify.app/login";
    await show(reply(`Please confirm your details at ${lure}`));
    expect(cards()).toEqual([]);
    expect(host.querySelector("iframe")).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(listReads().length).toBeLessThanOrEqual(1);
    await show(reply(`Please confirm your details at ${lure} now`));
    expect(cards()).toEqual([]);
    expect(framingChecks()).toEqual([]);
  });

  it("draws a card once the list holds a site a bot has just published", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fresh = "https://fresh-launch.netlify.app/";
    fixture.listed = [...OWN, app("netlify-mira-fresh", fresh, "Fresh launch")];
    await show(reply(`It's live: ${fresh}`));
    expect(cards()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listReads()).toHaveLength(1);
    expect(sites()).toEqual([fresh]);
    expect(cards()[0]!.textContent).toContain("Fresh launch");
  });

  it("shows no card for an address that is not https, not a published site, in code, or the app itself", async () => {
    rememberPublishedApps([...OWN, app("netlify-local", `${window.location.origin}/`, "Local")]);
    for (const text of ["Published at http://bright-bakery.netlify.app/", "See https://example.com/menu", "Run `curl https://bright-bakery.netlify.app/`",
      "```\nhttps://bright-bakery.netlify.app/\n```", `Open ${window.location.origin}/`, "https://user:pw@bright-bakery.netlify.app/", "No link here."]) {
      await show(reply(text));
      expect(cards(), text).toEqual([]);
    }
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("shows nothing on a person's message, a reply still streaming, or a published page's own card", async () => {
    await show(reply(`Can you change ${SITE}?`, { role: "user" }));
    expect(cards()).toEqual([]);
    await show(reply(`Live at ${SITE}`, { id: "live:t1:1" }));
    expect(cards()).toEqual([]);
    await show(reply(`Published ${PAGE}`, { publishedPage: { pageId: "abcdefghijklmnopqrstuvwxyz", title: "Opening hours", url: PAGE, state: "live" } as Message["publishedPage"] }));
    expect(cards()).toEqual([]);
  });

  it("gives each site one card, in order, and a long list of links three", async () => {
    await show(reply(`Live: ${SITE} (also [the menu](${SITE}menu).) The page: ${PAGE}`));
    expect(sites()).toEqual([SITE, PAGE]);
    await show(reply(["one", "two", "three", "four"].map((name) => `https://${name}.netlify.app/`).join("\n")));
    expect(sites()).toEqual(["https://one.netlify.app/", "https://two.netlify.app/", "https://three.netlify.app/"]);
  });

  it("draws a site only on the newest reply that links it", async () => {
    const older = reply(`First version: ${SITE}`, { id: "m1", at: 1 }), newer = reply(`Updated: ${SITE} and ${PAGE}`, { id: "m2", at: 2 });
    await show(older, newer);
    expect(sites()).toEqual([SITE, PAGE]);
    expect(host.querySelectorAll("iframe")).toHaveLength(2);
    await show(older);
    expect(sites()).toEqual([SITE]);
  });

  it("drops the frame while the card is well off screen, and draws it again when it is back", async () => {
    const watchers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { watchers.push(callback); }
      observe() {}
      disconnect() {}
    });
    await show(reply(`Live: ${SITE}`));
    expect(host.querySelector("iframe")).toBeNull();
    const see = (isIntersecting: boolean) => act(() => { for (const watch of watchers) watch([{ isIntersecting }]); });
    see(true);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(SITE);
    see(false);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("[data-app-thumb]")?.getAttribute("data-app-thumb")).toBe("tile");
    see(true);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(SITE);
    expect(framingChecks()).toHaveLength(1);
  });

  it("is full width on a phone and never wider than a reply on a wide screen", async () => {
    await show(reply(`Live: ${SITE}`));
    expect(cards()[0]!.className).toContain("w-full");
    expect(cards()[0]!.className).toContain("max-md:max-w-none");
  });
});
