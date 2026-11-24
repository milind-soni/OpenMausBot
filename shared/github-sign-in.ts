// GitHub sign-in for the server's own git and GitHub actions (server/github/). What a client sees: never a token.
//   GET  /api/github/sign-in[?check=1]       → GithubSignInStatus   check=1: ask GitHub again whether the sign-in works
//   POST /api/github/sign-in/start           → GithubSignInStatus   the code to type at verificationUrl
//   POST /api/github/sign-in/cancel          → GithubSignInStatus
//   POST /api/github/sign-in/token {token}   → GithubSignInStatus   a pasted fine-grained token instead
//   POST /api/github/sign-in/sign-out        → GithubSignInStatus
export const GITHUB_SIGN_IN_PATH = "/api/github/sign-in";

/** Where the sign-in comes from: OpenMausBot's own GitHub CLI sign-in, a pasted token, or the person's own GitHub CLI
 * on this computer (which OpenMausBot reads and never changes). */
export type GithubSignInSource = "mausbot" | "token" | "cli";

/** How the last sign-in attempt ended, when it did not sign in. */
export interface GithubSignInLast {
  outcome: "expired" | "failed" | "cancelled";
  reason?: string;
  at: number;
}

export type GithubSignInStatus = { last?: GithubSignInLast } & (
  /** `download`: Start first fetches GitHub CLI (about 15 MB). */
  | { state: "signed-out"; download: boolean }
  /** Getting GitHub CLI (a download the first time) and the code ready: ask again shortly. */
  | { state: "installing" }
  | { state: "signing-in"; code: string; verificationUrl: string; expiresAt: number }
  | { state: "signed-in"; login: string; source: GithubSignInSource; scopes: string[]; orgs?: string[]; checkedAt: number | null }
  /** The saved sign-in no longer works (revoked, expired): sign in again. */
  | { state: "invalid"; login: string | null; source: GithubSignInSource; reason: string }
);
