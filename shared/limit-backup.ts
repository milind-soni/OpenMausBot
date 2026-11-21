/** Engines a person signs in to with a subscription whose usage limit refuses turns. */
const SUBSCRIPTION_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "grokAgent"]);

type Engine = { instanceId: string; driverKind: string };

/** `other` is another sign-in to `main`'s subscription engine. At `main`'s usage limit it never takes over (rotating
 * accounts to get past a provider's usage limit breaks its terms), unless it bills each use instead of drawing on a
 * plan; it still takes over while `main` is signed out. */
export function otherSignInOfSameSubscription(main: Engine, other: Engine): boolean {
  return other.instanceId !== main.instanceId && other.driverKind === main.driverKind && SUBSCRIPTION_DRIVERS.has(main.driverKind);
}
