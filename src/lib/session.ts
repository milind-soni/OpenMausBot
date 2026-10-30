export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: string;
  version: string;
  capabilities: { remoteSessions: true; selfUpdate: "desktop-managed" | "operator"; emailSignIn?: boolean; sharedComputers?: true; cloudHome?: true; cloudTeam?: true };
}

/** A Team Cloud's session: the team and this person's role in it (owner, admin or member). */
export interface TeamSession { id: string; name: string; role: string }

export type SessionState =
  | { kind: "loopback"; trust?: "service" }
  | { kind: "session"; id: string; label: string; email?: string; scopes: string[]; expiresAt: number; cloudGuest?: true; openedThreads?: string[]; reactor?: string; team?: TeamSession }
  | { kind: "unauthenticated"; error: string }
  | { kind: "unreachable"; error: string };

type SessionProfile = { name?: string; email?: string; avatarUrl?: string };

/** The sidebar's "you". The configured profile is the owner's: an admin (the owner on a My Cloud) keeps it, and a Team
 * Cloud already sends each person their own. Anyone else sees their own email, never the owner's name or picture. */
export function profileForSession(profile: SessionProfile | undefined, sessionState: SessionState | null): SessionProfile | undefined {
  if (!sessionState) return undefined;
  if (sessionState.kind !== "session") return sessionState.kind === "loopback" ? profile : undefined;
  if (sessionState.team || sessionState.scopes.includes("admin")) return profile;
  const email = sessionState.email;
  if (!email?.trim()) return undefined;
  return profile?.email?.trim().toLowerCase() === email.trim().toLowerCase() ? profile : { email };
}

export async function readSessionState(fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/session", { credentials: "same-origin" });
  } catch (error) {
    return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await res.json().catch(() => ({}));
  const record = Object(body) as Record<string, unknown>;
  if (res.status === 401 || res.status === 403) {
    return { kind: "unauthenticated", error: typeof record.error === "string" ? record.error : `${res.status}` };
  }
  if (!res.ok) return { kind: "unreachable", error: `${res.status} ${res.statusText}` };
  if (record.kind === "session" && typeof record.id === "string") {
    return {
      kind: "session",
      id: record.id,
      label: typeof record.label === "string" ? record.label : "",
      ...(typeof record.email === "string" ? { email: record.email } : {}),
      scopes: Array.isArray(record.scopes) ? record.scopes.filter((s): s is string => typeof s === "string") : [],
      expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : 0,
      ...(typeof record.reactor === "string" ? { reactor: record.reactor } : {}),
      ...(teamSessionOf(record.team) ? { team: teamSessionOf(record.team)!, openedThreads: Array.isArray(record.openedThreads) ? record.openedThreads.filter((id): id is string => typeof id === "string") : [] } : {}),
      ...(record.cloudGuest === true ? {
        cloudGuest: true as const,
        openedThreads: Array.isArray(record.openedThreads) ? record.openedThreads.filter((id): id is string => typeof id === "string") : [],
      } : {}),
    };
  }
  return record.trust === "service" ? { kind: "loopback", trust: "service" } : { kind: "loopback" };
}

function teamSessionOf(value: unknown): TeamSession | null {
  const team = Object(value) as { id?: unknown; name?: unknown; role?: unknown };
  return typeof team.id === "string" && typeof team.name === "string" && typeof team.role === "string" ? { id: team.id, name: team.name, role: team.role } : null;
}

export const SERVICE_TRUST_REASON = "This server does not treat this computer as its owner. Sign in or pair this browser to continue.";

export function isConnected(state: SessionState | null): boolean {
  return state?.kind === "session" || (state?.kind === "loopback" && state.trust !== "service");
}

export function isOwnerOrAdmin(state: SessionState | null): boolean {
  if (!state) return false;
  return state.kind === "loopback" ? state.trust !== "service" : state.kind === "session" && state.scopes.includes("admin");
}

export function takePairingCodeFromLocation(): string | null {
  const m = /[#&]code=([^&]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

/** A single-use sign-in credential: taken off the address bar and out of history before anything renders, never shown. */
export function takeBrowserSignInFromLocation(): string | null {
  if (!/[#&]signin=/.test(location.hash)) return null;
  const m = /[#&]signin=(omb_pair_[A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  history.replaceState(null, "", location.pathname + location.search);
  return m ? m[1] : null;
}

export const BROWSER_SIGN_IN_FAILED = "This sign-in link has expired or was already used. On My Cloud, choose “Use in your browser” again.";

/** Never trusted on its own; the one-time code still goes to the address itself. */
export function takeInvitedEmailFromLocation(): string | null {
  const params = new URLSearchParams(location.search);
  const email = params.get("email")?.trim().toLowerCase() ?? "";
  if (!email) return null;
  params.delete("email");
  const search = params.toString();
  history.replaceState(null, "", location.pathname + (search ? `?${search}` : "") + location.hash);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

export function defaultDeviceLabel(userAgent: string = navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "Mac" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** A retry with the same id returns the same session, and nobody who merely shares this address can guess it. */
export function newAttemptId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export async function pairWithCode(
  input: { code: string; label: string; attemptId?: string; browser?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: input.code, label: input.label, cookie: true, attemptId: input.attemptId ?? newAttemptId(), ...(input.browser ? { browser: true } : {}) }),
    });
  } catch (error) {
    return { ok: false, error: `could not reach the server (${error instanceof Error ? error.message : String(error)})` };
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true };
  const error = Reflect.get(Object(body), "error");
  return { ok: false, error: typeof error === "string" ? error : `${res.status} ${res.statusText}` };
}

export async function previewBrowserSignIn(credential: string, fetchImpl: typeof fetch = fetch): Promise<{ owner: string } | null> {
  try {
    const res = await fetchImpl("/api/auth/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: credential, browser: true, preview: true }),
    });
    const owner: unknown = Reflect.get(Object(await res.json().catch(() => ({}))), "owner");
    return res.ok && typeof owner === "string" && owner ? { owner } : null;
  } catch {
    return null;
  }
}

export function signInWithBrowserGrant(credential: string, attemptId: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  return pairWithCode({ code: credential, label: defaultDeviceLabel(), attemptId, browser: true }, fetchImpl);
}

export function cloudOwnerOf(session: unknown): string | null {
  const record = Object(session) as { cloudHome?: unknown; owner?: unknown };
  return record.cloudHome === true && typeof record.owner === "string" && record.owner ? record.owner : null;
}

async function postAuth(path: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, error: `could not reach the server (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true };
  const error = Reflect.get(Object(parsed), "error");
  return { ok: false, error: typeof error === "string" ? error : `${res.status} ${res.statusText}` };
}

export function startEmailSignIn(email: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  return postAuth("/api/auth/email/start", { email }, fetchImpl);
}

export function verifyEmailSignIn(input: { email: string; code: string; label: string }, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  return postAuth("/api/auth/email/verify", { email: input.email, code: input.code, label: input.label }, fetchImpl);
}

export function reasonWorthShowing(reason: string | undefined): string | null {
  if (!reason) return null;
  if (/through a proxy|loopback host required|cross-origin request|^40[13]$/i.test(reason)) return null;
  return reason;
}
