// The GitHub sign-in for server-side callers (a git credential grant, opening a pull request), without reaching into
// index.ts. index.ts provides the one sign-in at start-up; until then, and where there is none, every answer is null.
// Security: the token is for the server's own calls only. Never log it, put it in a route's answer, or put it in a bot's
// environment or arguments.
import type { GithubSignIn } from "./sign-in.ts";

let current: Pick<GithubSignIn, "token" | "reportAuthFailure" | "signedIn"> | null = null;

export function provideGithubSignIn(signIn: Pick<GithubSignIn, "token" | "reportAuthFailure" | "signedIn"> | null): void {
  current = signIn;
}

/** The token for `audience`: off a Team Cloud the server's one (null, undefined or "owner"); on a Team Cloud a member's
 * person key (person-key.ts personKey of their address), and null for anything else: never another person's. */
export function githubToken(audience?: string | null): Promise<string | null> {
  return current ? current.token(audience) : Promise.resolve(null);
}

/** A git or GitHub call made with that token was refused (401): the next status asks GitHub again. */
export function reportGithubAuthFailure(audience?: string | null): void {
  current?.reportAuthFailure(audience);
}

/** Whether `audience` has a sign-in, from disk only (GithubSignIn.signedIn): false with none provided. */
export function githubSignedIn(audience?: string | null): boolean {
  return current ? current.signedIn(audience) : false;
}
