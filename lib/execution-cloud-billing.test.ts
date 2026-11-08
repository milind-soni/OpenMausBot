// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { acceptExecutionControllerTick, executionControllerBillingContext } from "./execution-controller";
import { executionDb, executionSetting, executionTokenHash, setExecutionSetting } from "./execution-store";
import type { StoredCloudProvider } from "./execution-common";
import { boxdAdmissionFailure, nativeBoxdUsage } from "./execution-cloud/billing";

vi.mock("./execution-cloud-runtime", () => ({ maintainCloudExecution: vi.fn(), cloudExecutionStopProof: vi.fn() }));
vi.mock("./github-execution", () => ({ finalizeRunPullRequest: vi.fn(), readRunDeployment: vi.fn(), reconcileMergedRunPullRequest: vi.fn() }));
const now = Date.UTC(2026, 10, 8, 12), token = "controller-fixture-token-".repeat(3);
const revision = "e9f4f673-34f1-44e8-a0a8-0b2a5c005baf";
let directory: string, provider: StoredCloudProvider;
beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), "origin-cloud-billing-")); vi.stubEnv("ORIGIN_LOCAL_DATA_DIR", directory); });
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("ORIGIN_EXECUTION_TEAM_ID", "team");
  vi.stubEnv("ORIGIN_EXECUTION_CONTROLLER_TOKEN_HASH", executionTokenHash(token));
  executionDb().exec("DELETE FROM execution_settings");
  provider = { provider: "boxd", enabled: true, sealedKey: "fixture-sealed", keyConfigured: true, updatedAt: now, usage: { status: "unknown" },
    boxdBinding: { orgId: "org", revision, autoTopUpOffConfirmedAt: now, confirmedBy: "owner" },
    nativeBilling: { source: "boxd-native-cli", version: "0.3.3", orgId: "org", revision, observedAt: now, status: "available", billingMode: "credits", currency: "EUR", balanceMicro: 50_000_000, accruingMicro: 438 } };
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { executionDb().close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

test.each(["EUR", "USD"] as const)("native prepaid admission preserves %s and subtracts unsettled usage without FX", currency => {
  provider.nativeBilling!.currency = currency;
  expect(nativeBoxdUsage(provider, now)).toMatchObject({ status: "available", unit: currency, balance: 49.999562, source: "boxd-native-cli", observedAt: now });
  expect(boxdAdmissionFailure(provider, now)).toBeUndefined();
});
test.each(["missing", "expired", "future", "org", "revision", "unknown", "subscription", "exhausted", "unsettled", "consent", "disabled"])("%s native billing fails closed", scenario => {
  if (scenario === "missing") provider.nativeBilling = undefined;
  else if (scenario === "expired") provider.nativeBilling!.observedAt = now - 60_001;
  else if (scenario === "future") provider.nativeBilling!.observedAt = now + 1;
  else if (scenario === "org") provider.nativeBilling!.orgId = "other-org";
  else if (scenario === "revision") provider.nativeBilling!.revision = "c0b43870-20a4-46aa-b3fa-b57349425b28";
  else if (scenario === "unknown") provider.nativeBilling!.status = "unknown";
  else if (scenario === "subscription") provider.nativeBilling!.billingMode = "stripe";
  else if (scenario === "exhausted") provider.nativeBilling!.balanceMicro = 0;
  else if (scenario === "unsettled") provider.nativeBilling!.accruingMicro = 50_000_001;
  else if (scenario === "consent") provider.boxdBinding!.autoTopUpOffConfirmedAt = undefined;
  else if (scenario === "disabled") provider.enabled = false;
  expect(boxdAdmissionFailure(provider, now)).toEqual(expect.any(String));
});
test("controller context requires authentication and exposes only the key-bound organization and revision", () => {
  setExecutionSetting("team", "cloud", "boxd", provider);
  expect(() => executionControllerBillingContext("wrong")).toThrow();
  expect(executionControllerBillingContext(token)).toEqual({ orgId: "org", revision });
  expect(JSON.stringify(executionControllerBillingContext(token))).not.toContain("fixture-sealed");
});
test("authenticated tick stores matching native evidence but ignores another org, replaced key and stale replay", () => {
  const report = provider.nativeBilling!;
  provider.nativeBilling = undefined;
  setExecutionSetting("team", "cloud", "boxd", provider);
  for (const changed of [{ orgId: "other" }, { revision: "c0b43870-20a4-46aa-b3fa-b57349425b28" }, { observedAt: now - 60_001 }, { observedAt: now + 1 }]) {
    acceptExecutionControllerTick(token, { op: "tick", localPresence: [], boxdBilling: { ...report, ...changed } });
    expect(executionSetting<StoredCloudProvider>("team", "cloud", "boxd")!.nativeBilling).toBeUndefined();
  }
  expect(() => acceptExecutionControllerTick("wrong", { op: "tick", localPresence: [], boxdBilling: report })).toThrow();
  acceptExecutionControllerTick(token, { op: "tick", localPresence: [], boxdBilling: report });
  expect(executionSetting<StoredCloudProvider>("team", "cloud", "boxd")!.usage).toMatchObject({ status: "available", balance: 49.999562 });
  acceptExecutionControllerTick(token, { op: "tick", localPresence: [], boxdBilling: { ...report, observedAt: now - 1, balanceMicro: 999999999 } });
  expect(executionSetting<StoredCloudProvider>("team", "cloud", "boxd")!.nativeBilling).toEqual(report);
  acceptExecutionControllerTick(token, { op: "tick", localPresence: [], boxdBilling: { ...report, status: "unknown" } });
  expect(boxdAdmissionFailure(executionSetting<StoredCloudProvider>("team", "cloud", "boxd"), now)).toMatch(/Fresh native/);
});
