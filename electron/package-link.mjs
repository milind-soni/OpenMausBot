const ALLOWED_PACKAGE_HOSTS = new Set(["github.com", "www.github.com", "raw.githubusercontent.com"]);

export function packageUrlFromDeepLink(rawValue) {
  let link;
  try {
    link = new URL(String(rawValue));
  } catch {
    return null;
  }
  if (link.protocol !== "openmausbot:" || link.hostname !== "install") return null;
  const rawPackage = link.searchParams.get("url");
  if (!rawPackage) return null;
  let packageUrl;
  try {
    packageUrl = new URL(rawPackage);
  } catch {
    return null;
  }
  if (
    packageUrl.protocol !== "https:" ||
    packageUrl.username ||
    packageUrl.password ||
    packageUrl.port ||
    !ALLOWED_PACKAGE_HOSTS.has(packageUrl.hostname) ||
    !packageUrl.pathname.match(/\.(?:md|json)$/)
  ) return null;
  return packageUrl.toString();
}

export function packageUrlFromCommandLine(argv) {
  for (const value of argv) {
    const parsed = packageUrlFromDeepLink(value);
    if (parsed) return parsed;
  }
  return null;
}
