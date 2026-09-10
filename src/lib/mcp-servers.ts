// The app-wide MCP server list (Plugins → MCP servers), shared by every
// place that shows it per bot, such as the Access section's switches.
// One fetch, cached for the window; `refresh` after
// the Plugins panel changes the list.
import { useEffect, useSyncExternalStore } from "react";

import { api } from "@/state/store";

export interface McpServerSummary {
  name: string;
  enabled: boolean;
}

let cached: { servers: McpServerSummary[] | null; error: boolean } = { servers: null, error: false };
let inflight: Promise<McpServerSummary[]> | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const snapshot = () => cached;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Publish an authoritative read or mutation result without another request. */
export function updateMcpServers(servers: McpServerSummary[]): void {
  generation += 1;
  inflight = null;
  cached = { servers: servers.map(({ name, enabled }) => ({ name, enabled: Boolean(enabled) })), error: false };
  for (const listener of listeners) listener();
}

export function loadMcpServers(force = false): Promise<McpServerSummary[]> {
  if (!force && cached.servers && !cached.error) return Promise.resolve(cached.servers);
  if (!force && inflight) return inflight;
  const requestGeneration = ++generation;
  inflight = api("/api/mcp/servers")
    .then((result) => {
      if (requestGeneration === generation) updateMcpServers(result.servers ?? []);
      return cached.servers ?? [];
    })
    .catch(() => {
      if (requestGeneration === generation) {
        cached = { ...cached, error: true };
        for (const listener of listeners) listener();
      }
      return cached.servers ?? [];
    })
    .finally(() => {
      if (requestGeneration === generation) inflight = null;
    });
  return inflight;
}

/** The list, or null until the first load settles. Re-renders when any
 * caller refreshes it. */
export function useMcpServers(): { servers: McpServerSummary[] | null; error: boolean; refresh: () => Promise<McpServerSummary[]> } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    // Keep the instant cached view, but pick up edits from another window
    // or the config CLI whenever Access is opened again.
    void loadMcpServers(true);
  }, []);
  return { ...current, refresh: () => loadMcpServers(true) };
}

/** The servers a bot actually mounts: its own list when it has one (names
 * that no longer exist fall away), else every enabled server. Mirrors
 * server/config.ts customMcpServers so the controls and the turn agree. */
export function mcpServersForBot(all: McpServerSummary[], own: string[] | null | undefined): McpServerSummary[] {
  const enabled = all.filter((server) => server.enabled);
  if (own == null) return enabled;
  return enabled.filter((server) => own.includes(server.name));
}
