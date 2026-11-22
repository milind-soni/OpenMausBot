import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { Message, OptionCardData } from "@/state/store";
import { liveCardKind } from "../../shared/live-approval";
import { personWait } from "../../shared/person-wait";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

const { ApprovalCard, approvalCardOutcome, titledCard, titledCardTitle } = await import("./ApprovalCard");
const { PendingApprovalPanel, pendingApprovals, turnApprovals, waitsOnTurn } = await import("./PendingApproval");
const { EduCrewLine } = await import("./EduCrewLine");

const gate = (patch: Partial<OptionCardData> = {}): OptionCardData => ({
  title: "Let Edu crew go on?", subtitle: "Approve spec · Add a hello file", options: ["Approve", "Reject"], requestId: "educrew-1", tool: "edu_crew_gate", fixedOptions: true,
  eduCrewGate: { jobId: "11111111-2222-3333-4444-555555555555", gateId: "g-1", gate: "Approve spec", goal: "Add a hello file", folder: "/home/edu/Projects/shop",
    spec: "# Add a hello file\n\n- **R-1** hello.txt exists", commands: ["npm test"] },
  ...patch,
});
const message = (value: OptionCardData, id = "m1"): Message => ({ id, role: "bot", kind: "options", at: 1, card: value });

it("asks the person in plain words, with the spec, the commands approving runs and the folder", () => {
  const card = gate();
  expect(titledCard(card)).toBe(true);
  expect(titledCardTitle(card, "Luna")).toBe("Let Edu crew go on?");
  const [pending] = pendingApprovals([message(card)]);
  const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0, botName: "Luna" }));
  expect(html).toContain("Let Edu crew go on?");
  expect(html).toContain("Approve spec · Add a hello file");
  expect(html).toContain("hello.txt exists");
  expect(html).toContain("Approving runs these commands:\n$ npm test");
  expect(html).toContain("Works in /home/edu/Projects/shop");
});

it("never holds a turn, a call or a person's wait", () => {
  const card = message(gate(), "gate");
  expect(waitsOnTurn(pendingApprovals([card])[0]!)).toBe(false);
  expect(turnApprovals([card])).toEqual([]);
  expect(liveCardKind(card.card)).toBe("review");
  expect(personWait(card as never)).toBeNull();
});

it("says what the person decided once it is settled", () => {
  expect(approvalCardOutcome(gate({ answered: "allow" }))).toBe("Approved");
  expect(approvalCardOutcome(gate({ answered: "deny" }))).toBe("Rejected");
  expect(approvalCardOutcome(gate({ answered: "unavailable", dismissed: true }))).toBe("No longer waiting");
  const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: message(gate({ answered: "allow" })), threadId: "t1" }));
  expect(html).toContain('data-edu-crew-gate="settled"');
  expect(html).toContain("Approved");
});

it("keeps a job to one quiet line: Cancel while it runs, never an error card when it fails", () => {
  const row = (status: "running" | "failed", name: string): Message => ({ id: "l", role: "bot", kind: "activity", at: 1, tool: { name, ok: status !== "failed" },
    eduCrew: { jobId: "11111111-2222-3333-4444-555555555555", kind: "plan", status, title: "Add a hello file", at: 1 } });
  const running = renderToStaticMarkup(createElement(EduCrewLine, { message: row("running", "Edu crew is working on “Add a hello file”"), line: row("running", "").eduCrew! }));
  expect(running).toContain('data-edu-crew="running"');
  expect(running).toContain("data-edu-crew-cancel");
  expect(running).toContain("Edu crew is working on “Add a hello file”");
  const failed = renderToStaticMarkup(createElement(EduCrewLine, { message: row("failed", "Edu crew couldn’t finish “Add a hello file”: spec rejected"), line: row("failed", "").eduCrew! }));
  expect(failed).toContain('data-edu-crew="failed"');
  expect(failed).not.toContain("data-edu-crew-cancel");
  expect(failed).toContain("data-edu-crew-details");
});
