export interface TeamRouteSettings {
  endpoint: string;
  token: string;
}

/** Read a service credential only for a top-level, user-facing Chief turn. */
export function teamRouteSettingsForTurn(
  eligible: boolean,
  env: NodeJS.ProcessEnv = process.env,
): TeamRouteSettings | undefined {
  if (!eligible || env.JACK_CONTROL_PLANE_TEAM_ROUTE_ENABLED !== "1") return undefined;
  const endpoint = env.JACK_CONTROL_PLANE_TEAM_ROUTE_ENDPOINT?.trim() ?? "";
  const token = env.JACK_CONTROL_PLANE_MAUSBOT_TOKEN?.trim() ?? "";
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname !== "/v1/team-route/suggest" || !token) return undefined;
    return { endpoint: parsed.toString(), token };
  } catch {
    return undefined;
  }
}
