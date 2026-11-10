// MCP servers from the chat: the mcp_server route for one bot in one conversation, the card a change waits on below Full
// access, the Sign in card, and the servers as Settings lists them.
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";

import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import { appendDecision } from "../decision-log.ts";
import { json } from "../harness/http.ts";
import type { ManagedDesktopPolicy } from "../managed-policy.ts";
import { mcpOAuthRedirectUri, type McpOAuthManager } from "../mcp-oauth.ts";
import type { LentMcp } from "../lent-mcp.ts";
import { listMcpServers } from "../mcp-registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import { applyMcpChange, otherBotsGiven, showMcpActivity, type InternalMcpDeps } from "../routes/internal-mcp.ts";
import type { BotRecord, Store } from "../store.ts";
import { workspaceDir } from "../workspace.ts";
import type { McpConfig } from "./mcp-config.ts";
import { McpRequestService } from "./mcp-requests.ts";
import type { McpServersHost } from "./mcp-servers-host.ts";
import { createMcpSignInCards } from "./mcp-sign-in-cards.ts";
import type { SecretCards } from "./secret-cards.ts";
import type { TeamConnectionsHost } from "./team-connections-host.ts";

export interface McpChatDeps {
  store: Store;
  cfg: AppConfig;
  mcpOAuth: McpOAuthManager;
  teamConnections: TeamConnectionsHost;
  mcpServersHost: McpServersHost;
  managedPolicy: ManagedDesktopPolicy;
  /** Built after this module, so read when used. */
  secretCards(): SecretCards;
  /** Built after this module, so read when used. */
  mcpConfig(): McpConfig;
  teamCloud: boolean;
  threadLanguage(threadId: string): string | undefined;
  answerCardNode(threadId: string, messageId: string, text: string): boolean;
  followCard(threadId: string, from: string, to: string): void;
  fullAccessForSource(botId: string, threadId: string): boolean;
  cloudGuestDriven(threadId: string): boolean;
  liveTurnByThread: ReadonlyMap<string, string>;
  broadcast(payload: Record<string, unknown>): void;
  publicOrigins(): ReadonlyArray<string | null | undefined>;
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  /** MCP servers that run on a computer lent here. Built after this module, so read when used. */
  lending?(): Pick<LentMcp, "place" | "principal" | "given">;
}

const mcpServerUrl = (server: object) => ("url" in server && typeof server.url === "string" ? server.url : undefined);

