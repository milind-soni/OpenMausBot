import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { runtimeRequestCardFields } from "./request-card.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
const event = (fields: Partial<RequestOpened> = {}): RequestOpened => ({
  eventId: "event", provider: "fixture", threadId: "thread", createdAt: "2026-11-04T12:00:00Z",
  type: "request.opened", requestId: "request", requestType: "permission", tool: "Bash", summary: "ls memory",
  ...fields,
});

const context = { permission: true, guestDriven: false };

describe("runtime request-card projection", () => {
  it("keeps the native command, grant and held note without turning the display summary into a command", () => {
    const command = { command: "ls memory", cwd: "/workspace", providerInstanceId: "fixture" };
    expect(runtimeRequestCardFields(event({ approvalScope: "local-computer", allowSession: true }), {
      ...context, commandAllowlist: command, allowKey: "exact-tool", held: "Held note", heldCode: "approval.held.fixture",
    })).toEqual({
      subtitle: "ls memory", options: ["Allow", "Deny"],
      requestId: "request", requestType: "permission", tool: "Bash", questionRequest: undefined,
      commandAllowlist: command, allowKey: "exact-tool", allowSession: true,
      held: "Held note", heldCode: "approval.held.fixture", approvalScope: "local-computer",
    });
  });

  it.each([
    { guestDriven: true, requiresExplicitApproval: false },
    { guestDriven: false, requiresExplicitApproval: true },
  ])("never offers a session grant for %j", ({ guestDriven, requiresExplicitApproval }) => {
    expect(runtimeRequestCardFields(event({ allowSession: true, requiresExplicitApproval }), { ...context, guestDriven }).allowSession)
      .toBeUndefined();
  });

  it("keeps structured questions and their origin without offering permission grants", () => {
    const questions = [{ question: "Which color?", options: [{ label: "Blue" }] }];
    expect(runtimeRequestCardFields(event({ requestType: "question", choices: ["Blue"], questions, origin: "output", allowSession: true }), {
      permission: false, guestDriven: false,
    })).toMatchObject({
      subtitle: "ls memory", options: ["Blue"], requestType: "question",
      tool: undefined, allowSession: undefined, questionRequest: { version: 1, questions, origin: "output" },
    });
  });

  it("keeps old uncoded requests free of summary metadata", () => {
    expect(runtimeRequestCardFields(event(), context)).not.toHaveProperty("summaryCode");
    expect(runtimeRequestCardFields(event({ summaryParams: { message: "External words" } }), context)).not.toHaveProperty("summaryParams");
  });
});
