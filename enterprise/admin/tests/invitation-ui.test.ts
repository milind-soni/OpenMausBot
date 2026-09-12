import { describe, expect, it } from "vitest";
import { invitationEmails, sendInvitations, workspaceSlug } from "../web/invitations.ts";

describe("workspace invitation helpers", () => {
  it("suggests an editable, bounded workspace address", () => {
    expect(workspaceSlug("  Café Design & Partners  ")).toBe("cafe-design-partners");
    expect(workspaceSlug("123 client")).toBe("client");
    expect(workspaceSlug("a".repeat(40))).toHaveLength(31);
  });

  it("normalizes email lists and validates the whole batch before sending", () => {
    expect(invitationEmails(" A@Example.test, b@example.test;\na@example.test ")).toEqual(["a@example.test", "b@example.test"]);
    expect(() => invitationEmails("")).toThrow("at least one");
    expect(() => invitationEmails("person@example.test bad-email")).toThrow("bad-email");
    expect(() => invitationEmails(Array.from({ length: 21 }, (_, i) => `person${i}@example.test`).join(","))).toThrow("20 people");
  });

  it("preserves partial delivery, saved invitations, and uncertain outcomes for safe retries", async () => {
    const calls: string[] = [];
    const results = await sendInvitations(["sent@example.test", "saved@example.test", "unknown@example.test"], async email => {
      calls.push(email);
      if (email.startsWith("saved")) throw Object.assign(new Error("Mail unavailable"), { status: 502, invitationId: "saved-id" });
      if (email.startsWith("unknown")) throw new TypeError("Network unavailable");
    });
    expect(calls).toEqual(results.map(result => result.email));
    expect(results[0]).toEqual({ email: "sent@example.test", sent: true });
    expect(results[1]).toMatchObject({ sent: false, invitationId: "saved-id", uncertain: false });
    expect(results[2]).toMatchObject({ sent: false, uncertain: true });
    const retried: string[] = [];
    await sendInvitations(results.filter(result => !result.sent && !result.uncertain).map(result => result.email), async email => { retried.push(email); });
    expect(retried).toEqual(["saved@example.test"]);
  });
});
