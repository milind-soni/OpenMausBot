import { describe, expect, it, vi } from "vitest";
import { createIncludedXSync } from "./included-x.mjs";

const access = { url: "https://cloud.openmausbot.com/api/cloud/services/x", token: `omb_xd_${"a".repeat(43)}` };
const paid = (deviceId = "device-1") => ({ status: "connected", deviceId, entitlement: { plan: "pro", status: "active", tier: "pro" } });

function sync(fetchAccess = vi.fn(async () => access)) {
  const sent = [];
  return { sent, fetchAccess, x: createIncludedXSync({ fetchAccess, send: (value) => sent.push(value) }) };
}

describe("included X research access on the desktop", () => {
  it("fetches this sign-in's token once the plan is paid, and hands it to the server", async () => {
    const { x, sent, fetchAccess } = sync();
    await x.onState(paid());
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([access]);
  });

  it("does not fetch again on every refresh of the same paid sign-in (a new token would replace the one in use)", async () => {
    const { x, sent, fetchAccess } = sync();
    await x.onState(paid());
    await x.onState(paid());
    await x.onState({ ...paid(), checking: true });
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([access]);
  });

  it("clears the server's token when the plan stops being active, the app signs out or must sign in again", async () => {
    for (const next of [{ ...paid(), entitlement: { plan: "pro", status: "inactive", tier: "pro" } }, { status: "signed-out" }, { status: "reauth-required", message: "expired" },
      { status: "connected", deviceId: "device-1", entitlement: { plan: "free", status: "inactive", tier: null } }]) {
      const { x, sent } = sync();
      await x.onState(paid());
      await x.onState(next);
      expect(sent, JSON.stringify(next)).toEqual([access, null]);
    }
  });

  it("fetches a new token for a new sign-in on this computer", async () => {
    const { x, sent, fetchAccess } = sync();
    await x.onState(paid("device-1"));
    await x.onState(paid("device-2"));
    expect(fetchAccess).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([access, access]);
  });

  it("sends nothing for a free account, and null when the Admin says the plan is not active", async () => {
    const free = sync();
    await free.x.onState({ status: "connected", deviceId: "d", entitlement: { plan: "free", status: "inactive", tier: null } });
    expect(free.sent).toEqual([]);
    expect(free.fetchAccess).not.toHaveBeenCalled();
    const refused = sync(vi.fn(async () => null));
    await refused.x.onState(paid());
    expect(refused.sent).toEqual([null]);
  });

  it("keeps trying on later state changes after a failed fetch, without sending anything for it", async () => {
    const fetchAccess = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(access);
    const { x, sent } = sync(fetchAccess);
    await x.onState(paid());
    expect(sent).toEqual([]);
    await x.onState(paid());
    expect(sent).toEqual([access]);
  });

  it("re-sends the token it holds when the server starts again, and nothing when it holds none", async () => {
    const { x, sent } = sync();
    x.serverStarted();
    expect(sent).toEqual([]);
    await x.onState(paid());
    x.serverStarted();
    expect(sent).toEqual([access, access]);
  });

  it("asks once while a fetch is already under way", async () => {
    let finish;
    const fetchAccess = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { x, sent } = sync(fetchAccess);
    const first = x.onState(paid()), second = x.onState(paid());
    finish(access);
    await Promise.all([first, second]);
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([access]);
  });
});
