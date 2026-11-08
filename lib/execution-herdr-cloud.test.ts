// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { requireRunningCloudMachine, validateCloudHerdrPlan } from "../runner/cloud-herdr.mjs";

const now = 1_800_000_000_000;
function plan() {
  return {
    schemaVersion: 1, allocationId: "allocation", hostId: "host", provider: "boxd", desktop: "nixos",
    machineId: "machine", machineName: "origin-private",
    name: `origin-boxd-${createHash("sha256").update(JSON.stringify(["allocation", "nixos"])).digest("hex").slice(0, 20)}`,
    issuedAt: now, expiresAt: now + 60_000,
    core: { version: "0.1.18", session: "origin-cloud", user: "origin-runner" },
    remotePrefix: "sudo -n -u origin-runner env -i HOME=/var/lib/origin-runner bash -c",
  };
}
test("desktop leases reject expiry, unbounded renewal, different aliases and root cores before provider access", () => {
  expect(validateCloudHerdrPlan(plan(), now).expiresAt).toBe(now + 60_000);
  for (const patch of [
    { expiresAt: now }, { expiresAt: now + 60_001 }, { issuedAt: now + 10_000 },
    { name: "personal-machine" }, { provider: "boat" },
    { core: { ...plan().core, user: "root" } },
    { remotePrefix: "sudo bash -c" },
  ]) expect(() => validateCloudHerdrPlan({ ...plan(), ...patch }, now)).toThrow();
});
test.each(["stopped", "hibernated", "suspended", "unknown", "starting"])("Boxd %s cannot reach SSH even with an unexpired grant", status => {
  expect(() => requireRunningCloudMachine("boxd", "machine", { id: "machine", status })).toThrow("not confirmed running");
});
test("native provider observations must match the exact allocated machine", () => {
  expect(() => requireRunningCloudMachine("boxd", "machine", { id: "another", status: "running" })).toThrow();
  expect(() => requireRunningCloudMachine("boat", "machine", { sandbox: { id: "machine", state: "archived" } })).toThrow();
  expect(() => requireRunningCloudMachine("boat", "machine", { sandbox: { id: "machine", state: "ready" } })).not.toThrow();
  expect(() => requireRunningCloudMachine("boxd", "machine", { machine: { id: "machine", status: "running" } })).not.toThrow();
});
