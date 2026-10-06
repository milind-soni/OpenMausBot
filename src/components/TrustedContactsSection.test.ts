import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {} }));
import { ContactInbox } from "./TrustedContactsSection";
import type { ContactRequestRecord } from "../../shared/trusted-contacts";
const request: ContactRequestRecord = { id: "request", contactId: "contact", input: { id: "external", kind: "proposal", subject: "Coffee <script>", start: 1793523600000, end: 1793527200000 }, fingerprint: "hash", status: "pending", createdAt: 1, expiresAt: 1793523600000, reply: { id: "request", status: "pending", text: "Waiting" } };
it("shows the exact proposal and approval controls without rendering sender markup", () => {
  const html = renderToStaticMarkup(createElement(ContactInbox, { requests: [request], contacts: [{ id: "contact", name: "Priya", botId: "bot", disabled: false }], busy: false, onDecision: () => {} }));
  expect(html).toContain("Priya"); expect(html).toContain("Coffee &lt;script&gt;"); expect(html).toContain("Approve"); expect(html).toContain("Decline");
});
it("does not offer approval on expired or completed records", () => {
  const html = renderToStaticMarkup(createElement(ContactInbox, { requests: [{ ...request, status: "expired" }], contacts: [], busy: false, onDecision: () => {} }));
  expect(html).not.toContain(">Approve<"); expect(html).toContain("expired");
});
