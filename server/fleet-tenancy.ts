import { assertDomain, type FleetRegistry } from "./fleet.ts";

const defaultHost = (registry: FleetRegistry, slug: string) => `${slug}.${registry.domain.toLowerCase()}`;

/** The workspace whose registry entry is `host`, whatever its status: a retained or half-built workspace still owns its address. */
function holderOf(registry: FleetRegistry, host: string): string | undefined {
  return Object.values(registry.workspaces).find((workspace) => workspace.host.toLowerCase() === host)?.slug;
}

function portalHostname(portalUrl: string): string | undefined {
  try { return new URL(portalUrl).hostname.toLowerCase(); } catch { return undefined; }
}

/** Throws a plain message before any step runs. With no `host` it still refuses a slug whose default address another workspace holds. */
export function assertWorkspaceHost(input: { registry: FleetRegistry; slug: string; host?: string; portalUrl?: string }): void {
  const { registry, slug } = input;
  const fallback = defaultHost(registry, slug);
  if (input.host === undefined) {
    const holder = holderOf(registry, fallback);
    if (holder) throw new Error(`${fallback} is already the web address of workspace "${holder}"; choose another workspace name`);
    return;
  }
  const shown = JSON.stringify(input.host.slice(0, 80));
  const host = input.host.toLowerCase();
  if (input.portalUrl) {
    throw new Error(host === portalHostname(input.portalUrl)
      ? `${shown} is the admin portal's address`
      : "--host cannot be combined with a portal (--portal-url): the portal serves its workspaces from their own names");
  }
  try {
    assertDomain(host);
  } catch {
    throw new Error(`${shown} is not a web address: use a plain domain name such as chat.acme.com, without a port, path, wildcard, trailing dot or IP address`);
  }
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`${shown} is not a public web address`);
  const apex = registry.domain.toLowerCase();
  if (host === apex) throw new Error(`${shown} is the fleet's own domain; a workspace needs a name under it or its own domain`);
  const holder = holderOf(registry, host);
  if (holder) throw new Error(`${host} is already the web address of workspace "${holder}" (${registry.workspaces[holder]!.status})`);
  if (host.endsWith(`.${apex}`) && host !== fallback) throw new Error(`${host} is under ${apex}, which is reserved for workspace names: use ${fallback} or an address on another domain`);
  const taken = holderOf(registry, fallback);
  if (taken) throw new Error(`${fallback} is already the web address of workspace "${taken}"; choose another workspace name`);
}

export function workspaceHostFor(registry: FleetRegistry, slug: string, host?: string): string {
  return host === undefined ? defaultHost(registry, slug) : host.toLowerCase();
}
