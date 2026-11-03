export function createLendingTarget<E extends { origin: string; cloud?: { id: string } }>(deps: {
  account: () => { state(): { status: string; message?: string; account?: { id: string } | null; machine?: { origin?: string } | null }; isOwnCloud?(origin: string): boolean } | null | undefined;
  environments: () => E[];
  /** A server of the person's own their bots moved to, while home is there. */
  ownHome?: () => { origin: string; environmentId: string } | null;
}): {
  /** The sign-in as `env`'s lending checks it: another Cloud of the person's own at its own address, else My Cloud. */
  cloud(env?: E | null): { status: string; accountId: string | null; origin: string | null } | null;
  environment(): E | null;
  /** The saved places of the person's own Clouds, My Cloud first, and a server of theirs that is home; never a Team Cloud. */
  places(): E[];
};
