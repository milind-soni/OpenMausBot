import { describe, expect, it } from "vitest";

import { canonicalConnectorAction, canonicalConnectorOperationForTool } from "./canonical-connector-action.ts";

describe("canonicalConnectorAction", () => {
  it("creates an exact Gmail draft proposal from a guarded call", () => {
    const result = canonicalConnectorAction("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{
        tool_slug: "GMAIL_CREATE_EMAIL_DRAFT",
        account: "ca_personal",
        arguments: { recipient_email: "friend@example.com", subject: "Hello", body: "Hi" },
      }],
      sync_response_to_workbench: false,
    });

    expect(result).toEqual({
      fidelity: "canonical",
      action: {
        operation: "gmail.drafts.create",
        accountId: "ca_personal",
        payload: { recipient_email: "friend@example.com", subject: "Hello", body: "Hi" },
      },
    });
  });

  it("requires one explicit connected account", () => {
    expect(canonicalConnectorAction("GMAIL_CREATE_EMAIL_DRAFT", {
      recipient_email: "friend@example.com",
      subject: "Hello",
      body: "Hi",
    })).toMatchObject({ fidelity: "invalid", reason: expect.stringMatching(/account/i) });
  });

  it("rejects a mixed or multi-action batch for the first safe adapter", () => {
    expect(canonicalConnectorAction("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        { tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", account: "ca_personal", arguments: { body: "a" } },
        { tool_slug: "GMAIL_SEND_EMAIL", account: "ca_personal", arguments: { body: "b" } },
      ],
    })).toMatchObject({ fidelity: "invalid", reason: expect.stringMatching(/one action/i) });
  });

  it("maps supported send while keeping arbitrary draft-named tools unsupported", () => {
    expect(canonicalConnectorAction("GMAIL_SEND_EMAIL", { account: "ca_personal" })).toMatchObject({
      fidelity: "canonical", action: { operation: "gmail.send", accountId: "ca_personal" },
    });
    expect(canonicalConnectorAction("MYSTERY_DRAFT_THING", { account: "ca_personal" })).toEqual({ fidelity: "unsupported" });
  });

  it("covers calendar, Drive, and GitHub mutations with stable operation IDs", () => {
    const cases = [
      ["GOOGLECALENDAR_CREATE_EVENT", "calendar.events.create"],
      ["GOOGLECALENDAR_RESPOND_TO_EVENT", "calendar.events.rsvp"],
      ["GOOGLEDRIVE_DELETE_FILE", "drive.files.delete"],
      ["GITHUB_CREATE_PULL_REQUEST", "github.pull_requests.create"],
    ] as const;
    for (const [tool, operation] of cases) {
      expect(canonicalConnectorAction(tool, { account_id: "ca_work", id: "event-1" })).toMatchObject({
        fidelity: "canonical", action: { operation, accountId: "ca_work" },
      });
    }
  });

  it("exposes the canonical operation for a production Work title", () => {
    expect(canonicalConnectorOperationForTool("GITHUB_CREATE_ISSUE")).toBe("github.issues.create");
    expect(canonicalConnectorOperationForTool("MYSTERY_WRITE")).toBeNull();
  });

  it("rejects credentials embedded in any provider action payload", () => {
    expect(canonicalConnectorAction("GMAIL_SEND_EMAIL", {
      account: "ca_personal", message: { body: "hi", access_token: "do-not-store" },
    })).toMatchObject({ fidelity: "invalid", reason: expect.stringMatching(/credentials/i) });
  });
});
