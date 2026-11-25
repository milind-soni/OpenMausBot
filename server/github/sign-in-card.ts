// The one call git and GitHub tools make when a clone, fetch or push failed for want of a GitHub sign-in: the chat shows
// a Connect GitHub card where the work stopped. Never call it ahead of a failure. Until the server provides the cards,
// nothing is shown.
import type { GithubCardRaised, GithubSignInCards, GithubSignInFailure } from "../host/github-sign-in-cards.ts";

let cards: Pick<GithubSignInCards, "raise"> | null = null;

export function provideGithubSignInCards(provided: Pick<GithubSignInCards, "raise"> | null): void {
  cards = provided;
}

export function raiseGithubSignInCard(at: Parameters<GithubSignInCards["raise"]>[0], failure: GithubSignInFailure): Promise<GithubCardRaised | null> {
  return cards ? cards.raise(at, failure) : Promise.resolve(null);
}
