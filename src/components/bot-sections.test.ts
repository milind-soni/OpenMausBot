import { afterEach, describe, expect, it, vi } from "vitest";

const sent: { body: string; timeoutMs?: number; finish: () => void; fail: (cause: unknown) => void }[] = [];
let held: string[] = [];
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: vi.fn((path: string, init: { method?: string; body: string; timeoutMs?: number }) =>
    init.method === "PUT"
      ? new Promise<void>((resolve, reject) => sent.push({ body: init.body, timeoutMs: init.timeoutMs, finish: resolve, fail: reject }))
      : Promise.resolve(path === "/api/sidebar-sections" ? { sections: held } : {})),
}));
const { saveDepartmentOrder } = await import("./bot-sections");
const { ApiError } = await import("@/state/store");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => { sent.length = 0; });

describe("saving the department order", () => {
  it("sends two quick moves one after the other, so the later move is the one the server keeps", async () => {
    const dispatch = vi.fn();
    const first = saveDepartmentOrder(dispatch, ["Sales", "Ops", "Legal"], ["Ops", "Sales", "Legal"]);
    const second = saveDepartmentOrder(dispatch, ["Ops", "Sales", "Legal"], ["Legal", "Ops", "Sales"]);
    await settle();
    expect(sent.map(({ body }) => JSON.parse(body).sections)).toEqual([["Ops", "Sales", "Legal"]]);
    sent[0].finish();
    await settle();
    expect(sent.map(({ body }) => JSON.parse(body).sections)).toEqual([["Ops", "Sales", "Legal"], ["Legal", "Ops", "Sales"]]);
    sent[1].finish();
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it("bounds each save, so a save the server never answers cannot hold back the moves after it", async () => {
    const saving = saveDepartmentOrder(vi.fn(), ["Sales", "Ops"], ["Ops", "Sales"]);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].timeoutMs).toBeGreaterThan(0);
    sent[0].finish();
    expect(await saving).toBe(true);
  });

  it("shows the order the server holds after a save that got no answer, since the server may have kept it", async () => {
    held = ["Hidden", "Ops", "Sales", "Legal"];
    const dispatch = vi.fn();
    const saving = saveDepartmentOrder(dispatch, ["Sales", "Ops", "Legal"], ["Ops", "Sales"]);
    await settle();
    sent[0].fail(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await saving).toBe(false);
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error" }));
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "sectionsOrdered", sections: ["Ops", "Sales"] });
  });

  it("reads the order the server holds after a server error too, since the save may have been kept", async () => {
    held = ["Ops", "Sales"];
    const dispatch = vi.fn();
    const saving = saveDepartmentOrder(dispatch, ["Sales", "Ops"], ["Ops", "Sales"]);
    await settle();
    sent[0].fail(new ApiError("Bad Gateway", 502));
    expect(await saving).toBe(false);
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "sectionsOrdered", sections: ["Ops", "Sales"] });
  });

  it("puts the order back after a save the server refused", async () => {
    const dispatch = vi.fn();
    const saving = saveDepartmentOrder(dispatch, ["Sales", "Ops"], ["Ops", "Sales"]);
    await settle();
    sent[0].fail(new ApiError("unknown department: Ops", 400));
    expect(await saving).toBe(false);
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "sectionsOrdered", sections: ["Sales", "Ops"] });
  });
});
