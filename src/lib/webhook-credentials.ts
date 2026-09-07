import type { WebhookCredential } from "./webhooks.js";

const KEY = "omb-webhook-credentials";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

function isCredential(value: unknown): value is WebhookCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return [candidate.endpointUrl, candidate.secret].every(
    (part) => typeof part === "string" && part.length > 0,
  );
}

/** Webhook credentials are returned only when created or rotated. Keep that
 * one-time value in this app's local browser storage so changing tabs or
 * relaunching the desktop app does not force a surprise secret rotation. */
export function loadWebhookCredentials(store: Store): Record<string, WebhookCredential> {
  try {
    const raw = store?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, WebhookCredential] => isCredential(entry[1]))
        .map(([id, credential]) => [id, { endpointUrl: credential.endpointUrl, secret: credential.secret }]),
    );
  } catch {
    return {};
  }
}

export function saveWebhookCredential(store: Store, webhookId: string, credential: WebhookCredential): void {
  const credentials = loadWebhookCredentials(store);
  credentials[webhookId] = credential;
  try {
    store?.setItem(KEY, JSON.stringify(credentials));
  } catch {
    // Storage is best-effort. The credential remains usable for this mount.
  }
}

export function removeWebhookCredential(store: Store, webhookId: string): void {
  const credentials = loadWebhookCredentials(store);
  delete credentials[webhookId];
  try {
    store?.setItem(KEY, JSON.stringify(credentials));
  } catch {
    // A failed cleanup must not block deleting the webhook itself.
  }
}

export function webhookCredentialStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
