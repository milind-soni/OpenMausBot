// Which GitHub connection a template's private import or repository publish uses: the team's (or this computer's) own,
// or, when a Team Cloud has each person connect GitHub themselves, the requesting person's. Security: the team's Rules
// apply as they do to a bot's app calls, and the relay goes to the connected-apps service from here, so no token reaches
// the app or a model.
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import { CONNECT_GITHUB, type GithubConnection } from "../share-github-repo.ts";
import { asPerson, type PersonAppsAccess } from "../team-connections.ts";

export interface ShareGithubAccessDeps {
  cfg(): AppConfig;
  composio: Pick<typeof Composio, "configured" | "connectedServices" | "relayMcp">;
  /** The apps each person connects for themselves (only on a Team Cloud). */
  personApps(): readonly string[];
  appsAccess(person: string): PersonAppsAccess | null;
  /** Why the team's Rules refuse an app; null when they allow it. */
  appRefusal(slug: string): string | null;
}

const APP = "github";

export function createShareGithubAccess(deps: ShareGithubAccessDeps) {
  /** The connection for `person` (the request's or the turn's; null for none). */
  return async function githubConnection(person: string | null): Promise<GithubConnection> {
    const refused = deps.appRefusal(APP);
    if (refused) return { ok: false, reason: "refused", message: refused };
    let [cfg, access] = [deps.cfg(), undefined as ReturnType<typeof asPerson>[1]];
    if (!deps.composio.configured(cfg)) return { ok: false, reason: "not_connected", message: CONNECT_GITHUB };
    if (deps.personApps().includes(APP)) {
      const own = person ? deps.appsAccess(person) : null;
      if (!own) return { ok: false, reason: "not_connected", message: CONNECT_GITHUB };
      [cfg, access] = asPerson(cfg, own);
    }
    let state;
    try {
      state = (await deps.composio.connectedServices(cfg, access))[APP];
    } catch {
      return { ok: false, reason: "unavailable", message: "Apps can't be reached right now. Try again in a few minutes." };
    }
    const active = (state?.accounts ?? []).filter((account) => /^active$/i.test(account.status));
    if (!state?.connected || !active.length) return { ok: false, reason: "not_connected", message: CONNECT_GITHUB };
    return {
      ok: true,
      ...(active.length > 1 ? { account: active[0]!.id } : {}),
      relay: (payload, session, signal) => deps.composio.relayMcp(cfg, payload as never, session, undefined, signal, access),
    };
  };
}
export type ShareGithubAccess = ReturnType<typeof createShareGithubAccess>;
