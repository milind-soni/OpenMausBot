// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  state: { computerOpen: false, settingsOpen: false, inspectorOpen: false, activityOpen: false, activeView: "chat" },
  api: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ framing: "allowed" })),
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
const reply = (text: string, fields: Partial<Message> = {}) => ({ id: "m1", role: "bot", kind: "text", text, at: 1, ...fields }) as Message;
const tokens = (value: string | null) => (value ?? "").split(/\s+/).filter(Boolean).sort();

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ framing: "allowed" });
  fixture.opened.length = 0;
  fixture.dispatched.length = 0;
  fixture.withStore = true;
  rememberPublishedApps([]);
  // happy-dom's observer never reports, so every card counts as on screen.
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => { closeAppPreview(); root.unmount(); }); host.remove(); vi.unstubAllGlobals(); });

const show = (message: Message) => act(async () => root.render(createElement(PublishedSiteCards, { message })));
const cards = () => [...host.querySelectorAll<HTMLElement>("[data-published-site]")];
const press = (card: HTMLElement, label: string) => act(() => [...card.querySelectorAll("button")].find((button) => button.textContent === label || button.getAttribute("aria-label") === label)!.click());

describe("a published site's card in the chat", () => {
  it("draws a live public site small, in the sandbox the preview uses, with its address, Open and Open in browser", async () => {
    await show(reply(`Your bakery site is live: [bright-bakery](${SITE}). Anyone with the link can open it.`));
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card!.getAttribute("data-published-site")).toBe(SITE);
    expect(card!.textContent).toContain("bright-bakery.netlify.app");
    const frame = card!.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe(SITE);
    for (const token of tokens(frame.getAttribute("sandbox"))) expect(tokens(SITE_FRAME_SANDBOX), token).toContain(token);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("tabindex")).toBe("-1");
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
      for (const open of ["Open", "Preview bright-bakery.netlify.app"]) {
        press(cards()[0]!, open);
        await act(async () => side.render(createElement(AppPreviewPanel)));
        expect(panel.querySelector("aside")?.getAttribute("data-app-preview"), open).toBe(SITE);
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
    fixture.api.mockResolvedValue({ framing: "login" });
    await show(reply(`Published at ${SITE}`));
    const card = cards()[0]!;
    expect(card.querySelector("iframe")).toBeNull();
    expect(card.querySelector("[data-app-preview-fallback]")?.textContent).toBe("This site asks for a Netlify login. Open it in your browser instead.");
    expect(card.textContent).toContain("Open in browser");

    act(() => root.unmount());
    root = createRoot(host);
    fixture.api.mockClear();
    rememberPublishedApps([{ id: "netlify-mira-s1", source: "netlify", title: "Bakery order page", url: SITE, bot: { id: "mira", name: "Mira" }, publishedAt: 1, access: "netlify-team", canDelete: true }]);
    await show(reply(`Published at ${SITE}menu`));
    expect(cards()[0]!.querySelector("iframe")).toBeNull();
    expect(cards()[0]!.textContent).toContain("Bakery order page");
    expect(cards()[0]!.querySelector("[data-app-preview-fallback]")).not.toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("shows no card for an address that is not https, not a published site, in code, or the app itself", async () => {
    for (const text of ["Published at http://bright-bakery.netlify.app/", "See https://example.com/menu", "Run `curl https://bright-bakery.netlify.app/`",
      "```\nhttps://bright-bakery.netlify.app/\n```", `Open ${window.location.origin}/`, "https://user:pw@bright-bakery.netlify.app/", "No link here."]) {
      await show(reply(text));
      expect(cards(), text).toEqual([]);
    }
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("shows nothing on a person's message or a reply still streaming", async () => {
    await show(reply(`Can you change ${SITE}?`, { role: "user" }));
    expect(cards()).toEqual([]);
    await show(reply(`Live at ${SITE}`, { id: "live:t1:1" }));
    expect(cards()).toEqual([]);
  });

  it("gives each site one card, in order, and a long list of links three", async () => {
    await show(reply(`Live: ${SITE} (also [here](${SITE}).) The page: ${PAGE}`));
    expect(cards().map((card) => card.getAttribute("data-published-site"))).toEqual([SITE, PAGE]);
    await show(reply(["one", "two", "three", "four"].map((name) => `https://${name}.netlify.app/`).join("\n")));
    expect(cards().map((card) => card.getAttribute("data-published-site"))).toEqual(["https://one.netlify.app/", "https://two.netlify.app/", "https://three.netlify.app/"]);
  });

  it("is full width on a phone and never wider than a reply on a wide screen", async () => {
    await show(reply(`Live: ${SITE}`));
    expect(cards()[0]!.className).toContain("w-full");
    expect(cards()[0]!.className).toContain("max-md:max-w-none");
  });
});
