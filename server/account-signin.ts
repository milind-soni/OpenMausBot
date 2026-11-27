// Email sign-in through the OpenMausBot control plane, or through the server's own mail server when OMB_SIGNIN_SMTP_URL is
// set: the code exchange is server-side, so a browser only talks to this server, and a server with an empty allow-list
// does not expose the routes. The result is an ordinary local session.
import { resolveCompanionControlPlaneURL } from "../electron/companion-account-service.mjs";
import { ControlPlaneError, createControlPlaneClient, normalizeAccountEmail, type ControlPlaneClient } from "../electron/control-plane-client.mjs";
import type { Scope } from "./sessions.ts";
import { createSignInMail, SignInMailError, type MailTransport, type SignInMail } from "./sign-in-mail.ts";
import { userError, type UserError } from "./user-errors.ts";

/** Who may sign in. `a@b.com` is that address; `@b.com` is everyone at b.com. */
export interface SignInAllowList {
  admins: string[];
  members: string[];
}

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

export type SignInFailure = { ok: false; status: number } & UserError;

export interface EmailSignIn {
  enabled(): boolean;
  /** `target`: the host the code signs in to, for the email's subject. */
  start(email: string, target?: string | null): Promise<{ ok: true } | SignInFailure>;
  verify(email: string, code: string): Promise<{ ok: true; email: string; userId: string; scopes: Scope[] } | SignInFailure>;
}

const NOT_WELCOME: SignInFailure = { ok: false, status: 403, ...userError("serverError.email.notAllowed") };

export function createEmailSignIn(options: {
  allow: SignInAllowList | (() => SignInAllowList);
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  client?: ControlPlaneClient;
  mailTransport?: MailTransport;
}): EmailSignIn {
  const env = options.env ?? process.env;
  const allow = () => (typeof options.allow === "function" ? options.allow() : options.allow);
  const smtpUrl = env.OMB_SIGNIN_SMTP_URL?.trim();
  if (smtpUrl) {
    return mailedSignIn(allow, createSignInMail({ url: smtpUrl, from: env.OMB_SIGNIN_SMTP_FROM,
      ...(options.mailTransport ? { transport: options.mailTransport } : {}) }));
  }
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
      if (!email) return { ok: false, status: 400, ...userError("serverError.email.invalid") };
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
          return { ok: false, status: 400, ...userError("serverError.email.codeFormat") };
        }
        if (error instanceof ControlPlaneError && error.status === 429) {
          return { ok: false, status: 429, ...userError("serverError.email.tooMany") };
        }
        if (error instanceof ControlPlaneError && (error.status === 400 || error.status === 401 || error.status === 403)) {
          return { ok: false, status: 401, ...userError("serverError.email.codeWrong") };
        }
        return unavailable(error);
      }
      void controlPlane()
        .signOut(verified.accountToken)
        .catch(() => undefined);
      const scopes = allowedScopes(verified.user.email, allow());
      if (!scopes) return NOT_WELCOME;
      return { ok: true, email: verified.user.email, userId: verified.user.id, scopes };
    },
  };
}

function mailedSignIn(allow: () => SignInAllowList, mail: SignInMail): EmailSignIn {
  return {
    enabled: () => signInEnabled(allow()),
    async start(rawEmail, target) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) return { ok: false, status: 400, ...userError("serverError.email.invalid") };
      if (!allowedScopes(email, allow())) return NOT_WELCOME;
      try {
        if ((await mail.send(email, target)) === "tooSoon") return { ok: false, status: 429, ...userError("serverError.email.tooMany") };
      } catch (error) {
        console.warn(`sign-in code not sent: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, status: 502, ...userError("serverError.email.unavailable", { detail: error instanceof SignInMailError ? error.message : "the mail server refused it" }) };
      }
      return { ok: true };
    },
    async verify(rawEmail, code) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email || !allowedScopes(email, allow())) return NOT_WELCOME;
      const checked = mail.check(email, code);
      if (checked === "format") return { ok: false, status: 400, ...userError("serverError.email.codeFormat") };
      if (checked === "tooMany") return { ok: false, status: 429, ...userError("serverError.email.tooMany") };
      if (checked === "wrong") return { ok: false, status: 401, ...userError("serverError.email.codeWrong") };
      const scopes = allowedScopes(email, allow());
      return scopes ? { ok: true, email, userId: `email:${email}`, scopes } : NOT_WELCOME;
    },
  };
}

function unavailable(error: unknown): SignInFailure {
  const detail = error instanceof ControlPlaneError ? `${error.code}${error.status ? ` (${error.status})` : ""}` : error instanceof Error ? error.message : String(error);
  return { ok: false, status: 502, ...userError("serverError.email.unavailable", { detail }) };
}
