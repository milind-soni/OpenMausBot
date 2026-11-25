import { describe, expect, it, vi } from "vitest";

import { parseBrowserLiveAction, RequestOnce } from "./live-action.ts";

describe("a dropdown list's choice", () => {
  it("names the list the view drew and an option of it", () => {
    expect(parseBrowserLiveAction({ type: "select_choose", id: "0b8c-41f2", index: 3 })).toEqual({ type: "select", id: "0b8c-41f2", index: 3 });
  });
  it.each([
    { type: "select_choose", id: "x", index: -1 }, { type: "select_choose", id: "x", index: 1.5 }, { type: "select_choose", id: "x", index: 500 },
    { type: "select_choose", id: "", index: 0 }, { type: "select_choose", id: "a b", index: 0 }, { type: "select_choose", id: "x".repeat(65), index: 0 },
    { type: "select_choose", index: 0 },
  ])("refuses %j", (body) => {
    expect(() => parseBrowserLiveAction(body)).toThrow("Invalid browser action.");
  });
});

describe("a repeated input request", () => {
  it("runs once per view, its repeat answered as the first was, even while the first still runs", async () => {
    const requests = new RequestOnce();
    let finish!: (value: unknown) => void;
    const work = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = requests.run("view-a", { type: "input_mouse", requestId: 7 }, work);
    const repeat = requests.run("view-a", { type: "input_mouse", requestId: 7 }, work);
    finish({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(repeat).resolves.toEqual({ ok: true });
    await expect(requests.run("view-a", { requestId: 7 }, work)).resolves.toEqual({ ok: true });
    expect(work).toHaveBeenCalledOnce();
  });
  it("keeps views apart, and runs requests without a number every time", async () => {
    const requests = new RequestOnce();
    const work = vi.fn(async () => ({ ok: true }));
    await requests.run("view-a", { requestId: 1 }, work);
    await requests.run("view-b", { requestId: 1 }, work);
    await requests.run("view-a", { type: "ack", seq: 4 }, work);
    await requests.run("view-a", { type: "ack", seq: 4 }, work);
    expect(work).toHaveBeenCalledTimes(4);
  });
  it("runs again a request refused before it ran, and forgets a closed view's requests", async () => {
    const requests = new RequestOnce();
    const busy = Object.assign(new Error("Too many browser actions are pending."), { status: 429 });
    const work = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue({ ok: true });
    await expect(requests.run("view-a", { requestId: 2 }, work)).rejects.toBe(busy);
    await expect(requests.run("view-a", { requestId: 2 }, work)).resolves.toEqual({ ok: true });
    requests.forget("view-a");
    await expect(requests.run("view-a", { requestId: 2 }, work)).resolves.toEqual({ ok: true });
    expect(work).toHaveBeenCalledTimes(3);
  });
  it("answers a repeat of a failed request with the same failure, without running it again", async () => {
    const requests = new RequestOnce();
    const refused = Object.assign(new Error("Browser control changed. Try again."), { status: 409 });
    const work = vi.fn().mockRejectedValue(refused);
    await expect(requests.run("view-a", { requestId: 3 }, work)).rejects.toBe(refused);
    await expect(requests.run("view-a", { requestId: 3 }, work)).rejects.toBe(refused);
    expect(work).toHaveBeenCalledOnce();
  });
});
