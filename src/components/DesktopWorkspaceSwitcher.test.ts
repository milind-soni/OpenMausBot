import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { DesktopWorkspaceSwitcher, openServerMenu } from "./DesktopWorkspaceSwitcher";

afterEach(() => { vi.unstubAllGlobals(); });

it("names the saved-server switcher with the product word, not workspace", () => {
  vi.stubGlobal("window", { ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
  const html = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher));
  expect(html).toContain('aria-label="Switch server: Servers"');
  expect(html).toContain(">Servers<");
  expect(html).not.toMatch(/workspace/i);
});

it("renders nothing outside the desktop app", () => {
  vi.stubGlobal("window", {});
  expect(renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher))).toBe("");
});

const visibleText = (html: string) => html.replace(/<span class="sr-only">.*?<\/span>/g, "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

it("says My Cloud · always on while a Cloud home is showing, in a browser too, and nothing more elsewhere", () => {
  vi.stubGlobal("window", {});
  const browser = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { cloudHome: true }));
  expect(visibleText(browser)).toBe("My Cloud · always on");
  expect(browser).toContain("data-cloud-home-indicator");
  expect(browser).not.toContain("<button");
  const compact = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { cloudHome: true, compact: true }));
  expect(compact).toContain('title="My Cloud · always on"');
  expect(compact).toContain('<span class="sr-only">My Cloud · always on</span>');

  vi.stubGlobal("window", { ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
  const desktop = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { cloudHome: true }));
  expect(visibleText(desktop)).toBe("My Cloud · always on");
  expect(desktop).toContain('aria-label="Switch server: My Cloud · always on"');
  expect(desktop).toContain("data-cloud-home-indicator");
  const elsewhere = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher));
  expect(elsewhere).not.toContain("always on");
  expect(elsewhere).not.toContain("data-cloud-home-indicator");
});

it("names whose Cloud a browser signed in to under My Cloud · always on, quietly", () => {
  vi.stubGlobal("window", {});
  const browser = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { cloudHome: true, owner: "ada@example.test" }));
  expect(visibleText(browser)).toBe("My Cloud · always onada@example.test’s Cloud");
  expect(browser).toContain('title="My Cloud · always on · ada@example.test’s Cloud"');
  expect(browser).toContain('<span class="block truncate text-[11.5px] font-normal text-ink-secondary">ada@example.test’s Cloud</span>');
  const compact = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { cloudHome: true, owner: "ada@example.test", compact: true }));
  expect(compact).toContain('<span class="sr-only">My Cloud · always on · ada@example.test’s Cloud</span>');
  expect(renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { owner: "ada@example.test" }))).toBe("");
});

it("is the Show me how tip's anchor, and opens the menu as reached from the tip only while the tip is up", async () => {
  vi.stubGlobal("window", { ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
  for (const props of [{}, { inline: true }, { compact: true }]) expect(renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, props))).toContain('data-tour="server-switcher"');
  const menu = vi.fn(() => Promise.resolve()), onClosed = vi.fn();
  await openServerMenu({ menu }, { howTo: true, onClosed });
  expect(menu).toHaveBeenLastCalledWith({ from: "howto" }); expect(onClosed).toHaveBeenCalledOnce();
  menu.mockRejectedValueOnce(new Error("no menu"));
  await expect(openServerMenu({ menu }, { howTo: true, onClosed })).rejects.toThrow("no menu");
  expect(onClosed).toHaveBeenCalledTimes(2);
  await openServerMenu({ menu }, { onClosed });
  expect(menu).toHaveBeenLastCalledWith(undefined); expect(onClosed).toHaveBeenCalledTimes(2);
});

it("draws Simple mode's switcher as a rounded pill that names the server in full, swapping to the laptop icon only when the row is too narrow", () => {
  vi.stubGlobal("window", { ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
  const pill = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { inline: true, pill: true }));
  expect(pill).toMatch(/aria-label="Switch server: Servers" aria-haspopup="menu" aria-expanded="false"[^>]*class="[^"]*\bh-8\b[^"]*\brounded-full\b[^"]*\bbg-raised\/50\b[^"]*\btext-\[13px\][^"]*\bfont-medium\b/);
  expect(pill).toContain('<span class="min-w-0 truncate @max-[124px]/sidebar-top:hidden">Servers</span>');
  expect(pill).toContain("lucide-chevron-down");
  expect(pill).toContain('class="lucide lucide-laptop hidden shrink-0 text-ink-secondary @max-[124px]/sidebar-top:block"');
  expect(pill).not.toContain("@max-[96px]");
  const inline = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { inline: true }));
  expect(inline).toContain("lucide-laptop");
  expect(inline).toMatch(/class="[^"]*\bh-7\b[^"]*\brounded-md\b[^"]*\btext-\[12\.5px\]/);
  expect(inline).not.toContain("rounded-full");

  vi.stubGlobal("window", {});
  const browser = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { inline: true, pill: true, cloudHome: true }));
  expect(visibleText(browser)).toBe("My Cloud");
  expect(browser).toMatch(/class="[^"]*\bh-8\b[^"]*\brounded-full\b/);
});

it("says All bots, with both icons, while This computer and My Cloud show together, and nothing new while they are apart", async () => {
  const { setOneWorkspaceForTests } = await import("@/lib/one-workspace");
  vi.stubGlobal("window", { ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
  setOneWorkspaceForTests({ view: { page: "computer", twinHome: "computer", cloudName: "My Cloud", other: { side: "cloud", state: "ready", at: 1, bots: [], rooms: [], sections: [] } } });
  try {
    // Advanced's narrow inline switcher shows the words alone, so "All bots" is never cut short.
    expect(renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { inline: true }))).not.toContain("data-switcher-both");
    for (const props of [{ inline: true, pill: true }, {}, { rail: true }]) {
      const html = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, props));
      expect(html).toContain('aria-label="Switch server: All bots (This computer and My Cloud)"');
      expect(html).toContain("data-switcher-both");
    }
    expect(visibleText(renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { inline: true, pill: true })))).toBe("All bots");
    setOneWorkspaceForTests(null);
    const apart = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { inline: true, pill: true }));
    expect(apart).not.toContain("All bots");
    expect(apart).not.toContain("data-switcher-both");
  } finally {
    setOneWorkspaceForTests(null);
  }
});
