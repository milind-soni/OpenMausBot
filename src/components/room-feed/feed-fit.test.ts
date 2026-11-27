import { describe, expect, it } from "vitest";
import { feedThreadFits, feedThreadPlace } from "./feed-fit";

describe("a thread opened from a room's feed", () => {
  it("sits beside the feed only when the feed keeps 420px beside a 360px thread", () => {
    expect(feedThreadFits(780)).toBe(true);
    expect(feedThreadFits(779)).toBe(false);
  });

  it("takes the feed's place when the two don't fit, closing the Inbox instead when it is what leaves too little room", () => {
    // 1100px window: 280px sidebar, 320px Inbox, 500px for the feed and the thread.
    expect(feedThreadPlace(500, { inboxBeforeThread: true, inboxWidth: 320 })).toBe("close-inbox");
    // The Inbox opened later, with the thread already open: the thread takes the feed's place and the Inbox stays.
    expect(feedThreadPlace(500, { inboxBeforeThread: false, inboxWidth: 320 })).toBe("full");
    // 900px window, 72px icon rail and the Inbox: 508px, 828px without the Inbox.
    expect(feedThreadPlace(508, { inboxBeforeThread: true, inboxWidth: 320 })).toBe("close-inbox");
    // 800px window, rail and Inbox: 408px, and 728px without the Inbox still isn't enough, so the Inbox stays.
    expect(feedThreadPlace(408, { inboxBeforeThread: true, inboxWidth: 320 })).toBe("full");
    expect(feedThreadPlace(728, { inboxBeforeThread: true, inboxWidth: 0 })).toBe("full");
    expect(feedThreadPlace(1160, { inboxBeforeThread: true, inboxWidth: 0 })).toBe("beside");
  });
});
