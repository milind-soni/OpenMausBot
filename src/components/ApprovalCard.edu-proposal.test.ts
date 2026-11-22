import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { Message, OptionCardData } from "@/state/store";
import { liveCardKind } from "../../shared/live-approval";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

const { ApprovalCard, approvalCardOutcome, titledCard, titledCardTitle } = await import("./ApprovalCard");
const { PendingApprovalPanel, pendingApprovals, turnApprovals, waitsOnTurn } = await import("./PendingApproval");

const card = (patch: Partial<OptionCardData> = {}, global = false): OptionCardData => ({
  title: "Save to Luna's Edu brain?", subtitle: "English fallback", options: ["Approve", "Reject"], requestId: "edu-1", tool: "edu_propose_canonical",
  eduProposal: { id: "K-iso", title: "Use ISO dates", kind: "standard", band: "unbanded", why: "needs human confirmation", brain: "/data/brains/luna", global,
    location: global ? "/home/edu/.edu" : "/data/brains/luna", body: "Dates as YYYY-MM-DD." },
  ...patch,
});
const message = (value: OptionCardData, id = "m1"): Message => ({ id, role: "bot", kind: "options", at: 1, card: value });
const panel = (value: OptionCardData) => {
  const [pending] = pendingApprovals([message(value)]);
  return renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0, botName: "Luna" }));
};

it("says the proposal once, below the chat: the transcript row is for screen readers while it waits", () => {
  const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: message(card()), threadId: "t1" }));
  expect(titledCard(card())).toBe(true);
  expect(html).toContain('class="sr-only"');
  expect(html).not.toContain("Dates as YYYY-MM-DD.");
  expect(html).not.toContain("<pre");
});

it("words the proposal in plain prose and keeps Edu's own fields behind Details", () => {
  const html = panel(card());
  expect(html).toContain("Save to Luna&#x27;s Edu brain?");
  expect(html).toMatch(/data-edu-title[^>]*>Use ISO dates</);
  expect(html).toMatch(/data-edu-facts[^>]*>Rule</);
  expect(html).toContain("Dates as YYYY-MM-DD.");
  const shown = html.replace(/<div id="approval-details-[\s\S]*$/, "");
  expect(shown).not.toMatch(/unbanded|needs human confirmation|\/data\/brains|font-mono/);
  expect(html).toContain("id: K-iso\nkind: standard\nband: unbanded\nwhy: needs human confirmation\npath: /data/brains/luna");
});

it("says when approving changes the global brain, and gives the global brain's path, never the bot's", () => {
  const global = card({}, true);
  expect(titledCardTitle(global, "Luna")).toBe("Save to your global Edu brain?");
  const html = panel(global);
  expect(html).toContain("Approving changes your global Edu brain, which every coding CLI with Edu reads.");
  expect(html).toContain("path: /home/edu/.edu");
  expect(html).not.toContain("/data/brains/luna");
});

it("names a shared brain by its folder", () => {
  expect(titledCardTitle(card({ eduProposal: { ...card().eduProposal!, shared: true, brain: "/srv/team-notes" } }), "Luna")).toBe("Save to the shared brain (team-notes)?");
});

it("never holds a turn: a call and the composer pass it by, and a turn's own approval comes first", () => {
  const edu = message(card(), "edu");
  const bash = message({ title: "Run?", subtitle: "ls", options: ["Allow", "Deny"], requestId: "p1", tool: "Bash" }, "bash");
  expect(pendingApprovals([edu])).toHaveLength(1);
  expect(waitsOnTurn(pendingApprovals([edu])[0]!)).toBe(false);
  expect(turnApprovals([edu])).toEqual([]);
  expect(turnApprovals([edu, bash]).map((pending) => pending.requestId)).toEqual(["p1"]);
  expect(liveCardKind(card())).toBe("review");
});

it("words each ending, and a settled card names the note", () => {
  expect(approvalCardOutcome(card({ answered: "allow" }))).toBe("Saved to the Edu brain");
  expect(approvalCardOutcome(card({ answered: "deny" }))).toBe("Rejected");
  expect(approvalCardOutcome(card({ answered: "unavailable", dismissed: true }))).toBe("Already decided elsewhere");
  expect(approvalCardOutcome(card())).toBeUndefined();
  const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: message(card({ answered: "allow" })), threadId: "t1" }));
  expect(html).toContain("Use ISO dates");
  expect(html).toContain("Saved to the Edu brain");
  expect(html).not.toContain("sr-only");
});
