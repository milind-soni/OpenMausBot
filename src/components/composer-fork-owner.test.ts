import { describe, expect, it } from "vitest";
import { composerForkOwner } from "./composer-simple";

describe("/fork in the composer", () => {
  it("forks the open bot's or room's thread", () => {
    expect(composerForkOwner({ phone: false, botId: "kiwi", threadId: "t", startsThread: false })).toBe("kiwi");
    expect(composerForkOwner({ phone: false, group: { id: "room" }, threadId: "t", startsThread: false })).toBe("room");
  });

  it("is not offered in a room feed's composer, whose line starts a thread that doesn't exist yet", () => {
    expect(composerForkOwner({ phone: false, group: { id: "room" }, threadId: "feed-room", startsThread: true })).toBeUndefined();
  });

  it("is not offered on a phone, in a bot-to-bot room or with no thread", () => {
    expect(composerForkOwner({ phone: true, botId: "kiwi", threadId: "t", startsThread: false })).toBeUndefined();
    expect(composerForkOwner({ phone: false, group: { id: "dm", dm: true }, threadId: "t", startsThread: false })).toBeUndefined();
    expect(composerForkOwner({ phone: false, botId: "kiwi", startsThread: false })).toBeUndefined();
  });
});
