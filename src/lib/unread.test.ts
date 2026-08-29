import { describe, expect, it } from "vitest";

import { openNotificationCount, unreadConversationCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible bot and room conversations but ignores archived bots", () => {
    expect(
      unreadConversationCount(
        [{ unread: true }, { unread: false }, { unread: true, hidden: true }],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(2);
  });

  it("counts unread and waiting agents once for the native taskbar badge", () => {
    expect(
      openNotificationCount(
        [
          { unread: true, activity: "waiting-on-you" },
          { unread: false, activity: "waiting-on-you" },
          { unread: true, activity: "idle", hidden: true },
        ],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(3);
  });
});
