import { describe, expect, it } from "vitest";

import type { InboxRow } from "../../../shared/inbox";
import { countsForYou, inboxGroup, inboxReason } from "../../../shared/inbox-reason";
import { approvalRow, inboxView, messageRow, questionRow, reportRow, settledRow } from "@/testing/inbox-fixture";
import { activityUnread, forYouCount, groupRows, listedRows, reasonOf, waitingCount } from "./inbox-view";

const line = (fields: Partial<InboxRow>): InboxRow => ({ ...messageRow, id: `line-${Math.random()}`, ...fields });

describe("why a line is in the inbox", () => {
  it("follows from the line itself where it can", () => {
    expect(inboxReason(questionRow)).toBe("asked");
    expect(inboxReason(approvalRow)).toBe("approval");
    expect(inboxReason(settledRow), "an answered approval still says what it was").toBe("approval");
    expect(inboxReason(reportRow)).toBe("finished");
    expect(inboxReason(messageRow), "a message with no reason of its own").toBe("messaged");
    expect(inboxReason(line({ kind: "notice", replies: undefined }))).toBe("notice");
    expect(inboxReason(line({ kind: "ask", card: undefined, secret: { label: "OpenAI key" } as unknown as InboxRow["secret"] })), "a password it needs").toBe("asked");
  });

  it("asks for an OK on a change to review and on someone asking for access", () => {
    const card = questionRow.card!;
    expect(inboxReason({ ...questionRow, card: { ...card, skillRequest: { name: "x" } as never } })).toBe("approval");
    expect(inboxReason({ ...questionRow, card: { ...card, accessRequest: { botId: "b", botName: "Ledger", email: "ben@acme.test", name: "Ben" } } })).toBe("approval");
  });

  it("takes what the server says when only the server can tell", () => {
    expect(inboxReason(line({ reason: "mentioned" }))).toBe("mentioned");
    expect(inboxReason(line({ reason: "replied" }))).toBe("replied");
    expect(inboxReason(line({ reason: "asked" }))).toBe("asked");
    expect(inboxReason(line({ kind: "notice", reason: "shared" }))).toBe("shared");
    expect(inboxReason({ ...approvalRow, reason: "mentioned" }), "an ask is its card, whatever else it carries").toBe("approval");
  });

  it("says it in the person's words", () => {
    expect([questionRow, approvalRow, line({ reason: "mentioned" }), line({ reason: "replied" }), messageRow, line({ kind: "notice" }), reportRow, line({ kind: "notice", reason: "shared" })].map(reasonOf))
      .toEqual(["Asked you", "Needs your OK", "Mentioned you", "Replied to you", "Messaged you", "Needs a look", "Finished", "Shared with you"]);
  });
});

describe("For you and Activity", () => {
  it("puts what waits on the person or names them in For you, and finished work and shares in Activity", () => {
    expect([questionRow, approvalRow, messageRow, line({ reason: "mentioned" }), line({ reason: "replied" }), line({ kind: "notice" })].map(inboxGroup)).toEqual(Array(6).fill("for-you"));
    expect([reportRow, line({ kind: "notice", reason: "shared" }), line({ reason: "shared" })].map(inboxGroup)).toEqual(["activity", "activity", "activity"]);
  });

  it("splits the listed lines into the two groups, keeping their order", () => {
    const groups = groupRows(listedRows(inboxView()));
    expect(groups["for-you"].map((row) => row.id)).toEqual([approvalRow.id, questionRow.id, messageRow.id]);
    expect(groups.activity.map((row) => row.id)).toEqual([reportRow.id]);
  });

  it("counts only For you: an open ask, read or not, and an unread message; never finished work", () => {
    const view = inboxView();
    expect(forYouCount(view)).toBe(3);
    expect(waitingCount(view), "the older count, kept for what still reads it, still counts the report").toBe(4);
    expect(countsForYou({ ...messageRow, unread: false })).toBe(false);
    expect(countsForYou(settledRow)).toBe(false);
    expect(forYouCount(inboxView([reportRow]))).toBe(0);
    expect(forYouCount(null)).toBe(0);
  });

  it("tells when unread Activity alone is left, for the Inbox row's bold", () => {
    expect(activityUnread(inboxView([reportRow]))).toBe(true);
    expect(activityUnread(inboxView([{ ...reportRow, unread: false }, messageRow]))).toBe(false);
  });

  it("keeps the line the person has open in the list once it is settled", () => {
    const view = inboxView([approvalRow, { ...reportRow, tab: "done" }]);
    expect(listedRows(view).map((row) => row.id)).toEqual([approvalRow.id]);
    expect(listedRows(view, reportRow.id).map((row) => row.id)).toEqual([approvalRow.id, reportRow.id]);
  });
});