export function createMcpChat(deps: McpChatDeps) {
  const { store, cfg, mcpOAuth, teamConnections, mcpServersHost, managedPolicy, threadLanguage, answerCardNode, fullAccessForSource, cloudGuestDriven, liveTurnByThread, broadcast } = deps;
  const mcpRequests = new McpRequestService({
    store, teamCloud: deps.teamCloud, language: threadLanguage,
    apply: async (request, fields) => {
      const bot = store.bot(request.botId);
      return bot ? applyMcpChange(mcpServerDeps(bot, request.threadId), request, fields) : { state: "failed", text: "This bot no longer exists." };
    },
    answer: answerCardNode,
    decide: (row) => appendDecision(DATA_DIR, { ...row, botName: store.bot(row.botId)?.name, tool: "mcp_server", source: row.decision === "card-shown" ? "no-grant" : "user" }),
  });

  const mcpSignInCards = createMcpSignInCards({
    store, cfg: () => cfg, mcpOAuth,
    personal: () => teamConnections.personMcp(),
    turnPerson: (threadId) => teamConnections.turnPerson(threadId),
    oauthFor: (person) => teamConnections.people.oauth(person),
    personName: (person) => teamConnections.nameOf(person),
    publicOrigins: deps.publicOrigins,
    language: threadLanguage,
    answer: answerCardNode,
    followCard: deps.followCard,
    threadVisible: deps.threadVisible,
    changed: () => broadcast({ kind: "mcp.changed" }),
  });

  async function resolveAndSendMcp(res: ServerResponse, args: { botId: string; threadId: string; requestId: string; behavior: string }, ownerReview: boolean): Promise<boolean> {
    const outcome = await mcpRequests.respond(args, ownerReview);
    if (!outcome) return false;
    json(res, outcome.status, outcome.body);
    return true;
  }

  /** The mcp_server route for one bot in one conversation. `generation` is the live turn's; absent when the person's answer
   * to a card applies the change. */
  function mcpServerDeps(sender: BotRecord, threadId: string, generation?: string): Omit<InternalMcpDeps, "readBody"> {
    const from = store.groupByThread(threadId) ? { botId: sender.id, name: sender.name, color: sender.color } : undefined;
    return {
      sender, threadId,
      fullAccess: () => fullAccessForSource(sender.id, threadId),
      guestDriven: () => cloudGuestDriven(threadId),
      teamAdmin: () => teamConnections.actsForAdmin(threadId, generation),
      canUse: (name) => canUseMcpServer(sender.toolScope, name),
      config: deps.mcpConfig(), cfg: () => cfg, personal: () => teamConnections.personMcp(),
      authState: (name, url) => mcpOAuth.authState(name, url),
      managedBy: mcpManagedBy, policyRefusal: mcpPolicyRefusal, addRefusal: () => managedPolicy.botMcpRefusal(),
      signOut: async (name, url) => { await mcpOAuth.signOut(name, url); broadcast({ kind: "mcp.changed" }); },
      testAs: (name, url) => {
        const person = teamConnections.turnPerson(threadId, generation);
        return person ? teamConnections.people.connection(person, name, url) : null;
      },
      redeem: (body) => deps.secretCards().redeemMcpServer(body, sender.id, threadId),
      addToBotList: (name) => { const bot = store.bot(sender.id); if (bot?.mcpServers) store.patchBot(bot.id, { mcpServers: [...new Set([...bot.mcpServers, name])] }); },
      botAdd: (current, body) => mcpServersHost.botAdd(current, body, sender.id),
      botKeep: (server) => mcpServersHost.botKeep(server, sender.id),
      ownCwd: () => (existsSync(workspaceDir(sender.id)) ? workspaceDir(sender.id) : DATA_DIR),
      decide: (summary, applied) => appendDecision(DATA_DIR, { threadId, botId: sender.id, botName: sender.name, tool: "mcp_server", summary, decision: "auto-approved", source: applied }),
      activity: (label, call) => showMcpActivity(store, { threadId, turnId: liveTurnByThread.get(threadId), ...(from ? { from } : {}) }, call, label),
      language: () => threadLanguage(threadId),
      usedBy: (name) => {
        const lent = deps.lending?.();
        return otherBotsGiven(store.bots, sender, (bot) =>
          (mcpServersHost.given(bot).includes(name) || Boolean(lent?.given(bot).includes(name))) && canUseMcpServer(bot.toolScope, name));
      },
      requestApproval: ({ action, name, subtitle, targetHash, fields }) => mcpRequests.propose({ action, name, botId: sender.id, threadId, targetHash }, subtitle, fields, from),
      requestSignIn: (name, server) => mcpSignInCards.request({ bot: sender, threadId, ...(from ? { from } : {}) }, name, server),
      ...lentDeps(sender, threadId, generation),
    };
  }

  /** In a live turn, whose lent computers it may use, and where a server it adds that needs the person's computer runs. */
  function lentDeps(sender: BotRecord, threadId: string, generation: string | undefined): Pick<InternalMcpDeps, "lender" | "place"> {
    const lending = deps.lending?.();
    if (!lending || !generation) return {};
    const lender = () => lending.principal({ botId: sender.id, threadId, generation });
    return { lender, place: (server, computer) => lending.place(server, { principal: lender(), ...(computer ? { computer } : {}) }) };
  }

  function mcpServerResponse() {
    const policy = managedPolicy.current();
    const servers = listMcpServers(cfg.mcpServers).map((server) => {
      if (!("url" in server)) return server;
      const auth = mcpOAuth.authState(server.name, server.url);
      const listed = server.oauth ? { ...server, oauth: { ...server.oauth, redirectUri: mcpOAuthRedirectUri(server.url) } } : server;
      return auth === "none" ? listed : { ...listed, auth };
    }).map(mcpServersHost.listing).map((server) => {
      const managedBy = mcpManagedBy(server.name, server);
      return managedBy ? { ...server, managedBy } : server;
    });
    return { servers, ...(policy && !policy.mcp.allowCustom ? { managed: { organizationName: policy.organizationName, allowlist: policy.mcp.allowlist } } : {}) };
  }
  function mcpPolicyRefusal(name: string, server: object): string | undefined {
    return managedPolicy.mcpRefusal(name, mcpServerUrl(server));
  }
  /** The organisation whose policy leaves this server out, if one does. */
  function mcpManagedBy(name: string, server: object): string | undefined {
    return managedPolicy.mcpAllowed(name, mcpServerUrl(server), "bot" in server && Boolean(server.bot)) ? undefined : managedPolicy.current()?.organizationName;
  }

  return { mcpRequests, mcpSignInCards, mcpServerDeps, resolveAndSendMcp, mcpServerResponse, mcpPolicyRefusal };
}
