export function shortPath(p: string, home: string | undefined): string {
  if (!home || !p.startsWith(home)) return p;
  const rest = p.slice(home.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : p;
}
