import type { WebhookCredential } from "./webhooks.js";

const KEY = "omb-webhook-credentials";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

function isCredential(value: unknown): value is WebhookCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return [candidate.endpointUrl, candidate.secret, candidate.url].every(
    (part) => typeof part === "string" && part.length > 0,
  );
}

/** The server returns a private webhook URL only on create or rotate, so the one-time value is kept here. */
export function loadWebhookCredentials(store: Store): Record<string, WebhookCredential> {
  try {
    const raw = store?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, WebhookCredential] => isCredential(entry[1])),
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
  }
}

export function removeWebhookCredential(store: Store, webhookId: string): void {
  const credentials = loadWebhookCredentials(store);
  delete credentials[webhookId];
  try {
    store?.setItem(KEY, JSON.stringify(credentials));
  } catch {
  }
}

export function webhookCredentialStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
