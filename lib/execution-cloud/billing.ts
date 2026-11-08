import { z } from "zod";
import type { StoredCloudProvider } from "../execution-common";
import type { ExecutionCloudProviderStatus } from "../execution-types";

export const BOXD_BILLING_MAX_AGE_MS = 60_000;
export type BoxdBillingBinding = { orgId: string; revision: string; autoTopUpOffConfirmedAt?: number; confirmedBy?: string };
export const boxdBillingReport = z.object({
  source: z.literal("boxd-native-cli"), version: z.literal("0.3.3"), orgId: z.string().min(1).max(200), revision: z.string().uuid(),
  observedAt: z.number().int().nonnegative(), status: z.enum(["available", "unknown"]),
  billingMode: z.enum(["credits", "stripe"]).optional(), currency: z.enum(["EUR", "USD"]).optional(),
  balanceMicro: z.number().int().safe().optional(), accruingMicro: z.number().int().safe().nonnegative().optional(),
}).strict();
export type BoxdBillingReport = z.infer<typeof boxdBillingReport>;
export function matchingBoxdBilling(binding: BoxdBillingBinding | undefined, report: BoxdBillingReport | undefined, now = Date.now()) {
  return Boolean(binding && report && report.source === "boxd-native-cli" && report.version === "0.3.3"
    && report.orgId === binding.orgId && report.revision === binding.revision
    && report.observedAt <= now && now - report.observedAt <= BOXD_BILLING_MAX_AGE_MS);
}
export function nativeBoxdUsage(stored: StoredCloudProvider, now = Date.now()): ExecutionCloudProviderStatus["usage"] {
  const report = stored.nativeBilling;
  const observedAt = report?.observedAt;
  if (!matchingBoxdBilling(stored.boxdBinding, report, now) || report?.status !== "available"
    || report.billingMode !== "credits" || !["EUR", "USD"].includes(report.currency ?? "") || !Number.isSafeInteger(report.balanceMicro) || !Number.isSafeInteger(report.accruingMicro) || report.accruingMicro! < 0) {
    return { status: "unknown", observedAt, source: "boxd-native-cli", error: "Fresh native Boxd credit billing evidence for the configured organization is required" };
  }
  return { status: "available", balance: (report.balanceMicro! - report.accruingMicro!) / 1_000_000, unit: report.currency,
    balanceScope: "credit_wallet", label: "Boxd native credit wallet, less unsettled usage", source: "boxd-native-cli", observedAt };
}
export function boxdAdmissionFailure(stored: StoredCloudProvider | undefined, now = Date.now()): string | undefined {
  if (!stored?.enabled || !stored.sealedKey) return "Boxd provider is disabled or unconfigured";
  if (!stored.boxdBinding?.autoTopUpOffConfirmedAt || !stored.boxdBinding.confirmedBy) return "Owner must confirm automatic top-up is off for the configured Boxd organization";
  const usage = nativeBoxdUsage(stored, now);
  if (usage.status !== "available") return usage.error;
  if (usage.balance! <= 0) return "Boxd prepaid credits are exhausted after unsettled usage; no card charge or Boat switch is authorized";
}
