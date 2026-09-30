import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";

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
  // Icons-only sidebar: the words stay for screen readers and the tooltip.
  const compact = renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { cloudHome: true, compact: true }));
  expect(compact).toContain('title="My Cloud · always on"');
  expect(compact).toContain('<span class="sr-only">My Cloud · always on</span>');

  // The desktop app's switcher names the server (main says "My Cloud"; until
  // it answers, so does the switcher) and adds the same words.
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
  // Not on a server that is not a Cloud home.
  expect(renderToStaticMarkup(createElement(DesktopWorkspaceSwitcher, { owner: "ada@example.test" }))).toBe("");
});
