// What `claude auth status --json` says about the account a Claude instance runs on.
import type { ProviderSnapshot } from "../contracts.ts";
import { execCli } from "../procs.ts";
import { claudeBilling } from "./claude-billing.ts";

type ClaudeAuth = Pick<ProviderSnapshot, "authenticated" | "account" | "reason">;

/** An instance's sign-in as Settings shows it: `auth status`, else its last clear answer. The status keeps reporting a
 * stored claude.ai login Anthropic refuses (an expired session that could not refresh), so once a turn is refused that
 * login reads signed out until a new sign-in replaces it or it is gone. */
export function claudeLoginState(cli: string, run: typeof execCli = execCli) {
  let last: ClaudeAuth = {}, refused = false;
  return {
    refuse: () => { refused = true; },
    rejected: () => refused,
    renewed: () => { refused = false; },
    /** `ownLogin`: signing in again could fix it, not a company's or a custom endpoint's account. */
    async read(env: NodeJS.ProcessEnv, ownLogin: boolean): Promise<ClaudeAuth> {
      const probed = await claudeAuthStatus(cli, env, run);
      if (probed.authenticated !== undefined) last = probed;
      if (last.authenticated === false) refused = false;
      // An API key or Bedrock is not fixed by a claude.ai sign-in.
      return refused && last.authenticated === true && ownLogin && claudeBilling(env, last.account).billing === "subscription"
        ? { authenticated: false, reason: "Claude's sign-in has expired. Sign in again in Settings → AI." } : last;
    },
  };
}

/** Whether `claude` is signed in, per the CLI's own `auth status`: credential storage varies by
 * platform (Keychain, a JSON file) and presence checks accept stale credentials. Only `loggedIn: false`
 * means signed out. A check that timed out (a Keychain prompt left open) or gave no readable status
 * says nothing, so `authenticated` is left out. */
export function claudeAuthStatus(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<{ authenticated?: boolean; account?: ProviderSnapshot["account"] }> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, maxBuffer: 65_536, env }, (error, stdout) => {
      if ((error as { killed?: boolean } | null)?.killed) return resolve({});
      try {
        const status: unknown = JSON.parse(stdout);
        const loggedIn = status && typeof status === "object" && "loggedIn" in status ? status.loggedIn : undefined;
        if (loggedIn !== true) return resolve(loggedIn === false ? { authenticated: false } : {});
        const identity = status as { email?: unknown; orgName?: unknown; authMethod?: unknown };
        const boundedText = (value: unknown, max: number): string | undefined =>
          typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
            ? value.trim() : undefined;
        const candidateEmail = boundedText(identity.email, 254);
        const email = candidateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail) ? candidateEmail : undefined;
        const organization = boundedText(identity.orgName, 160);
        const account = {
          ...(email ? { email } : {}),
          ...(organization ? { organization } : {}),
          ...(identity.authMethod === "api_key" ? { method: "api-key" as const } : {}),
        };
        resolve({ authenticated: true, ...(Object.keys(account).length ? { account } : {}) });
      } catch {
        resolve({});
      }
    });
  });
}

export async function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return (await claudeAuthStatus(cli, env, run)).authenticated === true;
}
