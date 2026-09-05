// The served web UI's view of its own authentication. On the owner's machine
// the server trusts loopback and none of this is visible; on a remote host
// the browser must hold a session cookie from pairing (see /pair).

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: string;
  version: string;
  capabilities: { remoteSessions: true; selfUpdate: "desktop-managed" | "operator" };
}

export type SessionState =
  | { kind: "loopback" }
  | { kind: "session"; id: string; label: string; scopes: string[]; expiresAt: number }
  | { kind: "unauthenticated"; error: string }
  | { kind: "unreachable"; error: string };

/** Ask the server who we are. A 401/403 means "go pair"; a network failure
 * is reported separately so the pair page can say the server is down. */
export async function readSessionState(fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/session", { credentials: "same-origin" });
  } catch (error) {
    return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await res.json().catch(() => ({}));
  const record = Object(body) as Record<string, unknown>; // SAFETY: read with typeof checks below; never trusted as a shape
  if (res.status === 401 || res.status === 403) {
    return { kind: "unauthenticated", error: typeof record.error === "string" ? record.error : `${res.status}` };
  }
  if (!res.ok) return { kind: "unreachable", error: `${res.status} ${res.statusText}` };
  if (record.kind === "session" && typeof record.id === "string") {
    return {
      kind: "session",
      id: record.id,
      label: typeof record.label === "string" ? record.label : "",
      scopes: Array.isArray(record.scopes) ? record.scopes.filter((s): s is string => typeof s === "string") : [],
      expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : 0,
    };
  }
  return { kind: "loopback" };
}

/** Pull `#code=…` off the URL and out of history, the way a pairing link is meant to be consumed. */
export function takePairingCodeFromLocation(): string | null {
  const m = /[#&]code=([^&]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

/** A default device name, so the sessions list reads "Safari on iPhone" not "Unnamed device". */
export function defaultDeviceLabel(userAgent: string = navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "Mac" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** One random id per pairing attempt. Re-sending the same id after a lost
 * response returns the same session instead of "code already used"; nobody
 * who merely shares this device's address can guess it. */
export function newAttemptId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export async function pairWithCode(
  input: { code: string; label: string; attemptId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: input.code, label: input.label, cookie: true, attemptId: input.attemptId ?? newAttemptId() }),
    });
  } catch (error) {
    return { ok: false, error: `could not reach the server (${error instanceof Error ? error.message : String(error)})` };
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true };
  const error = Reflect.get(Object(body), "error");
  return { ok: false, error: typeof error === "string" ? error : `${res.status} ${res.statusText}` };
}
