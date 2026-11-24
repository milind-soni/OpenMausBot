// GitHub sign-in (server/github/sign-in.ts; shapes in shared/github-sign-in.ts). Whose sign-in a request reaches:
//   - off a Team Cloud, the server's one, for its owner or an admin (ownerOrAdmin): a client session gets 403;
//   - on a Team Cloud, the session's own member's (sessionMember → personKey of their address), so these paths are in
//     CLIENT_ALLOW; the loopback, a device session and anyone without a membership get 403, and no request ever reaches
//     another person's or the team's.
// No answer ever carries a token. Changes must come from this server's own page.
import { GITHUB_SIGN_IN_PATH } from "../../shared/github-sign-in.ts";
import { GithubSignInError, type GithubSignIn } from "../github/sign-in.ts";
import { personKey } from "../person-key.ts";
import { fromBrowser, isSameOrigin, ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { sessionMember } from "./team-phone.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface GithubSignInRouteDeps {
  signIn: Pick<GithubSignIn, "status" | "start" | "cancel" | "saveToken" | "signOut">;
  /** This server is a Team Cloud: each member signs in for themselves. */
  team: boolean;
}

const ACTIONS = new Set(["start", "cancel", "token", "sign-out"]);
const TOKEN_BODY_MAX = 4 * 1024;

/** Whose sign-in this request may reach, or null. */
export function githubAudience(auth: RequestAuth, team: boolean): string | null {
  if (!team) return ownerOrAdmin(auth) ? "owner" : null;
  const member = auth.kind === "session" ? sessionMember(auth.session) : null;
  return member ? personKey({ id: "", email: member.member.email }) : null;
}

export function createGithubSignInRoutes(deps: GithubSignInRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== GITHUB_SIGN_IN_PATH && !path.startsWith(`${GITHUB_SIGN_IN_PATH}/`)) return PASS;
    const action = path === GITHUB_SIGN_IN_PATH ? null : path.slice(GITHUB_SIGN_IN_PATH.length + 1);
    if (action !== null && !ACTIONS.has(action)) return json(res, 404, { error: "not found" });
    if (method !== (action === null ? "GET" : "POST")) return json(res, 405, { error: "method not allowed" });
    res.setHeader("cache-control", "no-store");
    const audience = githubAudience(auth, deps.team);
    if (!audience) {
      return json(res, 403, { error: deps.team ? "Sign in to this team's Cloud to connect your own GitHub." : "Only the owner or an admin of this server can connect GitHub." });
    }
    if (action !== null && fromBrowser(req) && !isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
    try {
      switch (action) {
        case null: return json(res, 200, await deps.signIn.status(audience, { check: url.searchParams.get("check") === "1" }));
        case "start": return json(res, 200, await deps.signIn.start(audience));
        case "cancel": return json(res, 200, await deps.signIn.cancel(audience));
        case "sign-out": return json(res, 200, await deps.signIn.signOut(audience));
        default: {
          const body = await readBody(req, TOKEN_BODY_MAX).catch(() => null) as { token?: unknown } | null;
          if (typeof body?.token !== "string") return json(res, 400, { error: "Paste a GitHub token." });
          return json(res, 200, await deps.signIn.saveToken(audience, body.token));
        }
      }
    } catch (error) {
      if (error instanceof GithubSignInError) return json(res, error.status, { error: error.message });
      // Never the error's text: it could hold what gh or GitHub said about the token.
      return json(res, 500, { error: "GitHub sign-in did not work this time. Try again." });
    }
  };
}
