import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editionStatus, entitled, issuedOrder, licenseRefreshWanted, licenseServerRefusal, licenseState, loadEnterpriseLayer, refreshLicense } from "./enterprise.ts";
import { LICENSE_CHECK_MS, LICENSE_MIN_GAP_MS, LICENSE_REREAD_MS, licensePlace, startLicenseRefresh } from "./license-source.ts";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A stand-in layer: a key is `lic:` and the licence as JSON; anything else is refused the way a forged key is, and a
 * licence past its grace the way the real layer refuses it. */
function fakeLayer(): string {
  const dir = temp("omb-license-layer-");
  mkdirSync(join(dir, "server"));
  writeFileSync(join(dir, "server", "index.js"), `export function register({ licenseKey, graceDays }) {
    if (!licenseKey.startsWith("lic:")) throw new Error("OMB_LICENSE_KEY signature does not match any OpenMausBot signing key");
    const claims = JSON.parse(licenseKey.slice(4));
    if (claims.expiresAt && Date.now() >= Date.parse(claims.expiresAt) + graceDays * 86400000) throw new Error("OMB_LICENSE_KEY expired on " + claims.expiresAt);
    return claims;
  }`);
  return dir;
}

const licence = (customer: string, extra: Record<string, unknown> = {}) =>
  `lic:${JSON.stringify({ customer, features: ["budgets"], expiresAt: "2027-01-01", issued: "2026-11-01", ...extra })}`;
const at = (iso: string) => new Date(iso).getTime();
const DAY_MS = 24 * 60 * 60_000;

let layer: string;
let data: string;
const log = vi.fn<(line: string) => void>();
const keyFile = () => join(data, "license.key");
/** The minute check's view of license.key, without real file timestamps. */
const contents = async () => { try { return readFileSync(keyFile(), "utf8"); } catch { return "absent"; } };
const lastGood = () => join(data, "license.last-good");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(at("2026-12-01T00:00:00Z"));
  layer = fakeLayer();
  data = temp("omb-license-data-");
  log.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await loadEnterpriseLayer({ dir: join(tmpdir(), "omb-enterprise-absent"), licenseKey: undefined });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("where the licence is read from", () => {
  it("reads <data>/license.key and OMB_LICENSE_KEY, the file winning a tie, and keeps a copy of the one accepted", async () => {
    writeFileSync(keyFile(), `${licence("From file", { seats: 20, plan: "business-server" })}\r\n`);
    const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") });
    expect(status).toEqual({ edition: "enterprise", customer: "From file", features: ["budgets"], expiresAt: "2027-01-01" });
    expect(licenseState()).toMatchObject({ valid: true, source: "file", customer: "From file", plan: "business-server", seats: 20 });
    expect(readFileSync(lastGood(), "utf8").trim()).toBe(licence("From file", { seats: 20, plan: "business-server" }));
    if (process.platform !== "win32") expect(statSync(lastGood()).mode & 0o777).toBe(0o600);

    rmSync(keyFile());
    rmSync(lastGood());
    expect((await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") })).customer).toBe("From env");
    expect(licenseState()).toMatchObject({ valid: true, source: "env", plan: null, seats: null });
  });

  it("at start, a broken file falls back to the environment's key and says so in one line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(keyFile(), "pasted the wrong thing");
      const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") });
      expect(status.customer).toBe("From env");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toBe(
        `the licence in ${keyFile()} was refused: OMB_LICENSE_KEY signature does not match any OpenMausBot signing key; using OMB_LICENSE_KEY instead`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("at start, a broken file with nothing else is the open-source edition with a notice, never a crash", async () => {
    writeFileSync(keyFile(), "omb1.forged.key");
    const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    expect(status.edition).toBe("oss");
    expect(status.notice).toBe(`enterprise layer disabled: the licence in ${keyFile()} was refused: OMB_LICENSE_KEY signature does not match any OpenMausBot signing key`);
    expect(licenseState()).toMatchObject({ valid: false, source: null, plan: null, notice: status.notice });
  });

  it("at start, the licence issued last wins: a file in its grace never beats a newer environment key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.setSystemTime(at("2027-01-05T00:00:00Z"));
      writeFileSync(keyFile(), licence("Old file", { issued: "2026-10-01", expiresAt: "2027-01-01" }));
      const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("New env", { issued: "2026-12-01", expiresAt: "2027-02-01" }) });
      expect(status.customer).toBe("New env");
      expect(licenseState()).toMatchObject({ valid: true, source: "env", graceDaysLeft: null });
      expect(String(warn.mock.calls[0]?.[0])).toBe(`the licence in ${keyFile()} was issued before the one in OMB_LICENSE_KEY; using OMB_LICENSE_KEY instead`);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the kept copy: a restart keeps a licence still in its paid period", () => {
  it("keeps the licence through a restart with a truncated file", async () => {
    writeFileSync(keyFile(), licence("Paid", { seats: 20 }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    truncateSync(keyFile(), 9);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restarted = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
      expect(restarted).toMatchObject({ edition: "enterprise", customer: "Paid" });
      expect(licenseState()).toMatchObject({ valid: true, source: "last-good", seats: 20 });
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/license\.key was refused: .*; using license\.last-good instead$/);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the licence through a restart with the file deleted, even when the install's environment key went stale", async () => {
    writeFileSync(keyFile(), licence("Renewed", { issued: "2026-11-28", expiresAt: "2027-01-01" }));
    const stale = licence("Install key", { issued: "2026-10-01", expiresAt: "2026-11-15" });
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: stale });
    rmSync(keyFile());
    expect(await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: stale })).toMatchObject({ edition: "enterprise", customer: "Renewed" });
    expect(licenseState().source).toBe("last-good");
    expect(licenseRefreshWanted()).toBe(true);
  });

  it("gains nothing from a forged kept copy", async () => {
    writeFileSync(lastGood(), "omb1.forged.copy\n");
    const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    expect(status.edition).toBe("oss");
    expect(status.notice).toContain(`the licence in ${lastGood()} was refused`);
    expect(entitled("budgets")).toBe(false);
  });
});

