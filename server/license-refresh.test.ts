import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editionStatus, entitled, licenseState, loadEnterpriseLayer, refreshLicense } from "./enterprise.ts";
import { LICENSE_REREAD_MS, startLicenseRefresh } from "./license-source.ts";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A stand-in layer: a key is `lic:` and the licence as JSON; anything else is refused the way a forged key is. */
function fakeLayer(): string {
  const dir = temp("omb-license-layer-");
  mkdirSync(join(dir, "server"));
  writeFileSync(join(dir, "server", "index.js"), `export function register({ licenseKey }) {
    if (!licenseKey.startsWith("lic:")) throw new Error("OMB_LICENSE_KEY signature does not match any OpenMausBot signing key");
    return JSON.parse(licenseKey.slice(4));
  }`);
  return dir;
}

const licence = (customer: string, extra: Record<string, unknown> = {}) =>
  `lic:${JSON.stringify({ customer, features: ["budgets"], expiresAt: "2027-01-01", ...extra })}`;
const at = (iso: string) => new Date(iso).getTime();
const DAY_MS = 24 * 60 * 60_000;

let layer: string;
let data: string;
const log = vi.fn<(line: string) => void>();

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
  it("reads <data>/license.key before OMB_LICENSE_KEY, and the environment when there is no file", async () => {
    writeFileSync(join(data, "license.key"), `${licence("From file", { seats: 20, plan: "business-server" })}\r\n`);
    const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") });
    expect(status).toEqual({ edition: "enterprise", customer: "From file", features: ["budgets"], expiresAt: "2027-01-01" });
    expect(licenseState()).toMatchObject({ valid: true, source: "file", customer: "From file", plan: "business-server", seats: 20 });

    rmSync(join(data, "license.key"));
    expect((await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") })).customer).toBe("From env");
    expect(licenseState()).toMatchObject({ valid: true, source: "env", plan: null, seats: null });

    // An emptied file is no licence: the environment's is used.
    writeFileSync(join(data, "license.key"), "\n");
    expect((await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") })).customer).toBe("From env");
  });

  it("at start, a broken file falls back to the environment's key and says so in one line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(data, "license.key"), "pasted the wrong thing");
      const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("From env") });
      expect(status.customer).toBe("From env");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toBe(
        `the licence in ${join(data, "license.key")} was refused: OMB_LICENSE_KEY signature does not match any OpenMausBot signing key; using OMB_LICENSE_KEY instead`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("at start, a broken file with nothing else is the open-source edition with a notice, never a crash", async () => {
    writeFileSync(join(data, "license.key"), "omb1.forged.key");
    const status = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    expect(status.edition).toBe("oss");
    expect(status.notice).toBe(`enterprise layer disabled: the licence in ${join(data, "license.key")} was refused: OMB_LICENSE_KEY signature does not match any OpenMausBot signing key`);
    expect(licenseState()).toMatchObject({ valid: false, source: null, plan: null, notice: status.notice });
  });
});

describe("reading the licence again while the server runs", () => {
  it("picks up a pasted licence on the hourly read, without a restart, on a server that started without one", async () => {
    const before = await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    expect(before).toEqual({ edition: "oss", features: [], notice: "enterprise layer present but OMB_LICENSE_KEY is not set" });
    let last: Promise<unknown> = Promise.resolve();
    const refresh = startLicenseRefresh({ dataDir: data, platform: "darwin", refresh: () => (last = refreshLicense(log)) });
    try {
      writeFileSync(join(data, "license.key"), licence("Pasted", { seats: 20 }));
      await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS - 1);
      await last;
      expect(entitled("budgets")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await last;
      expect(entitled("budgets")).toBe(true);
      expect(licenseState()).toMatchObject({ valid: true, source: "file", customer: "Pasted", seats: 20 });
      expect(log).toHaveBeenCalledWith("licence changed: openmausbot enterprise edition for Pasted until 2027-01-01: budgets");
    } finally {
      refresh.stop();
    }
  });

  it("on Linux, reads it again soon after license.key changes, and ignores the folder's other files", async () => {
    writeFileSync(join(data, "license.key"), licence("First", { seats: 20 }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const watched = { on: () => watched, unref: () => watched, close: vi.fn() };
    const refreshed = vi.fn<() => Promise<unknown>>();
    let last: Promise<unknown> = Promise.resolve();
    refreshed.mockImplementation(() => (last = refreshLicense(log)));
    const refresh = startLicenseRefresh({
      dataDir: data, platform: "linux", refresh: refreshed,
      watch: (dir, onChange) => { expect(dir).toBe(data); listener = onChange; return watched as unknown as FSWatcher; },
    });
    try {
      listener!("change", "messages.db");
      listener!("rename", null);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(refreshed).not.toHaveBeenCalled();
      // The connector writes a renewed licence: a write and a rename, read once after they settle.
      writeFileSync(join(data, "license.key"), licence("First", { seats: 25, expiresAt: "2027-02-01" }));
      listener!("change", "license.key");
      listener!("rename", "license.key");
      await vi.advanceTimersByTimeAsync(999);
      expect(refreshed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await last;
      expect(refreshed).toHaveBeenCalledTimes(1);
      expect(licenseState()).toMatchObject({ valid: true, seats: 25, expiresAt: "2027-02-01" });
    } finally {
      refresh.stop();
    }
    expect(watched.close).toHaveBeenCalled();
  });

  it("never drops the licence in force for a broken or missing file, logs it once, and keeps it until its grace ends", async () => {
    writeFileSync(join(data, "license.key"), licence("Good"));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: licence("Env key", { expiresAt: "2027-06-01" }) });
    expect(licenseState().source).toBe("file");

    writeFileSync(join(data, "license.key"), "half a licence");
    await refreshLicense(log);
    await refreshLicense(log);
    expect(editionStatus()).toMatchObject({ edition: "enterprise", customer: "Good" });
    expect(entitled("budgets")).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(
      `the licence in ${join(data, "license.key")} was refused: OMB_LICENSE_KEY signature does not match any OpenMausBot signing key; keeping the licence in force until it expires`,
    );

    rmSync(join(data, "license.key"));
    await refreshLicense(log);
    expect(editionStatus().customer).toBe("Good"); // nor the environment's key: the file's licence stays in force
    expect(log).toHaveBeenLastCalledWith(`no licence in ${join(data, "license.key")} any more; keeping the licence in force until it expires`);

    // Past its grace the kept licence stops on its own; the next read then falls back to the environment's key.
    vi.setSystemTime(at("2027-01-01T00:00:00Z") + 14 * DAY_MS);
    expect(entitled("budgets")).toBe(false);
    expect(editionStatus().edition).toBe("oss");
    await refreshLicense(log);
    expect(licenseState()).toMatchObject({ source: "env", customer: "Env key" });
  });

  it("swaps in a valid new file at once, seats and plan included", async () => {
    writeFileSync(join(data, "license.key"), licence("Acme", { seats: 20, plan: "business-server", sub: "sub_1", server: "srv_1" }));
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    writeFileSync(join(data, "license.key"), licence("Acme", { seats: 30, plan: "business-server", expiresAt: "2027-03-01" }));
    await refreshLicense(log);
    expect(licenseState()).toMatchObject({ valid: true, seats: 30, expiresAt: "2027-03-01" });
  });
});

describe("the licence state the owner's Settings reads", () => {
  it("counts the 14 days of grace to the millisecond with an injected clock, and holds no key material", async () => {
    writeFileSync(join(data, "license.key"), licence("Acme", { seats: 20, plan: "business-server", sub: "sub_1", server: "srv_1" }));
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
    expect(lastMoment.notice).toContain("keep working until 2027-01-15");
    const over = licenseState(expiry + 14 * DAY_MS);
    expect(over).toMatchObject({ valid: false, source: "file", expiresAt: "2027-01-01", features: [], graceDaysLeft: 0 });
    expect(over.notice).toMatch(/expired on 2027-01-01; renew it/);
    for (const state of [before, over]) {
      const text = JSON.stringify(state);
      expect(text).not.toContain("lic:");
      expect(text).not.toContain("sub_1");
      expect(text).not.toContain("srv_1");
    }
  });
});
