import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { describeEdition, editionStatus, entitled, loadEnterpriseLayer } from "./enterprise.ts";

const dirs: string[] = [];

/** A stand-in enterprise layer: the folder shape core looks for, with the given register(). */
function fakeLayer(registerSource: string, file = "index.ts"): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-enterprise-"));
  mkdirSync(join(dir, "server"));
  writeFileSync(join(dir, "server", file), registerSource);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await loadEnterpriseLayer({ dir: join(tmpdir(), "omb-enterprise-absent"), licenseKey: undefined });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("enterprise hook point", () => {
  it("is the open-source edition when the folder is absent, and says so if a key was set anyway", async () => {
    const absent = join(tmpdir(), "omb-enterprise-absent");
    expect(await loadEnterpriseLayer({ dir: absent, licenseKey: undefined })).toEqual({ edition: "oss", features: [] });
    const status = await loadEnterpriseLayer({ dir: absent, licenseKey: "omb1.x.y" });
    expect(status.edition).toBe("oss");
    expect(status.notice).toContain("OMB_LICENSE_KEY is set but no enterprise layer exists");
    expect(entitled("whitelabel")).toBe(false);
    expect(describeEdition(status)).toContain("open-source edition (OMB_LICENSE_KEY is set");
  });

  it("registers the layer's entitlements from the key", async () => {
    const dir = fakeLayer(`export async function register({ licenseKey }) {
      if (licenseKey !== "good") throw new Error("bad key");
      return { customer: "Acme", features: ["sso", "whitelabel", "sso"], expiresAt: "2027-01-01" };
    }`);
    const status = await loadEnterpriseLayer({ dir, licenseKey: "good" });
    expect(status).toEqual({ edition: "enterprise", customer: "Acme", features: ["sso", "whitelabel"], expiresAt: "2027-01-01" });
    expect(editionStatus()).toEqual(status);
    expect(entitled("whitelabel")).toBe(true);
    expect(entitled("budgets")).toBe(false);
    expect(describeEdition(status)).toBe("openmausbot enterprise edition for Acme until 2027-01-01: sso, whitelabel");
  });

  it("loads a compiled layer (server/index.js) the way an image ships it", async () => {
    const dir = fakeLayer(`export function register() { return { customer: "Built", features: ["admin"], expiresAt: null }; }`, "index.js");
    const status = await loadEnterpriseLayer({ dir, licenseKey: "k" });
    expect(status).toEqual({ edition: "enterprise", customer: "Built", features: ["admin"], expiresAt: null });
    expect(describeEdition(status)).toBe("openmausbot enterprise edition for Built: admin");
  });

  it("stops granting features the moment the license expires, without a restart", async () => {
    const dir = fakeLayer(`export function register() { return { customer: "Acme", features: ["sso"], expiresAt: "2027-01-01" }; }`);
    await loadEnterpriseLayer({ dir, licenseKey: "k" });
    const before = new Date("2026-12-31T23:59:59Z").getTime();
    const after = new Date("2027-01-01T00:00:00Z").getTime();
    expect(entitled("sso", before)).toBe(true);
    expect(entitled("sso", after)).toBe(false);
    expect(editionStatus(before).edition).toBe("enterprise");
    const lapsed = editionStatus(after);
    expect(lapsed.edition).toBe("oss");
    expect(lapsed.notice).toMatch(/expired on 2027-01-01; renew it/);
  });

  it("degrades to open-source with the layer's own message when the key is refused", async () => {
    const dir = fakeLayer(`export function register() { throw new Error("license expired on 2025-01-01"); }`);
    const status = await loadEnterpriseLayer({ dir, licenseKey: "stale" });
    expect(status.edition).toBe("oss");
    expect(status.notice).toBe("enterprise layer disabled: license expired on 2025-01-01");
    expect(entitled("sso")).toBe(false);
  });

  it("tells the operator when the layer is present but no key is configured", async () => {
    const dir = fakeLayer(`export function register() { return { customer: "x", features: [], expiresAt: null }; }`);
    const status = await loadEnterpriseLayer({ dir, licenseKey: undefined });
    expect(status).toEqual({ edition: "oss", features: [], notice: "enterprise layer present but OMB_LICENSE_KEY is not set" });
  });

  it("refuses a layer that does not honour the contract", async () => {
    const noRegister = fakeLayer(`export const version = 1;`);
    expect((await loadEnterpriseLayer({ dir: noRegister, licenseKey: "k" })).notice).toContain("does not export register()");
    const badShape = fakeLayer(`export function register() { return { customer: "", features: "all" }; }`);
    const status = await loadEnterpriseLayer({ dir: badShape, licenseKey: "k" });
    expect(status.edition).toBe("oss");
    expect(status.notice).toContain("enterprise layer disabled:");
    expect(entitled("all")).toBe(false);
  });
});
