import { describe, expect, it } from "vitest";
import { RoomMemberLock } from "./room-member-lock.ts";

describe("RoomMemberLock", () => {
  it("lets one room thread hold a bot at a time", () => {
    const lock = new RoomMemberLock();
    expect(lock.claim("scout", "thread-a")).toBe(true);
    expect(lock.claim("scout", "thread-a")).toBe(true);
    expect(lock.claim("scout", "thread-b")).toBe(false);
    expect(lock.holder("scout")).toBe("thread-a");
    expect(lock.heldElsewhere("scout", "thread-b")).toBe(true);
    expect(lock.heldElsewhere("scout", "thread-a")).toBe(false);
    expect(lock.claim("pixel", "thread-b")).toBe(true);
  });

  it("releases only the holder's claim and wakes waiters after the claim is gone", () => {
    const lock = new RoomMemberLock();
    lock.claim("scout", "thread-a");
    const woken: Array<{ botId: string; holder: string | undefined }> = [];
    const stop = lock.onRelease((botId) => woken.push({ botId, holder: lock.holder(botId) }));
    expect(lock.release("scout", "thread-b")).toBe(false);
    expect(woken).toEqual([]);
    expect(lock.release("scout", "thread-a")).toBe(true);
    expect(woken).toEqual([{ botId: "scout", holder: undefined }]);
    expect(lock.release("scout", "thread-a")).toBe(false);
    stop();
    lock.claim("scout", "thread-b");
    lock.release("scout", "thread-b");
    expect(woken).toHaveLength(1);
  });

  it("hands a freed bot to exactly one of several waiting threads", () => {
    const lock = new RoomMemberLock();
    lock.claim("scout", "thread-a");
    const winners: string[] = [];
    for (const waiter of ["thread-b", "thread-c"]) {
      lock.onRelease((botId) => {
        if (botId === "scout" && lock.claim("scout", waiter)) winners.push(waiter);
      });
    }
    lock.release("scout", "thread-a");
    expect(winners).toEqual(["thread-b"]);
    expect(lock.holder("scout")).toBe("thread-b");
  });

  it("drops every claim of a thread whose drive ended", () => {
    const lock = new RoomMemberLock();
    lock.claim("scout", "thread-a");
    lock.claim("pixel", "thread-a");
    lock.claim("echo", "thread-b");
    const woken: string[] = [];
    lock.onRelease((botId) => woken.push(botId));
    expect(lock.releaseThread("thread-a").sort()).toEqual(["pixel", "scout"]);
    expect(woken.sort()).toEqual(["pixel", "scout"]);
    expect(lock.holder("echo")).toBe("thread-b");
  });

  it("keeps notifying when one listener throws", () => {
    const lock = new RoomMemberLock();
    lock.claim("scout", "thread-a");
    const woken: string[] = [];
    lock.onRelease(() => { throw new Error("listener failed"); });
    lock.onRelease((botId) => woken.push(botId));
    lock.release("scout", "thread-a");
    expect(woken).toEqual(["scout"]);
  });
});
