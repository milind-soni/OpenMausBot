import { describe, expect, it } from "vitest";
import { reserveGmailDrafts } from "./gmail-draft-policy.ts";

const create = (thread_id = "gmail-thread") => ({ slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { thread_id } });

describe("Gmail draft reservations", () => {
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
