import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { ServiceIcon } from "./ServiceIcon";

it("draws an app with no catalog logo from its initial, never from a favicon service", () => {
  const html = renderToStaticMarkup(createElement(ServiceIcon, { card: { logo: null, domain: "slack.com", label: "Slack" } }));
  expect(html).not.toContain("<img");
  expect(html).not.toContain("google.com");
  expect(html).toContain(">S</div>");
});

it("draws the catalog's logo when there is one", () => {
  const html = renderToStaticMarkup(createElement(ServiceIcon, { card: { logo: "https://logos.example.test/slack.png", domain: "slack.com", label: "Slack" } }));
  expect(html).toContain('src="https://logos.example.test/slack.png"');
});
