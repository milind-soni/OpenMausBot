import { t } from "@/lib/i18n";
import { POSTIZ_SERVER } from "../../shared/postiz";

export const POSTIZ_API = "/api/postiz";

/** What the Apps search box matches for the Postiz card. */
export const POSTIZ_SEARCH = "postiz social media posts schedule linkedin instagram facebook tiktok threads bluesky";

/** Where the card sits among the catalog's categories. */
export const POSTIZ_CATALOG_CARD = { slug: POSTIZ_SERVER, categories: ["Social"] };

export function postizHost(address: string): string {
  try { return new URL(address.trim()).host; } catch { return address.trim(); }
}

/** A refusal from the Postiz routes or a key save, in the app's language. */
export function postizErrorText(cause: unknown, address: string): string {
  const body = (cause as { body?: { code?: unknown; error?: unknown } } | null)?.body;
  const code = typeof body?.code === "string" ? body.code : null;
  const host = postizHost(address);
  if (code === "key_rejected") return t("postiz.error.keyRejected");
  if (code === "unreachable") return t("postiz.error.unreachable", { host });
  if (code === "not_postiz") return t("postiz.error.notPostiz", { host });
  if (code === "address") return t("postiz.error.address");
  if (code === "taken") return t("postiz.taken");
  if (typeof body?.error === "string" && body.error) return body.error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** The desktop's credential bridge throws the server's refusal as text: its known sentences map back to their codes. */
export function postizSaveErrorText(cause: unknown, address: string): string {
  const message = cause instanceof Error ? cause.message : "";
  if (/didn't accept this API key/u.test(message) || (cause as { name?: string } | null)?.name === "KeyRejected") return t("postiz.error.keyRejected");
  if (/Couldn't reach a Postiz server/u.test(message)) return t("postiz.error.unreachable", { host: postizHost(address) });
  if (/didn't answer like Postiz/u.test(message)) return t("postiz.error.notPostiz", { host: postizHost(address) });
  return postizErrorText(cause, address);
}
