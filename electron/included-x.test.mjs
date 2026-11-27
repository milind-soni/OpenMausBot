import { describe, expect, it, vi } from "vitest";
import { createDesktopIncludedX, createIncludedXSync } from "./included-x.mjs";

const access = { url: "https://cloud.openmausbot.com/api/cloud/services/x", token: `omb_xd_${"a".repeat(43)}` };
const paid = (deviceId = "device-1") => ({ status: "connected", deviceId, entitlement: { plan: "pro", status: "active", tier: "pro" } });

/** Over a fake clock: `pass(ms)` moves it on and runs the retry wait if it came due. */
function sync(fetchAccess = vi.fn(async () => access)) {
  const sent = [], notes = [], waits = [];
  let clock = 1_800_000_000_000;
  const timers = { set: (work, ms) => { const timer = { work, at: clock + ms, ms }; waits.push(timer); return timer; }, clear: (timer) => { const at = waits.indexOf(timer); if (at >= 0) waits.splice(at, 1); } };
  const pass = async (ms) => {
    clock += ms;
    for (const timer of waits.filter((entry) => entry.at <= clock)) { waits.splice(waits.indexOf(timer), 1); timer.work(); }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { sent, notes, fetchAccess, waits, pass, x: createIncludedXSync({ fetchAccess, send: (value, note) => { sent.push(value); notes.push(note ?? null); }, now: () => clock, random: () => 0.5, timers }) };
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

  it("a change of account with the Admin down: the account before's token doesn't stay with the server", async () => {
    const fetchAccess = vi.fn(async () => access);
    const { x, sent, pass } = sync(fetchAccess);
    await x.onState(paid("device-a"));
    fetchAccess.mockRejectedValueOnce(new Error("offline"));
    await x.onState(paid("device-b"));
    expect(sent).toEqual([access, null]);
    await pass(60_000);
    expect(sent).toEqual([access, null, access]);
  });

  it("sends nothing for a free account, and null when the Admin says the plan is not active", async () => {
    const free = sync();
    await free.x.onState({ status: "connected", deviceId: "d", entitlement: { plan: "free", status: "inactive", tier: null } });
    expect(free.sent).toEqual([]);
    expect(free.fetchAccess).not.toHaveBeenCalled();
    const refused = sync(vi.fn(async () => null));
    await refused.x.onState(paid());
    expect(refused.sent).toEqual([null]);
    expect(refused.notes).toEqual([{ offered: false }]);
  });

  it("after a failed fetch, asks again by itself after a wait that grows (never on each state the sign-in publishes), sending nothing for it", async () => {
    const offline = Object.assign(new Error("offline"), { status: 503 });
    const fetchAccess = vi.fn().mockRejectedValueOnce(offline).mockRejectedValueOnce(offline).mockRejectedValueOnce(Object.assign(new Error("limited"), { status: 429, retryAfter: 900 }))
      .mockResolvedValueOnce(access);
    const { x, sent, waits, pass } = sync(fetchAccess);
    await x.onState(paid());
    expect(sent).toEqual([]);
    for (let i = 0; i < 5; i++) { await pass(10_000); await x.onState(paid()); }
    expect(fetchAccess, "each session refresh in the minute after asks nothing").toHaveBeenCalledTimes(1);
    expect(waits.map((timer) => timer.ms)).toEqual([60_000]);
    await pass(10_000);
    expect(fetchAccess, "the minute is over: asked again").toHaveBeenCalledTimes(2);
    expect(waits.map((timer) => timer.ms), "then after two minutes").toEqual([120_000]);
    await pass(120_000);
    expect(fetchAccess).toHaveBeenCalledTimes(3);
    expect(waits.map((timer) => timer.ms), "the Admin's own Retry-After, longer than the next step, is kept (spread only later)").toEqual([990_000]);
    await pass(989_000); await x.onState(paid());
    expect(fetchAccess).toHaveBeenCalledTimes(3);
    await pass(1_000);
    expect(fetchAccess).toHaveBeenCalledTimes(4);
    expect(sent).toEqual([access]);
    expect(waits).toEqual([]);
  });

  it("never waits more than 5 minutes between asks, and asks at once when the window comes to the front or the sign-in is verified again", async () => {
    const fetchAccess = vi.fn(async () => { throw new Error("offline"); });
    const { x, waits, pass } = sync(fetchAccess);
    await x.onState(paid());
    for (const ms of [60_000, 120_000, 300_000]) { expect(waits.map((timer) => timer.ms)).toEqual([ms]); await pass(ms); }
    expect(waits.map((timer) => timer.ms)).toEqual([300_000]);
    expect(fetchAccess).toHaveBeenCalledTimes(4);
    x.retryNow(); await pass(0);
    expect(fetchAccess, "the window came to the front").toHaveBeenCalledTimes(5);
    expect(waits.map((timer) => timer.ms), "and the count starts again").toEqual([60_000]);
    x.retryNow(); await pass(0);
    expect(fetchAccess).toHaveBeenCalledTimes(6);
    await x.onState({ ...paid(), checking: true }); await x.onState(paid());
    expect(fetchAccess, "verified again after failed reads").toHaveBeenCalledTimes(7);
    await x.onState(paid());
    expect(fetchAccess, "an ordinary refresh asks nothing").toHaveBeenCalledTimes(7);
  });

  it("a sign-in unverified for a while gets its token back once verified again, without asking the Admin for a new one", async () => {
    const { x, sent, fetchAccess } = sync();
    await x.onState(paid());
    await x.onState({ status: "unavailable", message: "verification-expired", deviceId: "device-1" });
    expect(sent, "the server holds nothing meanwhile, as before").toEqual([access, null]);
    await x.onState({ status: "unavailable", message: "unreachable", deviceId: "device-1" });
    await x.onState(paid());
    expect(sent).toEqual([access, null, access]);
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    // A sign-in that ended, another one, or a plan that stopped in between asks again (or not at all).
    for (const between of [{ status: "reauth-required", message: "access-ended", deviceId: "device-1" }, { status: "signed-out" }]) {
      await x.onState({ status: "unavailable", message: "unreachable", deviceId: "device-1" });
      await x.onState(between);
      await x.onState(paid());
    }
    expect(fetchAccess).toHaveBeenCalledTimes(3);
    await x.onState({ status: "unavailable", message: "unreachable", deviceId: "device-1" });
    await x.onState(paid("device-2"));
    expect(fetchAccess).toHaveBeenCalledTimes(4);
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

describe("when the Admin says no to a paid sign-in", () => {
  const versioned = (version) => ({ ...paid(), entitlement: { plan: "pro", status: "active", tier: "pro", version } });

  it("asks once for that sign-in and plan version, not on every refresh, and asks again when the plan changes", async () => {
    const { x, sent, fetchAccess } = sync(vi.fn(async () => null));
    await x.onState(versioned(1));
    await x.onState(versioned(1));
    await x.onState({ ...versioned(1), checking: true });
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([null]);
    fetchAccess.mockResolvedValueOnce(access);
    await x.onState(versioned(2));
    expect(fetchAccess).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([null, access]);
  });

  it("clears the server's not-offered note once the plan stops or the app signs out, so the card offers the way back", async () => {
    const { x, sent, notes } = sync(vi.fn(async () => null));
    await x.onState(versioned(1));
    await x.onState({ status: "signed-out" });
    expect(sent).toEqual([null, null]);
    expect(notes).toEqual([{ offered: false }, null]);
  });

  it("sends nothing for a fetch that ends after the plan stopped, or after another sign-in took over", async () => {
    let finish;
    const fetchAccess = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const lapsed = sync(fetchAccess);
    const asking = lapsed.x.onState(paid());
    await lapsed.x.onState({ status: "signed-out" });
    finish(access);
    await asking;
    expect(lapsed.sent).toEqual([]);
    const other = sync(vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(access));
    const first = other.x.onState(paid("device-1"));
    void other.x.onState(paid("device-2"));
    finish(access);
    await first;
    await vi.waitFor(() => expect(other.fetchAccess).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(other.sent).toEqual([access]));
  });
});

describe("main.mjs's wiring of included X research access", () => {
  it("asks the current sign-in and posts its answer to whichever server is running, re-sending to a restarted one", async () => {
    const posted = [], logged = [];
    let account = null, proc = null;
    const x = createDesktopIncludedX({ account: () => account, server: () => proc, log: (line) => logged.push(line) });
    await x.onState(paid());
    expect(posted).toEqual([]);
    account = { xResearchAccess: vi.fn(async () => null) };
    proc = { postMessage: (message) => posted.push(message) };
    await x.onState(paid("device-2"));
    expect(posted).toEqual([{ type: "openmausbot:included-x", access: null, offered: false }]);
    account.xResearchAccess.mockResolvedValue(access);
    await x.onState(paid("device-3"));
    proc = { postMessage: (message) => posted.push({ restarted: message }) };
    x.serverStarted();
    expect(posted.slice(1)).toEqual([{ type: "openmausbot:included-x", access }, { restarted: { type: "openmausbot:included-x", access } }]);
    proc = { postMessage: () => { throw new Error("port closed"); } };
    x.serverStarted();
    expect(logged).toEqual(["X research access sync failed: port closed"]);
  });
});
