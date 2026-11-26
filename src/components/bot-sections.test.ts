import { afterEach, describe, expect, it, vi } from "vitest";

const sent: { body: string; timeoutMs?: number; finish: () => void }[] = [];
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: vi.fn((_path: string, init: { body: string; timeoutMs?: number }) =>
    new Promise<void>((resolve) => sent.push({ body: init.body, timeoutMs: init.timeoutMs, finish: resolve }))),
}));
const { saveDepartmentOrder } = await import("./bot-sections");

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
});
