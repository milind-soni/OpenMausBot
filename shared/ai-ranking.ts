// Which of a person's AIs a new bot uses, and which one the welcome offers first: one ranking for the server's new-bot
// default and the welcome. A Claude account, then a ChatGPT plan, then Gemini, then Grok, then every other AI in the
// order the app lists them; OpenCode running only its free no-login models comes last, as a backup.

export interface RankableAi {
  driverKind: string;
  snapshot?: { freeFallback?: boolean };
}

/** What a test message through an AI showed: `untestable` is an AI with no one-off call to send one, trusted as before. */
export type AiTestState = "testing" | "passed" | "failed" | "untestable";

const TIERS: Readonly<Record<string, number>> = {
  claudeAgent: 0,
  codex: 1,
  geminiAgent: 2,
  antigravityAgent: 2,
  grokAgent: 3,
  grok: 3,
};
const OTHER = 4;
const FREE_FALLBACK = 5;

/** Ready only through OpenCode's free models: no login, no subscription, no key of the person's own. */
export function freeFallback(instance: RankableAi): boolean {
  return instance.snapshot?.freeFallback === true;
}

function tier(instance: RankableAi): number {
  return freeFallback(instance) ? FREE_FALLBACK : TIERS[instance.driverKind] ?? OTHER;
}

/** A new list, best first; AIs of one kind keep the order they came in. */
export function rankAis<T extends RankableAi>(instances: readonly T[]): T[] {
  return instances.map((instance, index) => ({ instance, index, tier: tier(instance) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ instance }) => instance);
}

interface SignInSnapshot {
  state: string;
  authenticated?: boolean;
  account?: { email?: string; organization?: string; method?: string };
  chatgptPlan?: boolean;
  freeFallback?: boolean;
}

/** Who an AI is signed in as: a test result holds until this changes. */
export function aiSignInKey(snapshot: SignInSnapshot): string {
  return JSON.stringify([
    snapshot.state, snapshot.authenticated ?? null, snapshot.account?.email ?? null, snapshot.account?.organization ?? null,
    snapshot.account?.method ?? null, snapshot.chatgptPlan === true, snapshot.freeFallback === true,
  ]);
}
