import { describe, expect, it } from "vitest";

import { buildNotification, type NotifyKind } from "../server/notify.ts";
import { APNS_TOKEN, PUSH_TITLE_MAX, phonePushNotification, phonePushTitle } from "./phone-push.ts";

const KINDS: NotifyKind[] = [
  "approval", "question", "done", "routine-failed", "routine-deferred", "turn-failed",
  "incident", "sign-in", "delegation-settled", "spend",
];

describe("the push title", () => {
  it("uses the harness's own banner words, from names alone", () => {
    const bot = { id: "bot_1", name: "Scout", threadId: "th_1", notifications: true };
    for (const kind of KINDS) {
      if (kind === "spend") continue;
      const banner = buildNotification(kind, bot, "th_1", "a body", { group: { id: "grp_1", name: "Launch" }, site: "bank.example" });
      // a sign-in request leaves the website out of the push
      const expected = kind === "sign-in" ? "Scout in Launch needs you to sign in" : banner!.title;
      expect(phonePushTitle(kind, "Scout", "Launch"), kind).toBe(expected);
    }
    expect(phonePushTitle("spend", "Scout")).toBe("Workspace spend notice");
    expect(phonePushTitle("mention", "Scout", "Launch")).toBe("Scout in Launch mentioned you");
    // a kind a newer harness adds still reads as an alert
    expect(phonePushTitle("takeover", "Scout")).toBe("Scout needs you");
  });

  it("is bounded and single-line whatever the names are", () => {
    const title = phonePushTitle("approval", `Bot\n${"x".repeat(300)}`, "Room\u2028");
    expect(title).not.toMatch(/[\n\u2028]/);
    expect([...title].length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
  });
});

describe("the push payload", () => {
  it("carries kind, names and opaque ids, and never the notification's body", () => {
    const push = phonePushNotification(
      { kind: "question", botId: "bot_1", botName: "Scout", threadId: "th_1", body: "the secret question", avatarUrl: "/x.png" } as never,
      { id: "grp_1", name: "Launch" },
    );
    expect(push).toEqual({
      kind: "question",
      title: "Scout in Launch has a question",
      botId: "bot_1",
      botName: "Scout",
      threadId: "th_1",
      roomId: "grp_1",
      roomName: "Launch",
    });
    expect(JSON.stringify(push)).not.toContain("secret");
  });

  it("refuses ids the contract does not allow rather than send them", () => {
    expect(phonePushNotification({ kind: "approval", botId: "../etc", botName: "Scout", threadId: "th_1" })).toBeNull();
    expect(phonePushNotification({ kind: "Approval!", botId: "bot_1", botName: "Scout", threadId: "th_1" })).toBeNull();
  });

  it("accepts APNs tokens as lowercase hex only", () => {
    expect(APNS_TOKEN.test("ab".repeat(32))).toBe(true);
    expect(APNS_TOKEN.test("AB".repeat(32))).toBe(false);
    expect(APNS_TOKEN.test("ab".repeat(31))).toBe(false);
  });
});
