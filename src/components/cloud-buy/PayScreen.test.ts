import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { PayScreen } from "./PayScreen";

const pay = (trialDays?: number) => renderToStaticMarkup(createElement(PayScreen, {
  plan: "team", offer: { plans: [{ tier: "team", label: "Team", amount: 16900, ...(trialDays ? { trialDays } : {}) }], recommended: "team" }, browser: "checkout", late: false, link: false,
  email: null, busy: false, copied: false, failed: false, onReopen: vi.fn(), onCopy: vi.fn(), onChangePlan: vi.fn(),
}));

it("says a 1-day trial in the singular, and other lengths as they read", () => {
  expect(pay(1)).toContain("Team · free for 1 day · $0.00 today");
  expect(pay(3)).toContain("Team · free for 3 days · $0.00 today");
  expect(pay()).not.toContain("free for");
});