describe("reading the licence again while the server runs", () => {
  it("is started only with a layer, a data folder and a licence at start", async () => {
    expect((await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined })).notice)
      .toBe("enterprise layer present but there is no licence: neither license.key nor OMB_LICENSE_KEY is set");
    expect(licenseRefreshWanted()).toBe(false);
    await loadEnterpriseLayer({ dir: layer, licenseKey: licence("Desktop") });
    expect(licenseRefreshWanted()).toBe(false); // no data folder: a desktop or a Cloud home
    await loadEnterpriseLayer({ dir: join(data, "no-layer"), dataDir: data, licenseKey: licence("No layer") });
    expect(licenseRefreshWanted()).toBe(false);
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("Env") });
    expect(licenseRefreshWanted()).toBe(true);
  });

  it("on a server install that started with no licence, loads one written later without a restart", async () => {
    // The bought server's real order: installed first, enrolled, and only then does the connector write the licence.
    expect(await loadEnterpriseLayer({ dir: layer, dataDir: data, serverInstall: true, licenseKey: undefined }))
      .toMatchObject({ edition: "oss" });
    expect(licenseRefreshWanted()).toBe(true);
    let last: Promise<unknown> = Promise.resolve();
    const refresh = startLicenseRefresh({ dataDir: data, refresh: () => (last = refreshLicense(log)), stamp: contents });
    try {
      await vi.advanceTimersByTimeAsync(LICENSE_CHECK_MS * 2);
      expect(entitled("budgets")).toBe(false);
      writeFileSync(keyFile(), licence("Bought", { seats: 20, plan: "business-server" }));
      await vi.advanceTimersByTimeAsync(LICENSE_CHECK_MS + LICENSE_MIN_GAP_MS);
      await last;
      expect(entitled("budgets")).toBe(true);
      expect(licenseState()).toMatchObject({ valid: true, source: "file", customer: "Bought", seats: 20 });
    } finally {
      refresh.stop();
    }
  });

  it("uses licence files on a server install and any other server, never on a desktop, a Cloud home or a hosted workspace", () => {
    const docker = (path: string) => path === "/.dockerenv";
    const nothing = () => false;
    const base = { desktopManaged: false, cloudHome: false, hostedWorkspace: false, serverRoot: join(data, "dist-server"), env: {} };
    expect(licensePlace({ ...base, exists: docker })).toBe("server");
    expect(licensePlace({ ...base, exists: nothing, env: { OMB_PODMAN_SERVICE: "1" } })).toBe("server");
    expect(licensePlace({ ...base, exists: (path) => path === "/run/.containerenv" })).toBe("server");
    expect(licensePlace({ ...base, exists: nothing })).toBe("files");
    for (const where of [{ desktopManaged: true }, { cloudHome: true }, { hostedWorkspace: true }]) {
      expect(licensePlace({ ...base, ...where, exists: docker }), JSON.stringify(where)).toBe("none");
    }
  });

  it("does nothing on a desktop or a Cloud home: no files read or kept, no re-read started", async () => {
    // server/index.ts passes no data folder there (licensePlace "none"), so only OMB_LICENSE_KEY counts, as before.
    writeFileSync(keyFile(), licence("Ignored file"));
    const status = await loadEnterpriseLayer({ dir: layer, licenseKey: licence("Desktop env") });
    expect(status.customer).toBe("Desktop env");
    expect(licenseRefreshWanted()).toBe(false);
    expect(() => readFileSync(lastGood())).toThrow();
    await loadEnterpriseLayer({ dir: layer, licenseKey: undefined });
    expect(licenseRefreshWanted()).toBe(false);
  });

  it("takes a renewed file on the next minute check, and reads hourly besides", async () => {
    writeFileSync(keyFile(), licence("First", { seats: 20 }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    const refreshed = vi.fn<() => Promise<unknown>>();
    let last: Promise<unknown> = Promise.resolve();
    refreshed.mockImplementation(() => (last = refreshLicense(log)));
    const refresh = startLicenseRefresh({ dataDir: data, refresh: refreshed, stamp: contents });
    try {
      await vi.advanceTimersByTimeAsync(LICENSE_CHECK_MS * 3);
      expect(refreshed).not.toHaveBeenCalled(); // an unchanged file is not read
      writeFileSync(keyFile(), licence("First", { seats: 25, issued: "2026-11-30", expiresAt: "2027-02-01" }));
      await vi.advanceTimersByTimeAsync(LICENSE_CHECK_MS);
      await last;
      expect(refreshed).toHaveBeenCalledTimes(1);
      expect(licenseState()).toMatchObject({ valid: true, seats: 25, expiresAt: "2027-02-01" });
      expect(log).toHaveBeenCalledWith("licence changed: openmausbot enterprise edition for First until 2027-02-01: budgets");
      await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
      expect(refreshed).toHaveBeenCalledTimes(2);
    } finally {
      refresh.stop();
    }
  });

  it("never reads twice within the minimum gap, however often the file changes", async () => {
    writeFileSync(keyFile(), licence("Busy"));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    const refreshed = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    const refresh = startLicenseRefresh({ dataDir: data, refresh: refreshed, checkMs: 5_000, minGapMs: 30_000, stamp: contents });
    try {
      await vi.advanceTimersByTimeAsync(1);
      for (let round = 0; round < 12; round += 1) {
        writeFileSync(keyFile(), licence("Busy", { seats: round + 1 }));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      // 60 s of changes every 5 s: a read at the first change, one 30 s later, one at 60 s.
      expect(refreshed.mock.calls.length).toBeLessThanOrEqual(3);
      expect(refreshed.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      refresh.stop();
    }
  });

  it("never replaces the licence in force with one issued before it, and logs the refusal once", async () => {
    writeFileSync(keyFile(), licence("Acme", { seats: 30, issued: "2026-11-20" }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    const older = licence("Acme", { seats: 100, issued: "2026-10-20", expiresAt: "2027-06-01" });
    writeFileSync(keyFile(), older);
    await refreshLicense(log);
    await refreshLicense(log);
    expect(licenseState()).toMatchObject({ seats: 30 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(`the licence in ${keyFile()} was issued before the one in license.last-good; using license.last-good instead`);
    // Without the kept copy the older file is the only licence on offer, and still does not replace the one in force.
    rmSync(lastGood());
    await refreshLicense(log);
    expect(licenseState()).toMatchObject({ seats: 30 });
    expect(log).toHaveBeenLastCalledWith(`the licence in ${keyFile()} was issued before the one in force; keeping the licence in force until it expires`);
    // Once the licence in force is past its grace, an older licence still valid is better than none.
    vi.setSystemTime(at("2027-01-01T00:00:00Z") + 14 * DAY_MS);
    await refreshLicense(log);
    expect(licenseState()).toMatchObject({ valid: true, seats: 100 });
  });

  it("orders the same day's licences by iat when both carry it, else takes the reissue (expiry breaks a tie)", async () => {
    writeFileSync(keyFile(), licence("Acme", { seats: 20, issued: "2026-11-27", iat: 2_000 }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    writeFileSync(keyFile(), licence("Acme", { seats: 10, issued: "2026-11-27", iat: 1_000 }));
    await refreshLicense(log);
    expect(licenseState().seats).toBe(20);
    writeFileSync(keyFile(), licence("Acme", { seats: 25, issued: "2026-11-27", iat: 3_000 }));
    await refreshLicense(log);
    expect(licenseState().seats).toBe(25);
    writeFileSync(keyFile(), licence("Acme", { seats: 30, issued: "2026-11-27" }));
    await refreshLicense(log);
    expect(licenseState().seats).toBe(30);
    expect(issuedOrder({ issued: "2026-11-27", expiresAt: "2027-01-01" }, { issued: "2026-11-27", expiresAt: "2026-12-30" })).toBe(1);
    expect(issuedOrder({ issued: "2026-11-27", expiresAt: null }, { issued: "2026-11-27", expiresAt: "2099-01-01" })).toBe(1);
    expect(issuedOrder({ issued: "2026-11-27", iat: 5, expiresAt: "2026-12-01" }, { issued: "2026-11-27", iat: 9, expiresAt: "2027-12-01" })).toBe(-1);
    expect(issuedOrder({ issued: "2026-11-28", expiresAt: "2026-12-01" }, { issued: "2026-11-27", expiresAt: "2027-12-01" })).toBe(1);
  });

  it("never drops the licence in force for a broken or missing file, logs it once, and keeps it until its grace ends", async () => {
    writeFileSync(keyFile(), licence("Good"));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    writeFileSync(keyFile(), "half a licence");
    await refreshLicense(log);
    await refreshLicense(log);
    expect(editionStatus()).toMatchObject({ edition: "enterprise", customer: "Good" });
    expect(entitled("budgets")).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(
      `the licence in ${keyFile()} was refused: OMB_LICENSE_KEY signature does not match any OpenMausBot signing key; using license.last-good instead`,
    );
    rmSync(keyFile());
    rmSync(lastGood());
    await refreshLicense(log);
    expect(editionStatus().customer).toBe("Good");
    expect(log).toHaveBeenLastCalledWith(`no licence in ${keyFile()} any more; keeping the licence in force until it expires`);
    // Past its grace the kept licence stops on its own.
    vi.setSystemTime(at("2027-01-01T00:00:00Z") + 14 * DAY_MS);
    expect(entitled("budgets")).toBe(false);
    expect(editionStatus().edition).toBe("oss");
  });

  it("logs once when the server's clock is more than a day before the licence's issue date", async () => {
    vi.setSystemTime(at("2026-10-01T00:00:00Z"));
    writeFileSync(keyFile(), licence("Future", { issued: "2026-11-01" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
      await refreshLicense(log);
      const lines = [...warn.mock.calls, ...log.mock.calls].map((call) => String(call[0])).filter((line) => line.includes("clock"));
      expect(lines).toEqual(["this server's clock says 2026-10-01T00:00:00.000Z, before the licence was issued (2026-11-01): set the clock right, or the licence's dates are judged wrongly"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("carries a licence's server id without checking it; the check, when switched on, refuses only a real mismatch", () => {
    expect(licenseServerRefusal("srv_1", "srv_2")).toBeNull();
    expect(licenseServerRefusal("srv_1", "srv_2", true)).toBe("the licence was issued for server srv_1, not this one");
    expect(licenseServerRefusal("srv_1", "srv_1", true)).toBeNull();
    expect(licenseServerRefusal(undefined, "srv_2", true)).toBeNull();
    expect(licenseServerRefusal("srv_1", undefined, true)).toBeNull();
  });
});

describe("the licence state the owner's Settings reads", () => {
  it("counts the 14 days of grace to the millisecond with an injected clock, and holds no key material", async () => {
    writeFileSync(keyFile(), licence("Acme", { seats: 20, plan: "business-server", sub: "sub_1", server: "srv_1" }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    const expiry = at("2027-01-01T00:00:00Z");
    const before = licenseState(expiry - 1);
    expect(before).toEqual({
      valid: true, source: "file", customer: "Acme", plan: "business-server", seats: 20, features: ["budgets"],
      expiresAt: "2027-01-01", expiresInDays: 1, graceEndsAt: "2027-01-15", graceDaysLeft: null, notice: null,
    });
    expect(licenseState(expiry)).toMatchObject({ valid: true, graceDaysLeft: 14 });
    const lastMoment = licenseState(expiry + 14 * DAY_MS - 1);
    expect(lastMoment).toMatchObject({ valid: true, features: ["budgets"], graceDaysLeft: 1 });
    expect(lastMoment.notice).toBe("license.key expired on 2027-01-01; enterprise features keep working until 2027-01-15 while it is renewed");
    const over = licenseState(expiry + 14 * DAY_MS);
    expect(over).toMatchObject({ valid: false, source: "file", expiresAt: "2027-01-01", features: [], graceDaysLeft: 0 });
    expect(over.notice).toBe("enterprise layer disabled: license.key expired on 2027-01-01; renew it to keep enterprise features");
    for (const state of [before, over]) {
      const text = JSON.stringify(state);
      expect(text).not.toContain("lic:");
      expect(text).not.toContain("sub_1");
      expect(text).not.toContain("srv_1");
    }
  });
});
