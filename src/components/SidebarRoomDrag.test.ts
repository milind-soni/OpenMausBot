import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as { body: string; settle: (error?: Error) => void }[],
  api: vi.fn(),
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));

const { saveRoomOrder } = await import("./SidebarRoomDrag");

const rooms = (...ids: string[]) => ids.map((id) => ({ id }));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const orders = (dispatch: ReturnType<typeof vi.fn>) =>
  dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "groupsOrdered").map((action) => action.groupIds);

describe("saveRoomOrder", () => {
  beforeEach(() => {
    fixture.calls = [];
    fixture.api.mockReset();
    fixture.api.mockImplementation((_path: string, init: { body: string }) => new Promise<void>((resolve, reject) => {
      fixture.calls.push({ body: init.body, settle: (error) => (error ? reject(error) : resolve()) });
    }));
  });

  it("saves one order at a time, in the order asked", async () => {
    const dispatch = vi.fn();
    saveRoomOrder(dispatch, rooms("a", "b", "c"), ["b", "a", "c"]);
    saveRoomOrder(dispatch, rooms("b", "a", "c"), ["c", "b", "a"]);
    await flush();
    expect(fixture.calls.map((call) => JSON.parse(call.body).groupIds)).toEqual([["b", "a", "c"]]);
    fixture.calls[0]!.settle();
    await flush();
    expect(fixture.calls.map((call) => JSON.parse(call.body).groupIds)).toEqual([["b", "a", "c"], ["c", "b", "a"]]);
    fixture.calls[1]!.settle();
    await flush();
    expect(orders(dispatch)).toEqual([["b", "a", "c"], ["c", "b", "a"]]);
  });

  it("keeps a newer saved order when an older save fails", async () => {
    const dispatch = vi.fn();
    saveRoomOrder(dispatch, rooms("a", "b", "c"), ["b", "a", "c"]);
    saveRoomOrder(dispatch, rooms("b", "a", "c"), ["c", "b", "a"]);
    await flush();
    fixture.calls[0]!.settle(new Error("offline"));
    await flush();
    fixture.calls[1]!.settle();
    await flush();
    // The second order is what the server now holds, so nothing older is put back.
    expect(orders(dispatch)).toEqual([["b", "a", "c"], ["c", "b", "a"], ["c", "b", "a"]]);
    expect(dispatch).toHaveBeenCalledWith({ type: "error", message: "offline" });
  });

  it("puts back the order the server last confirmed when the last save fails", async () => {
    const dispatch = vi.fn();
    saveRoomOrder(dispatch, rooms("a", "b", "c"), ["b", "a", "c"]);
    saveRoomOrder(dispatch, rooms("b", "a", "c"), ["c", "b", "a"]);
    await flush();
    fixture.calls[0]!.settle();
    await flush();
    fixture.calls[1]!.settle(new Error("offline"));
    await flush();
    expect(orders(dispatch).at(-1)).toEqual(["b", "a", "c"]);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "error", message: "offline" });
  });

  it("puts back only the rooms its saves moved, keeping another list's newer order", async () => {
    const dispatch = vi.fn();
    saveRoomOrder(dispatch, rooms("a", "b", "c", "d"), ["b", "a"]);
    await flush();
    fixture.calls[0]!.settle(new Error("offline"));
    await flush();
    // Only a and b are put back; c and d (another list, maybe reordered by another client meanwhile) are left alone.
    expect(orders(dispatch)).toEqual([["b", "a"], ["a", "b"]]);
  });

  it("does nothing when the order did not change", () => {
    const dispatch = vi.fn();
    saveRoomOrder(dispatch, rooms("a", "b"), ["a", "b"]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
  });
});
