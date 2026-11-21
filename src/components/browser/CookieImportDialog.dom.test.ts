// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CookieImportDialog, siteOfAddress } from "./CookieImportDialog";
import { MoreMenu } from "./MoreMenu";

const SOURCES = [
  { id: "chrome", name: "Google Chrome", engine: "chromium" as const, profiles: [{ id: "Default", name: "Person" }, { id: "Profile 1", name: "Work" }] },
  { id: "firefox", name: "Firefox", engine: "firefox" as const, profiles: [{ id: "abc.default", name: "default-release" }] },
];

let host: HTMLDivElement;
let root: Root;
let bridge: { sources: ReturnType<typeof vi.fn>; offer: ReturnType<typeof vi.fn>; import: ReturnType<typeof vi.fn> };
const settle = async () => { await act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const text = () => host.textContent ?? "";

beforeEach(() => {
  bridge = { sources: vi.fn(async () => SOURCES), offer: vi.fn(), import: vi.fn() };
  (window as unknown as { ogb: unknown }).ogb = { browserCookies: bridge };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
});

const render = async (site = "github.com") => {
  await act(async () => root.render(createElement(CookieImportDialog, { open: true, botId: "scout", botName: "Scout", threadId: null, site, onClose: () => {} })));
  await settle();
};
const submit = async () => {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
};

describe("the sign-in import dialog", () => {
  it("names the browser, profile, site and bot, then says how many cookies came over", async () => {
    bridge.import.mockResolvedValue({ ok: true, site: "github.com", imported: 4, sessionOnly: 0, skipped: {} });
    await render();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("github.com");
    expect(text()).toContain("Copies your sign-in for github.com from Google Chrome (Person) into Scout's browser.");
    expect(text()).toContain("Google sign-ins are never copied");
    await submit();
    expect(bridge.import).toHaveBeenCalledWith({ botId: "scout", threadId: null, site: "github.com", source: "chrome", profile: "Default" });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Imported 4 cookies for github.com.");
  });

  it("picks the browser and profile in the app's own dropdowns, a new browser starting at its first profile", async () => {
    bridge.import.mockResolvedValue({ ok: true, site: "github.com", imported: 1, sessionOnly: 0, skipped: {} });
    await render();
    const [from, profile] = [...host.querySelectorAll<HTMLSelectElement>('select[data-look="select"]')];
    expect([from, profile].map((select) => select!.value)).toEqual(["chrome", "Default"]);
    await act(async () => { profile!.value = "Profile 1"; profile!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(text()).toContain("from Google Chrome (Work)");
    await act(async () => { from!.value = "firefox"; from!.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(host.querySelectorAll<HTMLSelectElement>('select[data-look="select"]')[1]!.value).toBe("abc.default");
    await submit();
    expect(bridge.import).toHaveBeenCalledWith({ botId: "scout", threadId: null, site: "github.com", source: "firefox", profile: "abc.default" });
  });

  it("says plainly why nothing was imported", async () => {
    bridge.import.mockResolvedValue({ ok: false, reason: "full-disk-access" });
    await render("example.com");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Full Disk Access");
    bridge.import.mockResolvedValue({ ok: false, reason: "google" });
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Use My Chrome for Google");
  });

  it("names the whole site an import takes, and keeps what the person typed while the bot browses on", async () => {
    bridge.import.mockResolvedValue({ ok: true, site: "example.com", imported: 2, sessionOnly: 0, skipped: { protected: 3 } });
    await render("docs.example.com");
    expect(text()).toContain("Copies your sign-in for example.com from Google Chrome (Person) into Scout's browser.");
    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://shop.example.co.uk/cart");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(text()).toContain("Copies your sign-in for example.co.uk from");
    // The page the bot is on moves; the form stays as the person left it.
    await act(async () => root.render(createElement(CookieImportDialog, { open: true, botId: "scout", botName: "Scout", threadId: null, site: "other.test", onClose: () => {} })));
    await settle();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("https://shop.example.co.uk/cart");
    await submit();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Imported 2 cookies for example.com. 3 more couldn't be read from Google Chrome.");
  });

  it("says when no browser with sign-ins is on this computer", async () => {
    bridge.sources.mockResolvedValue([]);
    await render();
    expect(text()).toContain("No browser with sign-ins was found on this computer.");
    expect(host.querySelector("form")).toBeNull();
  });
});

describe("the browser menu's import entry", () => {
  const menu = (onImport?: () => void) => createElement(MoreMenu, {
    stream: true, ready: true, typing: true, setting: { mode: "fill" }, zoom: 1, pip: null,
    onViewport: () => {}, onZoom: () => {}, onPip: () => {}, onType: () => {}, onSecret: () => {}, onReconnect: () => {}, onRestart: () => {},
    ...(onImport ? { onImport } : {}),
  });

  it("appears only where an import is possible, and opens the dialog", async () => {
    await act(async () => root.render(menu()));
    expect(text()).not.toContain("Import sign-in from your browser");
    const onImport = vi.fn();
    await act(async () => root.render(menu(onImport)));
    const entry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Import a sign-in…")!;
    await act(async () => { entry.click(); });
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("starts the site from the page the bot is on", () => {
    expect(siteOfAddress("https://www.github.com/login")).toBe("github.com");
    expect(siteOfAddress("about:blank")).toBe("");
    expect(siteOfAddress("chrome://settings")).toBe("");
  });
});
