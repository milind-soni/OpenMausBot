// The one-time move of this computer's connections to the person's own Cloud, in one object: its routes
// (routes/cloud-connections.ts), the private port's answers to the desktop's main process (login-handoff.ts), and what
// a bot on My Cloud is told about connections that need the person there (cloud-connections-prompt.ts).
import { hostname } from "node:os";

import { answerConnection, connectionFingerprints, highlevelDigest, launchersOnPath, listConnections, releaseConnection, signInDigest } from "./cloud-connections.ts";
import { createConnectionPrompt, type ConnectionPromptBot } from "./cloud-connections-prompt.ts";
import { movedFrom } from "./cloud-send-arrived.ts";
import * as composio from "./composio.ts";
import { adoptComposioShare, adoptOwnComposio, composioIdentity, composioShareCode } from "./composio-share.ts";
import type { AppConfig } from "./config.ts";
import type { HighLevelService } from "./highlevel/service.ts";
import type { ConnectionHandoffAnswer, ConnectionHandoffWhat } from "./login-handoff.ts";
import type { McpOAuthManager } from "./mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type McpRunsOn } from "./mcp-registry.ts";
import { personalConnectionRefusal, type CloudTeam } from "./cloud-team.ts";
import { createCloudConnectionRoutes } from "./routes/cloud-connections.ts";

export interface CloudConnectionsHostDeps {
  /** This server is the person's Cloud home, reached at this public origin. */
  cloudHome: { publicOrigin: string; team?: CloudTeam | null } | null;
  config(): AppConfig;
  /** This server's own environment id: the computer a server that needs it is marked as running on. */
  environmentId: string;
  mcpOAuth: Pick<McpOAuthManager, "authState" | "signInRecord" | "adopt" | "forget">;
  highlevel: Pick<HighLevelService, "store" | "connected" | "adopt" | "disconnect">;
  /** The engines (instance ids) ready to run here now. */
  engines(): Promise<string[]>;
  /** A trial's moved keys, unused while its Claude credit lasts. */
  heldKeys?: { hold(engines: readonly string[]): boolean } | null;
  /** This server's data folder, where a Cloud home keeps the computer its bots moved from. */
  dataDir?: string;
}

export function createCloudConnectionsHost(deps: CloudConnectionsHostDeps) {
  const label = (process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname()).slice(0, 120).trim() || "the person's computer";
  const computer: McpRunsOn = { environmentId: deps.environmentId, label };
  let commands: string[] | null = null;
  const mcpAuth = (name: string, url: string) => deps.mcpOAuth.authState(name, url);
  const sources = () => ({ config: deps.config(), mcpSignIn: (name: string, url: string) => deps.mcpOAuth.signInRecord(name, url), highlevel: () => deps.highlevel.store.get() });
  const composioConnected = async (slugs: string[]) =>
    Object.fromEntries(Object.entries(await composio.connectionStatus(deps.config(), slugs)).map(([slug, state]) => [slug, state.connected]));
  const prompt = deps.cloudHome ? createConnectionPrompt({ mcpServers: () => deps.config().mcpServers, mcpAuth,
    highlevelConnected: () => deps.highlevel.connected(), composioConnected, movedFrom: () => (deps.dataDir ? movedFrom(deps.dataDir)?.computer ?? null : null) }, deps.cloudHome.publicOrigin) : null;
  const connections = async () => {
    const cfg = deps.config();
    return listConnections({ config: cfg, mcpAuth, composio: await composioIdentity(cfg).catch(() => null), highlevel: () => deps.highlevel.store.get() });
  };

  return {
    connections,
    fingerprints: (nonce: string) => connectionFingerprints(nonce, sources()),
    routes: createCloudConnectionRoutes({
      cloudHome: deps.cloudHome !== null,
      ...(deps.cloudHome?.team ? { personalRefusal: (what: string) => personalConnectionRefusal(deps.cloudHome!.team!, what) } : {}),
      async list() {
        return { computer, connections: await connections(), engines: await deps.engines().catch((): string[] => []), commands: commands ??= launchersOnPath() };
      },
      adoptShare: adoptComposioShare,
      adoptOwn: (apiKey, userId) => adoptOwnComposio(deps.config(), apiKey, userId),
      composioConnected,
      adoptSignIn(name, record, replaces) {
        const raw = deps.config().mcpServers?.[name];
        const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
        if (!parsed?.ok || !isRemoteMcpServer(parsed.server)) return { ok: false, status: 404, error: "This MCP server is not here yet." };
        if (parsed.server.url !== record.url) return { ok: false, status: 409, error: "This MCP server has another address here." };
        return { ok: true, outcome: deps.mcpOAuth.adopt(name, parsed.server.url, record, replaces ? (current) => signInDigest(current.tokens) === replaces : undefined) };
      },
      adoptHighLevel: (connection, replaces) => ({ ok: true, outcome: deps.highlevel.adopt(connection, replaces ? (current) => highlevelDigest(current) === replaces : undefined) }),
      holdKeys: (engines) => deps.heldKeys?.hold(engines) ?? false,
    }),

    /** The private port's ask: one connection's secrets, a code for the person's Cloud to act as this computer's
     * connected-apps account, or letting go of a sign-in that moved. */
    async handoff(what: ConnectionHandoffWhat): Promise<ConnectionHandoffAnswer> {
      if (what.kind === "composio-share") {
        try { return { ok: true, share: { code: await composioShareCode(what.for) } }; }
        catch (error) { return { ok: false, error: error instanceof Error && error.message ? error.message.slice(0, 300) : "Connected apps could not be shared." }; }
      }
      if (what.kind === "connection-fingerprints") return { ok: true, secrets: connectionFingerprints(what.nonce, sources()) };
      if (what.kind === "connection-release") {
        return releaseConnection(what.id, what.digest, { ...sources(), forgetSignIn: (name) => deps.mcpOAuth.forget(name), forgetHighLevel: () => { deps.highlevel.disconnect(); } });
      }
      return answerConnection(what.id, sources());
    },

    prompt: (bot: ConnectionPromptBot): string => prompt?.(bot) ?? "",
  };
}
