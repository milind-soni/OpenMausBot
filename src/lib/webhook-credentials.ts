export interface WebhookCredential {
  endpointUrl: string;
  secret: string;
  /** Capability URL for senders that cannot configure an Authorization header. */
  url: string;
}

const KEY = "omb-webhook-credentials";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

function isCredential(value: unknown): value is WebhookCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return hasLegacyCredentialParts(value) &&
    typeof candidate.url === "string" && candidate.url.length > 0;
}

/** Credentials saved before `url` was required carry only the endpoint and
 * secret. The capability URL is minted from them in the same deterministic
 * format the server uses, so those records keep working — and keep being
 * rewritten on the next save — without a surprise secret rotation. */
function hasLegacyCredentialParts(value: unknown): value is { endpointUrl: string; secret: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return [candidate.endpointUrl, candidate.secret].every(
    (part) => typeof part === "string" && part.length > 0,
  );
}

/** Private webhook URLs are returned only when created or rotated. Keep that
 * one-time value in this app's local browser storage so changing tabs or
 * relaunching the desktop app does not force a surprise secret rotation. */
export function loadWebhookCredentials(store: Store): Record<string, WebhookCredential> {
  try {
    const raw = store?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, value]): [string, WebhookCredential][] => {
        if (isCredential(value)) return [[id, value]];
        if (hasLegacyCredentialParts(value)) {
          return [[id, { ...value, url: `${value.endpointUrl}/${encodeURIComponent(value.secret)}` }]];
        }
        return [];
      }),
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
    // Storage is best-effort. The URL remains usable for this mount.
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
