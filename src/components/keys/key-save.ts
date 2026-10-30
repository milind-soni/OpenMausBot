// Security: secrets are write-only; GET /api/config returns configured flags and, for admins, the last four characters.
import { api, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { keyTestResult } from "@/lib/product-events";
import type { KeyResult } from "@/lib/analytics-allowlist";
import { keyEntry, type KeyId, type KeyTarget, type TestableProvider } from "./key-catalog";

/** Saves one credential where this app keeps it ("" removes it): the desktop's encrypted store when the key has a slot
 * there, so Remove also clears the stored copy its boot migration made, else the server's own config, which on a Cloud
 * home stays outside every bot's box. */
export function saveKey(target: KeyTarget, value: string, firstKey: boolean): Promise<ConfigStatus> {
  return window.ogb?.setCredential && target.slot
    ? window.ogb.setCredential(target.slot, value)
    : api("/api/config", { method: "PUT", body: JSON.stringify(target.patch(value, firstKey)) });
}

export function saveCredential(id: KeyId, value: string, firstKey: boolean): Promise<ConfigStatus> {
  const target = keyEntry(id).target;
  if (!target) return Promise.reject(new Error(`${id} has no key of its own`));
  return saveKey(target, value, firstKey);
}

export function looksLikeKey(value: string): boolean {
  return value.length > 0 && !/\s/.test(value);
}

export function cleanKey(text: string): string {
  const trimmed = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  const quoted = /^(["'`])(.*)\1$/s.exec(trimmed);
  return (quoted ? quoted[2]! : trimmed).trim();
}

/** "treg is working ✓" with the team's balance, or the exact problem the server's check named. */
export function tregVerdict(result: { ok?: unknown; balanceUsd?: unknown; message?: unknown }): string {
  if (result.ok !== true) return typeof result.message === "string" && result.message ? result.message : t("keys.testUnexpected", { status: "?" });
  const balance = typeof result.balanceUsd === "number" ? ` ${t("keys.treg.balance", { balance: `$${result.balanceUsd.toFixed(2)}` })}` : "";
  return `${t("keys.treg.working")}${balance}`;
}

export interface KeyCheck { result: KeyResult; ok: boolean; text: string }

export async function checkKey(provider: TestableProvider): Promise<KeyCheck> {
  const answer = await api("/api/keys/test", { method: "POST", body: JSON.stringify({ provider }) });
  const result = keyTestResult(answer);
  if (answer.check === "treg") return { result, ok: answer.ok === true, text: tregVerdict(answer) };
  if (!answer.ok) {
    const text = answer.reason === "rejected" ? t("keys.testRejected")
      : answer.reason === "unreachable" ? t("keys.testUnreachable")
        : t("keys.testUnexpected", { status: String(answer.status ?? "?") });
    return { result, ok: false, text };
  }
  const outcome = answer.check === "authentication"
    ? answer.freeTier === true ? `${t("keys.testAuthenticated")}\n${t("keys.testFreeTier")}` : t("keys.testAuthenticated")
    : answer.models?.length ? t("keys.testCatalog", { models: answer.models.join(", ") }) : t("keys.testCatalogNoModels");
  return { result, ok: true, text: `${t("keys.testSaved")} ${outcome}` };
}
