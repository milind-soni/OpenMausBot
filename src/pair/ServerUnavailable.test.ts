import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { LoadFailed, ServerUnavailable } from "./ServerUnavailable";

it("tells a visitor the server is out of reach and that the page keeps trying", () => {
  const html = renderToStaticMarkup(createElement(ServerUnavailable, { probe: vi.fn() }));
  expect(html).toContain("We can&#x27;t reach Nation Team Chat right now");
  expect(html).toContain(">Try again now</button>");
  expect(html).toContain("Trying again in 3 s");
  expect(html).not.toMatch(/pnpm|dev:server|localhost/);
});

it("offers a reload when the page's own code will not load", () => {
  const html = renderToStaticMarkup(createElement(LoadFailed));
  expect(html).toContain("This page didn&#x27;t load completely");
  expect(html).toContain(">Reload</button>");
});
