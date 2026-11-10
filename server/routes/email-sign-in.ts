import type { IncomingMessage, ServerResponse } from "node:http";

import type { EmailSignIn } from "../account-signin.ts";
import { json, readBody } from "../harness/http.ts";
import { labelFromUserAgent, requestOrigin, requestSource, serializeSessionCookie } from "../request-auth.ts";
import { cookieMaxAgeSeconds, type SessionRegistry } from "../sessions.ts";
import { refusalBody, userError } from "../user-errors.ts";

export interface EmailSignInRouteDeps {
  cloudHome: boolean;
  emailSignIn: EmailSignIn;
  sessions: Pick<SessionRegistry, "attemptAllowed" | "noteFailure" | "clearFailures" | "issue">;
  cookieName: string;
  environment(): unknown;
}

export async function emailSignInRoute(deps: EmailSignInRouteDeps, req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (method !== "POST" || (path !== "/api/auth/email/start" && path !== "/api/auth/email/verify")) return false;
  // Never on a Cloud home: it is personal, and the owner's devices sign in through the Admin.
  if (deps.cloudHome) {
    json(res, 403, { ...userError("serverError.cloud.personal"), code: "cloud_personal" });
    return true;
  }
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    json(res, 415, { error: "send the sign-in request as JSON (content-type: application/json)" });
    return true;
  }
  const { emailSignIn, sessions } = deps;
  if (!emailSignIn.enabled()) {
    json(res, 404, userError("serverError.email.notSetUp"));
    return true;
  }
  const source = requestSource(req);
  const allowed = sessions.attemptAllowed(source);
  if (!allowed.ok) {
    json(res, 429, userError("serverError.signIn.tooMany", { seconds: Math.ceil(allowed.retryAfterMs / 1000) }));
    return true;
  }
  const body = await readBody(req);
  const email = typeof body?.email === "string" ? body.email : "";
  if (path === "/api/auth/email/start") {
    const started = await emailSignIn.start(email);
    if (!started.ok) {
      if (started.status === 403) sessions.noteFailure(source);
      json(res, started.status, refusalBody(started));
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }
  const code = typeof body?.code === "string" ? body.code : "";
  const label = typeof body?.label === "string" ? body.label : "";
  const verified = await emailSignIn.verify(email, code);
  if (!verified.ok) {
    if (verified.status === 401 || verified.status === 403) sessions.noteFailure(source);
    console.warn(`email sign-in refused from ${source}: ${verified.error}`);
    json(res, verified.status, refusalBody(verified));
    return true;
  }
  sessions.clearFailures(source);
  const issued = sessions.issue({ label: label.trim() || labelFromUserAgent(req.headers["user-agent"]), scopes: verified.scopes, userId: verified.userId, email: verified.email });
  const secure = requestOrigin(req)?.startsWith("https://") === true;
  res.setHeader("set-cookie", serializeSessionCookie(deps.cookieName, issued.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(issued.session) }));
  json(res, 200, { session: issued.session, environment: deps.environment() });
  return true;
}
