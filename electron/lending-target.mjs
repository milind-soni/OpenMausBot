/** Which Clouds this computer is lent to, from the verified Cloud sign-in alone (no page names a server, account or
 * origin): `cloud(env)` is the sign-in's state as that saved place's lending checks it (another Cloud of the person's own
 * at its own address, any other place against My Cloud), `environment()` the saved server that is My Cloud, kept through
 * a brief disconnect of the same account, and `places()` the saved servers that are the person's own Clouds, My Cloud
 * first. Security: never a Team Cloud, nor a server that only signed in with their account (`isOwnCloud`). */
export function createLendingTarget({ account, environments }) {
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
      const home = environment();
      const others = environments().filter((entry) => entry.cloud && entry !== home && account()?.isOwnCloud?.(entry.origin));
      return home ? [home, ...others] : others;
    },
  };
}
