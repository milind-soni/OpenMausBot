/** ~ for the home folder, so a path reads at a glance. Only home itself or a
 * real child of home shortens — /Users/annex must not render as ~ex when home
 * is /Users/ann. */
export function shortPath(p: string, home: string | undefined): string {
  if (!home || !p.startsWith(home)) return p;
  const rest = p.slice(home.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : p;
}
