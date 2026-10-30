import { useEffect, useSyncExternalStore } from "react";

import { api } from "@/state/store";

export interface McpServerSummary {
  name: string;
  enabled: boolean;
  /** The bot whose own server this is. */
  bot?: string;
  /** The bots it is off for, because it doesn't start for them. */
  offFor?: string[];
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

export function updateMcpServers(servers: McpServerSummary[]): void {
  generation += 1;
  inflight = null;
  cached = { servers: servers.map(({ name, enabled, bot, offFor }) => ({ name, enabled: Boolean(enabled), ...(bot ? { bot } : {}), ...(offFor?.length ? { offFor } : {}) })), error: false };
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

export function useMcpServers(): { servers: McpServerSummary[] | null; error: boolean; refresh: () => Promise<McpServerSummary[]> } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void loadMcpServers(true);
  }, []);
  return { ...current, refresh: () => loadMcpServers(true) };
}

/** The servers a bot can be given: every bot's, and its own. */
export function mcpServersOfBot(all: McpServerSummary[], botId: string): McpServerSummary[] {
  return all.filter((server) => !server.bot || server.bot === botId);
}

export function mcpServersForBot(all: McpServerSummary[], own: string[] | null | undefined, botId: string): McpServerSummary[] {
  const enabled = mcpServersOfBot(all, botId).filter((server) => server.enabled);
  if (own == null) return enabled;
  return enabled.filter((server) => own.includes(server.name));
}
