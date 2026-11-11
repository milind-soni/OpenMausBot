// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  state: { computerOpen: false, settingsOpen: false, inspectorOpen: false, activityOpen: false, activeView: "chat" },
  api: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ framing: "allowed" })),
  opened: [] as string[],
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: () => {} }) }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: async (url: string) => { fixture.opened.push(url); } }));

const { closeAppPreview, openAppPreview } = await import("@/lib/app-preview");
const { SITE_FRAME_ALLOW, SITE_FRAME_SANDBOX, SITE_THUMB_SANDBOX, showable } = await import("@/lib/published-apps");
const { AppPreviewPanel } = await import("./AppPreviewPanel");
const { SiteFrame } = await import("./SiteFrame");
const { SiteThumb } = await import("./SiteThumb");

const SITE = "https://bright-bakery.netlify.app/";
const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
let root: Root;
let host: HTMLElement;
beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ framing: "allowed" });
  fixture.opened.length = 0;
  Object.assign(fixture.state, { computerOpen: false, settingsOpen: false, inspectorOpen: false, activityOpen: false, activeView: "chat" });
  // happy-dom's observer never reports, so every card counts as on screen.
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => { closeAppPreview(); root.unmount(); }); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const frame = (props: { url: string; loginOnly?: boolean }) => act(async () => root.render(createElement(SiteFrame, { title: "Bakery", attempt: 0, ...props })));
const tokens = (value: string | null) => (value ?? "").split(/\s+/).filter(Boolean).sort();

describe("the sandbox a published site runs in", () => {
  it("gives the preview scripts, its own origin, forms and new tabs, and nothing that reaches the window around it", async () => {
    await frame({ url: SITE });
    const iframe = host.querySelector("iframe")!;
    expect(tokens(iframe.getAttribute("sandbox"))).toEqual(["allow-forms", "allow-popups", "allow-same-origin", "allow-scripts"]);
    for (const reach of ["allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols", "allow-popups-to-escape-sandbox",
      "allow-downloads", "allow-modals", "allow-pointer-lock", "allow-presentation", "allow-storage-access-by-user-activation", "allow-orientation-lock"]) {
      expect(SITE_FRAME_SANDBOX, reach).not.toContain(reach);
      expect(SITE_THUMB_SANDBOX, reach).not.toContain(reach);
    }
    expect(iframe.getAttribute("src")).toBe(SITE);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.hasAttribute("srcdoc")).toBe(false);
    expect(iframe.hasAttribute("name")).toBe(false);
    for (const feature of ["camera", "microphone", "geolocation", "display-capture", "clipboard-read"]) expect(iframe.getAttribute("allow")).toContain(`${feature} 'none'`);
    expect(SITE_FRAME_ALLOW).not.toMatch(/\*|'self'|'src'/);
  });

  it("gives a card's picture less still: no forms, no new tabs, no pointer, no keyboard, nothing read aloud", async () => {
    await act(async () => root.render(createElement(SiteThumb, { url: SITE, title: "Bakery", loginOnly: false })));
    const iframe = host.querySelector("iframe")!;
    expect(tokens(iframe.getAttribute("sandbox"))).toEqual(["allow-same-origin", "allow-scripts"]);
    expect(iframe.getAttribute("tabindex")).toBe("-1");
    expect(iframe.getAttribute("aria-hidden")).toBe("true");
    expect(iframe.getAttribute("loading")).toBe("lazy");
    expect(iframe.className).toContain("pointer-events-none");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("allow")).toContain("camera 'none'");
  });

  it("never frames the app's own origin or anything that is not a plain web address", async () => {
    const own = window.location.origin;
    for (const url of [`${own}/`, `${own}/api/bots`, "javascript:alert(document.cookie)", "data:text/html,<script>parent.ogb</script>", "file:///etc/passwd", "blob:https://x.test/1",
      "about:srcdoc", "openmausbot://bot/pepper", "https://user:pw@bright-bakery.netlify.app/", "not a url", ""]) {
      expect(showable(url, own), url).toBe(false);
      await frame({ url });
      expect(host.querySelector("iframe"), url).toBeNull();
      expect(host.querySelector("[data-app-preview-fallback]"), url).not.toBeNull();
      await act(async () => root.render(createElement(SiteThumb, { url, title: "Bakery", loginOnly: false })));
      expect(host.querySelector("iframe"), url).toBeNull();
      expect(host.querySelector("[data-app-thumb]")?.getAttribute("data-app-thumb")).toBe("tile");
    }
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("hands the site no bridge: no message listener, no window name, no script of the app's in its frame", async () => {
    const listen = vi.spyOn(window, "addEventListener");
    openAppPreview({ url: SITE, title: "Bakery" });
    await act(async () => root.render(createElement(AppPreviewPanel)));
    expect(host.querySelector("iframe")).not.toBeNull();
    expect(listen.mock.calls.filter(([type]) => type === "message")).toEqual([]);
    listen.mockRestore();
    for (const file of ["SiteFrame.tsx", "SiteThumb.tsx", "AppPreviewPanel.tsx", "use-framing.ts"]) {
      const text = source(`src/components/published-apps/${file}`);
      for (const bridge of ["postMessage", "contentWindow", "contentDocument", "window.ogb", "srcDoc", "mausbot.", "<webview"]) expect(text, `${file}: ${bridge}`).not.toContain(bridge);
    }
  });

  it("runs in a window whose preload never loads into a frame and which never frames the app's own server", () => {
    const main = source("electron/main.mjs");
    const preferences = main.slice(main.indexOf('preload: path.join(__dirname, "preload.cjs")') - 200, main.indexOf('preload: path.join(__dirname, "preload.cjs")') + 600);
    expect(preferences).toContain("contextIsolation: true");
    for (const opening of ["nodeIntegrationInSubFrames", "webviewTag", "nodeIntegration: true", "contextIsolation: false", "webSecurity: false", "allowRunningInsecureContent"]) expect(main, opening).not.toContain(opening);
    expect(main).toMatch(/will-frame-navigate[\s\S]{0,700}target === rendererOrigin\(\) \|\| allowedOrigins\(environmentsState, rendererOrigin\(\)\)\.has\(target\)[\s\S]{0,80}preventDefault/);
    expect(main).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]{0,300}return \{ action: "deny" \};/);
  });

  it("is the rule the app's pinned web pages already use", () => {
    const pinned = source("src/components/WebPanelPage.tsx");
    expect(pinned).toContain("sandbox={SITE_FRAME_SANDBOX}");
    expect(pinned).not.toMatch(/sandbox="/);
  });
});

