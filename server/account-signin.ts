// Sign in with your email on a hosted server. The emailed code comes from the
// OpenMausBot control plane (the account service the desktop companion and
// `openmausbot login` already use), and this server decides who is welcome
// with an allow-list its owner controls. The result is an ordinary local
// session, the same thing a pairing code produces, so every gate applies.
//
// Why through the control plane rather than a mail provider per server: a
// self-hoster then needs no email credentials at all; the code arrives from
// accounts.openmausbot.com. The exchange happens server-side, so a browser
// only ever talks to this server, and a server with an empty allow-list does
// not expose the routes.
import { resolveCompanionControlPlaneURL } from "../electron/companion-account-service.mjs";
import { ControlPlaneError, createControlPlaneClient, normalizeAccountEmail, type ControlPlaneClient } from "../electron/control-plane-client.mjs";
import type { Scope } from "./sessions.ts";

/** Who may sign in. `a@b.com` is that address; `@b.com` is everyone at b.com. */
export interface SignInAllowList {
  admins: string[];
  members: string[];
}

export const ADMIN_EMAILS_ENV = "OMB_SIGNIN_EMAILS";
export const MEMBER_EMAILS_ENV = "OMB_SIGNIN_MEMBER_EMAILS";

/** Commas, spaces or newlines between entries; case does not matter. */
export function parseAllowList(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedScopes(rawEmail: string, list: SignInAllowList): Scope[] | null {
  const email = rawEmail.trim().toLowerCase();
  if (!email.includes("@")) return null;
  const matches = (entry: string) => (entry.startsWith("@") ? email.endsWith(entry) && email.length > entry.length : entry === email);
  if (list.admins.some(matches)) return ["admin", "client"];
  if (list.members.some(matches)) return ["client"];
  return null;
}

export function signInEnabled(list: SignInAllowList): boolean {
  return list.admins.length + list.members.length > 0;
}

export type SignInFailure = { ok: false; status: number; error: string };

export interface EmailSignIn {
  enabled(): boolean;
  start(email: string): Promise<{ ok: true } | SignInFailure>;
  verify(email: string, code: string): Promise<{ ok: true; email: string; userId: string; scopes: Scope[] } | SignInFailure>;
}

const NOT_WELCOME: SignInFailure = { ok: false, status: 403, error: "this email is not on this server's sign-in list; ask the server's owner to add it" };

export function createEmailSignIn(options: {
  allow: SignInAllowList | (() => SignInAllowList);
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  client?: ControlPlaneClient;
}): EmailSignIn {
  const env = options.env ?? process.env;
  const allow = () => (typeof options.allow === "function" ? options.allow() : options.allow);
  let client: ControlPlaneClient | null = options.client ?? null;
  const controlPlane = (): ControlPlaneClient => {
    if (client) return client;
    const url = resolveCompanionControlPlaneURL({ isPackaged: true, environment: env });
    if (!url) throw new Error("OMB_CONTROL_PLANE_URL is set but is not an https address");
    client = createControlPlaneClient({ baseURL: url, fetchImpl: options.fetchImpl });
    return client;
  };
  return {
    enabled: () => signInEnabled(allow()),
    async start(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) return { ok: false, status: 400, error: "enter a valid email address" };
      if (!allowedScopes(email, allow())) return NOT_WELCOME;
      try {
        await controlPlane().requestOTP(email);
      } catch (error) {
        return unavailable(error);
      }
      return { ok: true };
    },
    async verify(rawEmail, code) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email || !allowedScopes(email, allow())) return NOT_WELCOME;
      let verified: { accountToken: string; user: { id: string; email: string } };
      try {
        verified = await controlPlane().verifyOTP(email, code);
      } catch (error) {
        // The client refuses a malformed code before any request (status 0);
        // the control plane's own "invalid_otp" is a wrong or expired code.
        if (error instanceof ControlPlaneError && error.code === "invalid_otp" && !error.status) {
          return { ok: false, status: 400, error: "enter the 8-digit code from the email" };
        }
        if (error instanceof ControlPlaneError && error.status === 429) {
          return { ok: false, status: 429, error: "too many attempts; wait a minute and request a new code" };
        }
        if (error instanceof ControlPlaneError && (error.status === 400 || error.status === 401 || error.status === 403)) {
          return { ok: false, status: 401, error: "that code is wrong or has expired; request a new one" };
        }
        return unavailable(error);
      }
      // The account session on the control plane has done its job.
      void controlPlane()
        .signOut(verified.accountToken)
        .catch(() => undefined);
      const scopes = allowedScopes(verified.user.email, allow());
      if (!scopes) return NOT_WELCOME;
      return { ok: true, email: verified.user.email, userId: verified.user.id, scopes };
    },
  };
}

function unavailable(error: unknown): SignInFailure {
  const detail = error instanceof ControlPlaneError ? `${error.code}${error.status ? ` (${error.status})` : ""}` : error instanceof Error ? error.message : String(error);
  return { ok: false, status: 502, error: `the sign-in service could not be reached (${detail}); try again in a moment` };
}
