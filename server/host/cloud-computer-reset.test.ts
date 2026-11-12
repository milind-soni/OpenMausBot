import { beforeEach, describe, expect, it, vi } from "vitest";

const listManagedBoats = vi.fn();
const deleteManagedBoat = vi.fn();
vi.mock("../boat.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../boat.ts")>()),
  listManagedBoats: (...args: unknown[]) => listManagedBoats(...args),
  deleteManagedBoat: (...args: unknown[]) => deleteManagedBoat(...args),
}));

const { resetBotCloudComputer } = await import("./cloud-computer-reset.ts");

const cfg = { box: { token: "box_test" } } as any;
const owners = [{ botId: "bot-a", name: "Ada", inUse: false }, { botId: "bot-b", name: "Bea", inUse: false }];
const instance = (boxId: string, ownerBotId: string | null) => ({
  boxId, name: `omb-${boxId}`, state: "starting", ownerBotId, ownerName: null, orphaned: ownerBotId === null, inUse: false,
});

describe("resetting a bot's cloud computer", () => {
  beforeEach(() => {
    listManagedBoats.mockReset();
    deleteManagedBoat.mockReset().mockResolvedValue({ ok: true });
  });

  it("deletes only the bot's own computer, by its listed id and name, through the lifecycle claim", async () => {
    listManagedBoats.mockResolvedValue({
      configured: true, available: true, problem: null,
      instances: [instance("bx_other", "bot-b"), instance("bx_orphan", null), instance("bx_mine", "bot-a")],
    });
    const claim = vi.fn();
    await expect(resetBotCloudComputer(cfg, "bot-a", owners, claim)).resolves.toEqual({ ok: true });
    expect(deleteManagedBoat).toHaveBeenCalledTimes(1);
    expect(deleteManagedBoat).toHaveBeenCalledWith(cfg, owners, "bx_mine", "omb-bx_mine", claim);
  });

  it("has nothing to delete when the bot has no computer yet", async () => {
    listManagedBoats.mockResolvedValue({ configured: true, available: true, problem: null, instances: [instance("bx_other", "bot-b")] });
    await expect(resetBotCloudComputer(cfg, "bot-a", owners, vi.fn())).resolves.toEqual({ ok: true, missing: true });
    expect(deleteManagedBoat).not.toHaveBeenCalled();
  });

  it("deletes nothing when the computer list cannot be read", async () => {
    listManagedBoats.mockResolvedValue({ configured: true, available: false, problem: "Could not reach boat.dev", instances: [] });
    await expect(resetBotCloudComputer(cfg, "bot-a", owners, vi.fn())).rejects.toMatchObject({ message: "Could not reach boat.dev", status: 503 });
    expect(deleteManagedBoat).not.toHaveBeenCalled();
  });

  it("deletes nothing when a different computer runs than the one the person was asked about", async () => {
    listManagedBoats.mockResolvedValue({ configured: true, available: true, problem: null, instances: [instance("bx_new", "bot-a")] });
    for (const expected of ["bx_old", null]) {
      const refused = resetBotCloudComputer(cfg, "bot-a", owners, vi.fn(), expected);
      await expect(refused).rejects.toMatchObject({ status: 409 });
      await expect(refused).rejects.not.toThrow(/in use/i);
    }
    expect(deleteManagedBoat).not.toHaveBeenCalled();
  });

  it("deletes the computer the person was asked about, and treats it gone as reset", async () => {
    listManagedBoats.mockResolvedValue({ configured: true, available: true, problem: null, instances: [instance("bx_mine", "bot-a")] });
    const claim = vi.fn();
    await expect(resetBotCloudComputer(cfg, "bot-a", owners, claim, "bx_mine")).resolves.toEqual({ ok: true });
    expect(deleteManagedBoat).toHaveBeenCalledWith(cfg, owners, "bx_mine", "omb-bx_mine", claim);
    listManagedBoats.mockResolvedValue({ configured: true, available: true, problem: null, instances: [] });
    await expect(resetBotCloudComputer(cfg, "bot-a", owners, vi.fn(), "bx_mine")).resolves.toEqual({ ok: true, missing: true });
  });

  it("passes on the refusal while the bot is working", async () => {
    listManagedBoats.mockResolvedValue({ configured: true, available: true, problem: null, instances: [instance("bx_mine", "bot-a")] });
    deleteManagedBoat.mockRejectedValue(Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 }));
    await expect(resetBotCloudComputer(cfg, "bot-a", owners, vi.fn())).rejects.toMatchObject({ status: 409 });
  });
});
