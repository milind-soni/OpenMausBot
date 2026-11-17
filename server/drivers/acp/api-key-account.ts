// What an ACP engine's snapshot says about a provider key it runs on: a key in one of its credentialEnv variables
// (pasted in Connections or set in the server's environment) signs the engine in whatever its own login says, so
// signing that login out cannot disconnect it. Settings reads `account.method === "api-key"` and offers no Sign out.
type Env = Record<string, string | undefined>;

export function keyedBy(env: Env, names: readonly string[] | undefined): boolean {
  return (names ?? []).some((name) => typeof env[name] === "string" && env[name]!.trim() !== "");
}

export function apiKeyAccount(env: Env, names: readonly string[] | undefined, authenticated: boolean): { account?: { method: "api-key" } } {
  return authenticated && keyedBy(env, names) ? { account: { method: "api-key" } } : {};
}
