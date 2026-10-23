/** The paid tiers whose subscription runs a team's Cloud, as the Admin names them (its TEAM_TIERS). */
export const CLOUD_TEAM_TIERS = Object.freeze(["team", "business"]);

/** A connected account on a Team or Business plan with no My Cloud of its own: what it pays for is its team's Cloud, which
 * the session lists under `teams`, never as `machine`. */
export function teamPlan(state) {
  return state?.status === "connected" && !state.machine && state.entitlement?.plan === "pro" && CLOUD_TEAM_TIERS.includes(state.entitlement.tier ?? "");
}

/** The team that plan runs: the one this account owns, else the first the session lists; null for any other plan, and while
 * the session lists none yet (between the payment and its team). */
export function planTeam(state) {
  if (!teamPlan(state)) return null;
  const teams = Array.isArray(state.teams) ? state.teams : [];
  return teams.find((team) => team?.role === "owner") ?? teams[0] ?? null;
}
