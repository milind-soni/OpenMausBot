import { describe, expect, it } from "vitest";
import { connectorCallsIn } from "../shared/outbound.ts";
import { gmailDraftRefusal, reserveGmailDrafts } from "./gmail-draft-policy.ts";

const create = (thread_id = "gmail-thread") => ({ slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { thread_id } });

describe("Gmail draft request boundaries", () => {
  it("blocks sends, replies, forwards and opaque execution even in a mixed batch", () => {
    for (const request of ["Draft a reply to MEGA", "Create exactly one reply draft", "Do not send it.", "Don’t send it", "Save this without sending"]) {
      for (const slug of ["GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "COMPOSIO_PROXY_EXECUTE"]) {
        expect(gmailDraftRefusal(request, [create(), { slug }]), `${request}: ${slug}`).toContain("blocked");
      }
    }
    expect(gmailDraftRefusal("Do not send", connectorCallsIn("COMPOSIO_REMOTE_WORKBENCH", { code: "send()" }))).toContain("blocked");
  });

  it("allows draft creation and discovery but requires updates for revisions", () => {
    const request = "Create exactly one reply draft. If a draft already exists, update it instead of creating another. Do not send it.";
    expect(gmailDraftRefusal(request, [create()])).toBeNull();
    expect(gmailDraftRefusal("Update the existing MEGA reply draft. Do not send it.", [create()])).toContain("gmail.update_draft");
    for (const slug of ["GMAIL_LIST_DRAFTS", "GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT", "COMPOSIO_SEARCH_TOOLS"]) {
      expect(gmailDraftRefusal("Revise my draft", [{ slug }])).toBeNull();
    }
  });

  it("keeps explicit send requests available", () => {
    expect(gmailDraftRefusal("Send the existing draft now", [{ slug: "GMAIL_SEND_DRAFT" }])).toBeNull();
  });

  it("reserves one creation per Gmail thread, atomically across batches", () => {
    const reserved = new Set<string>();
    expect(reserveGmailDrafts([create(), create()], reserved)).toContain("already attempted");
    expect(reserved.size).toBe(0);
    expect(reserveGmailDrafts([create()], reserved)).toBeNull();
    expect(reserveGmailDrafts([create("other"), create()], reserved)).toContain("already attempted");
    expect(reserved.size).toBe(1);
    expect(reserveGmailDrafts([create("other")], reserved)).toBeNull();
    expect(reserveGmailDrafts([{ slug: "GMAIL_UPDATE_DRAFT" }], reserved)).toBeNull();
  });
});
