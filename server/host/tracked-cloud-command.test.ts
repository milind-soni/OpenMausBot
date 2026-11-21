import { describe, expect, it, vi } from "vitest";
import type { HandoffView } from "../coordinator.ts";
import { trackedCloudCommandHost } from "./tracked-cloud-command.ts";

const node = { botId: "fixture-bot", threadId: "fixture-thread" } as HandoffView;
const command = { boxId: "original", processId: "tracked", teamComputerId: "team", expiresAt: Number.MAX_SAFE_INTEGER };

function fixture() {
  let target: { owner: string; teamComputerId: string } | undefined = { owner: "team-owner", teamComputerId: "team" };
  const findBox = vi.fn(async (_owner: string) => "original");
  const status = vi.fn(async () => "synthetic terminal result");
  const held = vi.fn(() => false);
  const host = trackedCloudCommandHost({ target: () => target, findBox, held, status });
  return { host, findBox, status, held, setTarget: (next: typeof target) => { target = next; } };
}

describe("tracked cloud command host", () => {
  it("reads only the originally authorised computer and tracked process", async () => {
    const { host, findBox, status } = fixture();
    expect(host.validateBackground(node, command)).toBeUndefined();
    expect(await host.backgroundStatus(node, command, new AbortController().signal)).toBe("synthetic terminal result");
    expect(findBox).toHaveBeenCalledExactlyOnceWith("team-owner");
    expect(status).toHaveBeenCalledExactlyOnceWith(command, expect.any(AbortSignal));
  });

  it("does not read a replaced box or a computer held by the person", async () => {
    const { host, findBox, status, held } = fixture();
    findBox.mockResolvedValue("replacement");
    await host.backgroundStatus(node, command, new AbortController().signal);
    expect(status).not.toHaveBeenCalled();
    findBox.mockClear();
    held.mockReturnValue(true);
    await host.backgroundStatus(node, command, new AbortController().signal);
    expect(findBox).not.toHaveBeenCalled();
  });

  it("rechecks the association when the computer lookup completes", async () => {
    const { host, findBox, status, setTarget } = fixture();
    findBox.mockImplementationOnce(async () => {
      setTarget({ owner: "other-team-owner", teamComputerId: "other-team" });
      return "original";
    });
    await host.backgroundStatus(node, command, new AbortController().signal);
    expect(host.validateBackground(node, command)).toMatch(/no longer has access/);
    expect(status).not.toHaveBeenCalled();
  });
});
