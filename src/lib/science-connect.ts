import { benchlingTenantUrl, type CatalogEntry } from "../../shared/connector-catalog";
import type { LocaleKey } from "@/locales";
import { t } from "./i18n";
import { updateMcpServers } from "./mcp-servers";
import { runMcpSignIn, type McpSignInStatus } from "./mcp-sign-in";
import { catalogServerName, entryServer, scienceServers, serverConnected, type ScienceServer } from "./science-catalog";

export interface ConnectDeps {
  api(path: string, init?: RequestInit): Promise<any>;
  open(url: string): Promise<void>;
  signal: AbortSignal;
  servers(): ScienceServer[];
  onServers(listing: unknown[]): void;
  onSignIn(status: McpSignInStatus | null, complete?: (result: McpSignInStatus) => void): void;
}

export type ConnectResult = { ok: true } | { ok: false; error: string | null; relayRefused?: true };

const RELAY_REFUSALS: Partial<Record<number, LocaleKey>> = { 401: "science.relaySignInEnded", 402: "science.needsMax" };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const serverPath = (name: string) => `/api/mcp/servers/${encodeURIComponent(name)}`;

function publish(result: { servers?: unknown[] } | null | undefined, deps: ConnectDeps): ScienceServer[] {
  const listing = result?.servers ?? [];
  deps.onServers(listing);
  updateMcpServers(listing as Parameters<typeof updateMcpServers>[0]);
  return scienceServers(listing);
}

async function setEnabled(name: string, enabled: boolean, deps: ConnectDeps): Promise<void> {
  const result = await deps.api(serverPath(name), { method: "PATCH", body: JSON.stringify({ enabled }) });
  publish(result, deps);
}

export async function connectEntry(entry: CatalogEntry, deps: ConnectDeps, tenantAddress?: string): Promise<ConnectResult> {
  try {
    const existing = entryServer(entry, deps.servers());
    let name = existing?.name;
    if (!name) {
      const url = entry.auth === "tenant" ? benchlingTenantUrl(tenantAddress ?? "") : entry.url ?? null;
      if (!url) return { ok: false, error: t(entry.auth === "tenant" ? "science.tenantInvalid" : "science.noAddress") };
      const wanted = catalogServerName(entry.id, deps.servers().map((s) => s.name));
      const result = await deps.api("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify({ name: wanted, type: "http", url, enabled: false, catalog: { id: entry.id, auth: entry.auth } }),
      });
      const listing = publish(result, deps);
      name = (entryServer(entry, listing) ?? listing.find((s) => s.url === url))?.name ?? wanted;
    }
    if (deps.signal.aborted) return { ok: false, error: null };

    if (entry.auth !== "cloud" && existing?.auth !== "signed-in") {
      let signedIn: McpSignInStatus;
      try {
        signedIn = await runMcpSignIn(name, {
          api: deps.api,
          open: deps.open,
          signal: deps.signal,
          onStarted: (status, complete) => deps.onSignIn(status, complete),
        });
      } finally {
        deps.onSignIn(null);
      }
      if (signedIn.phase === "cancelled" || deps.signal.aborted) return { ok: false, error: null };
      if (signedIn.phase !== "succeeded") return { ok: false, error: signedIn.message || t("mcp.auth.failed") };
    }

    let tested: { ok?: boolean; error?: string; status?: number };
    try {
      tested = await deps.api(`${serverPath(name)}/test`, { method: "POST", signal: deps.signal });
    } catch (cause) {
      if (deps.signal.aborted) return { ok: false, error: null };
      tested = { ok: false, error: message(cause) };
    }
    if (!tested.ok) {
      const refusal = entry.auth === "cloud" && tested.status ? RELAY_REFUSALS[tested.status] : undefined;
      if (refusal) return { ok: false, error: t(refusal), relayRefused: true };
      const reason = (tested.error ?? "").trim();
      return { ok: false, error: t("science.testFailed", { reason: reason && !/[.!?]$/.test(reason) ? `${reason}.` : reason }) };
    }
    if (deps.signal.aborted) return { ok: false, error: null };
    await setEnabled(name, true, deps);
    return { ok: true };
  } catch (cause) {
    return deps.signal.aborted ? { ok: false, error: null } : { ok: false, error: message(cause) };
  }
}

export async function turnOff(server: ScienceServer, deps: ConnectDeps): Promise<void> {
  await setEnabled(server.name, false, deps);
}

export async function connectPublic(
  entries: CatalogEntry[],
  deps: ConnectDeps,
): Promise<Record<string, { ok: boolean; error: string | null }>> {
  const results: Record<string, { ok: boolean; error: string | null }> = {};
  for (const entry of entries) {
    if (deps.signal.aborted) break;
    if (serverConnected(entryServer(entry, deps.servers()))) {
      results[entry.id] = { ok: true, error: null };
      continue;
    }
    const result = await connectEntry(entry, deps);
    results[entry.id] = result.ok ? { ok: true, error: null } : { ok: false, error: result.error };
    if (!result.ok && result.relayRefused) break;
  }
  return results;
}
