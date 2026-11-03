import { describe, expect, it, vi } from "vitest";
import type { Action } from "./store";
import { openRoomThread } from "./thread-navigation";

const room = { id: "room", threadId: "current", tasks: [{ threadId: "current" }, { threadId: "opened" }] };

describe("openRoomThread", () => {
  it("opens the room on the thread the chip names", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    openRoomThread(dispatch, [room], "room", "opened");
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room" },
      { type: "switchGroupTask", groupId: "room", threadId: "opened" },
    ]);
  });

  it("only selects the room when the thread is already open or no longer there", () => {
    for (const threadId of ["current", "deleted", undefined]) {
      const dispatch = vi.fn<(action: Action) => void>();
      openRoomThread(dispatch, [room], "room", threadId);
      expect(dispatch.mock.calls.map(([action]) => action), String(threadId)).toEqual([{ type: "select", id: "room" }]);
    }
  });
});
