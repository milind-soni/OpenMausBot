/** Which Clouds this computer is lent to, from the verified Cloud sign-in alone (no page names a server, account or
 * origin): `cloud(env)` is the sign-in's state as that saved place's lending checks it (another Cloud of the person's own
 * at its own address, any other place against My Cloud), `environment()` the saved server that is My Cloud, kept through
 * a brief disconnect of the same account, and `places()` the saved servers that are the person's own Clouds, My Cloud
 * first. `ownHome()`: a server of the person's own their bots moved to (own-home-main.mjs), lent as their Clouds are, bound
 * to that server's identity (`own:<environment id>` as its account), last. Security: never a Team Cloud, nor a server that
 * only signed in with their account (`isOwnCloud`), nor one connected by hand that the person did not make their home. */
export function createLendingTarget({ account, environments, ownHome = () => null }) {
  let lastHome = null;
  const mine = () => {
    const current = account();
    if (!current) return null;
    const state = current.state();
    const accountId = state.account?.id ?? null;
    const origin = state.status === "connected" ? (state.machine?.origin ?? null) : null;
    if (origin && accountId) lastHome = { accountId, origin };
    else if (!accountId || lastHome?.accountId !== accountId) lastHome = null;
    return { status: state.status === "signed-out" && state.message === "restoring" ? "restoring" : state.status, accountId, origin };
  };
  const cloud = (env = null) => {
    const own = ownHome();
    if (own && env?.origin === own.origin) return { status: "connected", accountId: `own:${own.environmentId}`, origin: own.origin };
    const base = mine();
    if (!base || !env?.cloud || base.origin === env.origin) return base;
    return account()?.isOwnCloud?.(env.origin) ? { ...base, origin: env.origin } : base;
  };
  const environment = () => {
    const snapshot = mine();
    const origin = snapshot?.origin ?? (lastHome?.accountId === snapshot?.accountId ? lastHome?.origin : null);
    return origin ? environments().find((entry) => entry.origin === origin) ?? null : null;
  };
  return {
    cloud,
    environment,
    places() {
      const home = environment(), own = ownHome();
      const others = environments().filter((entry) => entry.cloud && entry !== home && account()?.isOwnCloud?.(entry.origin));
      const theirs = own ? environments().filter((entry) => entry.origin === own.origin && !entry.cloud && !entry.team && !entry.home) : [];
      return [...(home ? [home] : []), ...others, ...theirs];
    },
  };
}
