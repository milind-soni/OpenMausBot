import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { BrowserSignInPage } from "./BrowserSignInPage";

const credential = `omb_pair_${"c".repeat(43)}`;

it("says whose Cloud a browser sign-in is for, with one Continue and no second step, and never shows the credential", () => {
  const html = renderToStaticMarkup(createElement(BrowserSignInPage, { credential, owner: "ada@example.test" }));
  expect(html).toContain("Signing in to ada@example.test’s Cloud");
  // One quiet line for someone who was sent another person's link.
  expect(html).toContain('<p class="mt-1.5 text-[13.5px] text-ink-secondary">Not your email? Close this tab.</p>');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain(">Continue</button>");
  expect(html).not.toContain(credential);
  expect(html).not.toContain("omb_pair_");
  expect(html).not.toMatch(/<input|<form|role="alert"/);
});
