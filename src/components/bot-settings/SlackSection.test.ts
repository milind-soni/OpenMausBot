import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlackSection } from "./SlackSection";
import { slackManagementUrl } from "./useSlackManagement";

const URL_ = "https://admin.example.test/slack?workspace=acme&bot=bot_123";

describe("Slack section", () => {
  it("is one link to Admin, opened in a new tab without an opener", () => {
    const markup = renderToStaticMarkup(createElement(SlackSection, { managementUrl: URL_ }));
    expect(markup).toContain("Give this agent its own Slack app, with its own name and picture, so your team can message it directly.");
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain(`href="${URL_.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Manage in Admin");
    expect(markup).not.toMatch(/<(button|input)/);
  });

  it("offers a link only for an available https answer", () => {
    expect(slackManagementUrl({ available: true, managementUrl: URL_ })).toBe(URL_);
    for (const response of [
      { available: false }, { available: false, managementUrl: URL_ }, { available: "true", managementUrl: URL_ },
      { available: true }, { available: true, managementUrl: 7 }, { available: true, managementUrl: "not a url" },
      { available: true, managementUrl: "http://admin.example.test/slack" },
      { available: true, managementUrl: "javascript:alert(1)" },
      null, undefined, "https://admin.example.test", [],
    ]) expect(slackManagementUrl(response), JSON.stringify(response)).toBeNull();
  });
});
