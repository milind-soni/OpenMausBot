// The one-time move of this computer's connections to the person's own Cloud, in one object: its routes
// (routes/cloud-connections.ts), the private port's answers to the desktop's main process (login-handoff.ts), and what
// a bot on My Cloud is told about connections that need the person there (cloud-connections-prompt.ts).
import { hostname } from "node:os";
import { join } from "node:path";

import { answerConnection, connectionFingerprints, launchersOnPath, listConnections, releaseConnection, signInDigest } from "./cloud-connections.ts";
import { createConnectionPrompt, type ConnectionPromptBot } from "./cloud-connections-prompt.ts";
import { createStayedNotices, type StayedNoticesDeps } from "./cloud-connections-stayed.ts";
import { movedFrom } from "./cloud-send-arrived.ts";
import * as composio from "./composio.ts";
import { brokerAccess } from "./composio-broker-access.ts";
import { adoptComposioShare, adoptOwnComposio, composioIdentity, composioShareCode } from "./composio-share.ts";
import type { AppConfig } from "./config.ts";
import type { EmailAccount } from "./email/store.ts";
import type { ConnectionHandoffAnswer, ConnectionHandoffWhat } from "./login-handoff.ts";
import type { McpOAuthManager } from "./mcp-oauth.ts";
import type { RequestAuth } from "./request-auth.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type McpRunsOn } from "./mcp-registry.ts";
import { personalConnectionRefusal, type CloudTeam } from "./cloud-team.ts";
import { createCloudConnectionRoutes } from "./routes/cloud-connections.ts";

export interface CloudConnectionsHostDeps {
  /** This server is the person's Cloud home, reached at this public origin. */
  cloudHome: { publicOrigin: string; team?: CloudTeam | null } | null;
  /** A server of one person's own takes that person's connections as a Cloud home does. */
  ownHome?(auth: RequestAuth): boolean;
  config(): AppConfig;
  /** This server's own environment id: the computer a server that needs it is marked as running on. */
  environmentId: string;
  mcpOAuth: Pick<McpOAuthManager, "authState" | "signInRecord" | "adopt" | "forget">;
  /** The engines (instance ids) ready to run here now. */
  engines(): Promise<string[]>;
  /** A trial's moved keys, unused while its Claude credit lasts. */
  heldKeys?: { hold(engines: readonly string[]): boolean } | null;
  /** This server's data folder, where a Cloud home keeps the computer its bots moved from. */
  dataDir?: string;
  /** The person's mailboxes: what a move carries, and what takes them on the Cloud they move to. */
  email?: { accounts(): readonly EmailAccount[]; adopt(accounts: unknown[]): { adopted: number; kept: number } };
  /** How the person hears what stayed on their computer; a Cloud home only. */
  stayedNotices?: Pick<StayedNoticesDeps, "bots" | "say" | "notify" | "language" | "lent">;
}

const managedService = (): boolean => { try { return brokerAccess() !== null; } catch { return false; } };

export function createCloudConnectionsHost(deps: CloudConnectionsHostDeps) {
  const label = (process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname()).slice(0, 120).trim() || "the person's computer";
  const computer: McpRunsOn = { environmentId: deps.environmentId, label };
  let commands: string[] | null = null;
  const mcpAuth = (name: string, url: string) => deps.mcpOAuth.authState(name, url);
  const sources = () => ({ config: deps.config(), mcpSignIn: (name: string, url: string) => deps.mcpOAuth.signInRecord(name, url), email: () => deps.email?.accounts() ?? [] });
  const composioConnected = async (slugs: string[]) =>
    Object.fromEntries(Object.entries(await composio.connectionStatus(deps.config(), slugs)).map(([slug, state]) => [slug, state.connected]));
  const programs = () => (commands ??= launchersOnPath());
  const prompt = deps.cloudHome ? createConnectionPrompt({ mcpServers: () => deps.config().mcpServers, mcpAuth, programs,
    composioConnected, movedFrom: () => (deps.dataDir ? movedFrom(deps.dataDir)?.computer ?? null : null) }, deps.cloudHome.publicOrigin) : null;
  const stayed = deps.cloudHome && deps.dataDir && deps.stayedNotices ? createStayedNotices({ ...deps.stayedNotices, origin: deps.cloudHome.publicOrigin, file: join(deps.dataDir, "connectors-stayed-told.json"), servers: () => deps.config().mcpServers, programs, mailConnected: () => (deps.email?.accounts().length ?? 0) > 0 }) : null;
  const connections = async () => {
    const cfg = deps.config();
    return listConnections({ config: cfg, mcpAuth, composio: await composioIdentity(cfg).catch(() => null), email: () => deps.email?.accounts() ?? [] });
  };

  return {
    connections,
    fingerprints: (nonce: string) => connectionFingerprints(nonce, sources()),
    routes: createCloudConnectionRoutes({
      cloudHome: deps.cloudHome !== null,
      ...(deps.ownHome ? { ownHome: deps.ownHome } : {}),
      ...(deps.cloudHome?.team ? { personalRefusal: (what: string) => personalConnectionRefusal(deps.cloudHome!.team!, what) } : {}),
      async list() {
        return { computer, connections: await connections(), engines: await deps.engines().catch((): string[] => []), commands: programs(),
          ...(deps.cloudHome === null && !managedService() ? { managedApps: false as const } : {}) };
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
      ...(deps.email ? { adoptEmail: deps.email.adopt } : {}),
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
        return releaseConnection(what.id, what.digest, { ...sources(), forgetSignIn: (name) => deps.mcpOAuth.forget(name) });
      }
      return answerConnection(what.id, sources());
    },

    prompt: (bot: ConnectionPromptBot, lent?: ReadonlyMap<string, string>): string => prompt?.(bot, lent) ?? "",
    /** What stayed on the person's computer: said when the move ends, and in the first conversation with each bot. */
    moved: (language?: string): void => stayed?.moved(language),
    personTurn: (bot: Parameters<NonNullable<typeof stayed>["personTurn"]>[0], threadId: string): void => stayed?.personTurn(bot, threadId),
  };
}
