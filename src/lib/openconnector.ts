import { t } from "@/lib/i18n";

export const OPENCONNECTOR_API = "/api/openconnector";

/** What the Apps search box matches for the OpenConnector card. */
export const OPENCONNECTOR_SEARCH = "openconnector connector catalog apps actions execute local self-hosted";

export function openConnectorHost(address: string): string {
  try { return new URL(address.trim()).host; } catch { return address.trim(); }
}

/** A refusal from the OpenConnector routes, in the app's language. */
export function openConnectorErrorText(cause: unknown): string {
  const body = (cause as { body?: { code?: unknown; error?: unknown } } | null)?.body;
  const code = typeof body?.code === "string" ? body.code : null;
  if (code === "unreachable") return t("openconnector.error.unreachable");
  if (code === "start_failed") return t("openconnector.error.startFailed");
  if (code === "taken") return t("openconnector.taken");
  if (typeof body?.error === "string" && body.error) return body.error;
  return cause instanceof Error ? cause.message : String(cause);
}