describe("a site that can't be shown in the preview", () => {
  it("gets a plain line and Open in browser when it refuses to be framed", async () => {
    fixture.api.mockResolvedValue({ framing: "blocked" });
    await frame({ url: SITE });
    expect(fixture.api).toHaveBeenCalledWith(`/api/published-apps/framing?url=${encodeURIComponent(SITE)}&origin=${encodeURIComponent(window.location.origin)}`, expect.objectContaining({ background: true }));
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("This app can't be shown here");
    expect(host.textContent).toContain("Some sites don't let other apps show them. Open it in your browser instead.");
    act(() => [...host.querySelectorAll("button")].find((one) => one.textContent === "Open in browser")!.click());
    expect(fixture.opened).toEqual([SITE]);
  });

  it("is not framed at all when it asks for a Netlify login", async () => {
    await frame({ url: SITE, loginOnly: true });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("This site asks for a Netlify login. Open it in your browser instead.");
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("falls back when it never loads, and stays when it did", async () => {
    vi.useFakeTimers();
    await frame({ url: SITE });
    await act(async () => { vi.advanceTimersByTime(10_500); });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("[data-app-preview-fallback]")).not.toBeNull();

    await act(async () => root.render(createElement(SiteFrame, { url: "https://other-site.netlify.app/", title: "Other", attempt: 0 })));
    act(() => { host.querySelector("iframe")!.dispatchEvent(new Event("load")); });
    await act(async () => { vi.advanceTimersByTime(10_500); });
    expect(host.querySelector("iframe")).not.toBeNull();
  });

  it("stays a tile on the card when the site refuses framing, asks for a login or is still loading", async () => {
    const thumb = (loginOnly = false) => act(async () => root.render(createElement(SiteThumb, { url: SITE, title: " bakery", loginOnly })));
    await thumb();
    expect(host.querySelector("[data-app-thumb]")?.getAttribute("data-app-thumb")).toBe("tile");
    expect(host.textContent).toBe("B");
    act(() => { host.querySelector("iframe")!.dispatchEvent(new Event("load")); });
    expect(host.querySelector("[data-app-thumb]")?.getAttribute("data-app-thumb")).toBe("live");
    await thumb(true);
    expect(host.querySelector("iframe")).toBeNull();
    fixture.api.mockResolvedValue({ framing: "blocked" });
    act(() => root.unmount());
    root = createRoot(host);
    await thumb();
    expect(host.querySelector("iframe")).toBeNull();
  });
});

describe("the preview beside the chat", () => {
  const panel = () => act(async () => root.render(createElement(AppPreviewPanel)));
  const press = (name: string) => act(() => [...host.querySelectorAll("button")].find((one) => one.getAttribute("aria-label") === name)!.click());

  it("shows the app with its name and address, Reload, Open in browser and Close", async () => {
    await panel();
    expect(host.querySelector("aside")).toBeNull();
    act(() => openAppPreview({ url: `${SITE}menu`, title: "Bakery order page" }));
    await panel();
    const aside = host.querySelector("aside")!;
    expect(aside.getAttribute("aria-label")).toBe("Preview of Bakery order page");
    expect(aside.querySelector("h2")?.textContent).toBe("Bakery order page");
    expect(aside.textContent).toContain("bright-bakery.netlify.app");
    const first = host.querySelector("iframe")!;
    press("Reload");
    expect(host.querySelector("iframe")).not.toBe(first);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(`${SITE}menu`);
    press("Open in browser");
    expect(fixture.opened).toEqual([`${SITE}menu`]);
    press("Close preview");
    expect(host.querySelector("aside")).toBeNull();
  });

  it("gives the side to another panel that opens, and is not shown over another page", async () => {
    act(() => openAppPreview({ url: SITE, title: "Bakery" }));
    await panel();
    expect(host.querySelector("aside")).not.toBeNull();
    fixture.state.activeView = "published-apps";
    await panel();
    expect(host.querySelector("aside")).toBeNull();
    fixture.state.activeView = "chat";
    await panel();
    expect(host.querySelector("aside")).not.toBeNull();
    fixture.state.computerOpen = true;
    await panel();
    fixture.state.computerOpen = false;
    await panel();
    expect(host.querySelector("aside")).toBeNull();
  });
});
