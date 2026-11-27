/** On a Team Cloud a bot's browser belongs to the conversation (a member's own, a group chat's or the team's), so every
 * view of it names the conversation shown. Elsewhere a bot has one browser and the views name nothing. */
export function browserScope(team: unknown, threadId: string | undefined): Record<string, string> {
  return team && threadId ? { threadId } : {};
}

export function withBrowserScope(path: string, scope: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams(scope).toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}
