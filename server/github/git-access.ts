// Which GitHub sign-in a bot's git uses, and what a boxed spawn gets for it. Off a Team Cloud it is the server's one
// ("owner"). On a Team Cloud the host registers who a conversation is private to (cloud-team-host.ts): a member's own
// conversation gets that member's sign-in, a room's, the team's or a shared one gets none, and a process the bot's
// conversations share gets none. With no sign-in for that audience a spawn gets nothing at all: no grant, no env.
import { GITHUB_GRANT, githubGrant } from "../bot-box/broker-github.ts";
import type { BrokerGrant } from "../bot-box/broker.ts";
import { boxGitEnv } from "./git-env.ts";
import { conversationRepos } from "./git-repos.ts";
import { githubSignedIn, githubToken, reportGithubAuthFailure } from "./token.ts";

let memberOf: ((threadId: string) => string | null) | null = null;

/** On a Team Cloud: the person a conversation is private to, or null. Null takes it away (off a team). */
export function provideGitAudience(resolver: ((threadId: string) => string | null) | null): void {
  memberOf = resolver;
}

/** Whose sign-in git in `threadId` uses (null: a process several conversations share), or null for none. */
export function gitAudience(threadId: string | null): string | null {
  if (!memberOf) return "owner";
  if (!threadId) return null;
  try {
    return memberOf(threadId);
  } catch {
    return null;
  }
}

let processes = 0;

/** The github grant and git env for one boxed spawn, or null when its audience has no sign-in. The audience is asked
 * again on every request, so a conversation shared later stops getting the member's token at once. `folders`: where the
 * spawn works (its conversation's folder, a project folder), whose clones it may push to. */
export function boxGithubGit(threadId: string | null, folders: readonly string[]): { grant: BrokerGrant; env(input: { port: number; token: string }): Record<string, string> } | null {
  const audience = gitAudience(threadId);
  if (!audience || !githubSignedIn(audience)) return null;
  const repos = conversationRepos(threadId ? `thread:${threadId}` : `process:${++processes}`, folders);
  return {
    grant: githubGrant({ audience: () => gitAudience(threadId), token: (who) => githubToken(who), reportAuthFailure: (who) => reportGithubAuthFailure(who), mayPush: repos.mayPush, fetched: repos.fetched }),
    env: boxGitEnv,
  };
}

export { GITHUB_GRANT };
