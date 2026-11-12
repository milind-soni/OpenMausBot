// GET /api/cloud-send: Send to My Cloud's comparison of this server (server/cloud-send.ts), or of one item with `item`;
// /api/cloud-send/chats/*: its chats, by row (server/cloud-send-chats.ts); GET /api/cloud-send/manifest: all a move
// carries, to check it by (server/cloud-send-manifest.ts); on a Cloud home, POST /api/cloud-send/verify-secrets: the
// credentials' fingerprints (server/cloud-send-verify.ts); a move's own kinds, memory and bot files
// (server/cloud-send-kinds.ts, cloud-send-memory.ts, cloud-send-files.ts), and what My Cloud keeps once a move is done and
// what this computer says once the bots came home (server/cloud-send-arrived.ts), and the lease that lets one computer at a
// time move in (server/cloud-send-lease.ts). Admin scope (request-auth's default):
// the owner's app reads them on this computer and on their own Cloud.
import { z } from "zod";

import { botAvatarUrlSchema } from "../../shared/bot-avatar.ts";
import { readAttachment } from "../attachments.ts";
import { arrivedRoute, automationsOffRoute, homeRoute } from "../cloud-send-arrived.ts";
import { moveFilesRoute } from "../cloud-send-files.ts";
import { createMoveLeases, moveLeaseRoute } from "../cloud-send-lease.ts";
import { createMoveScopes, moveScopeRoute } from "../cloud-send-scope.ts";
import { automatedBot, moveBotParts, moveItems, moveKindsRoute, type MoveKindsDeps } from "../cloud-send-kinds.ts";
import { cloudSendManifest } from "../cloud-send-manifest.ts";
import { moveMemoryRoute, type MoveMemoryDeps } from "../cloud-send-memory.ts";
import { cloudSendSummary, partHash, type CloudSendSources } from "../cloud-send.ts";
import { cloudSendChatsRoute, type CloudSendChatsDeps } from "../cloud-send-chats.ts";
import { loginFingerprints, VERIFY_NONCE } from "../cloud-send-verify.ts";
import type { AppConfig } from "../config.ts";
import { TEAM_READER, type VaultStore } from "../vault-store.ts";
import type { MoveAutomations } from "../move-freeze.ts";
import { threadHeads } from "../message-db.ts";
import type { LineLanguage } from "../server-lines.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { ServerErrorBody } from "../../shared/server-text.ts";
import type { BotRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudSendRouteDeps extends Pick<CloudSendSources, "appVersion" | "bots" | "skills"> {
  messagesTail(threadId: string, limit: number): { messages: ReadonlyArray<{ role: string; text?: string }>; hasMore: boolean };
  logins: Pick<VaultStore, "changes" | "get" | "listSecrets" | "secret" | "onePasswordConnectedAt" | "onePasswordGrants" | "onePasswordToken">;
  config(): Pick<AppConfig, "profile" | "language">;
  lineLanguage?: LineLanguage;
  chats?: CloudSendChatsDeps;
  /** This server is the person's own Cloud: it answers what a move asks of the Cloud it moves to. */
  cloudHome?: boolean;
  /** A server of one person's own: it answers that person's session (`ownHome(auth)`) as a Cloud home answers its owner. */
  ownHome?(auth: RequestAuth): boolean;
  /** This server's connections (cloud-connections.ts), by id. */
  connections?(): Promise<ReadonlyArray<{ id: string }>>;
  connectionFingerprints?(nonce: string): Record<string, string>;
  /** The move ended: the person hears which connections stayed on the computer it came from. */
  connectionsMoved?(language?: string): void;
  /** What only a move carries: automations, skill extras and bot fields, memory, and bot files. */
  move?: MoveKindsDeps & Omit<MoveMemoryDeps, "bot" | "owner">;
  /** This server's automations, which a Cloud home stops for a computer whose bots go home to it. */
  automations?: MoveAutomations;
  /** A team's server: nothing of one person's computer moves in, and every send or move route answers this but to a
   * sign-in that moves one bot in (`scope`). */
  refusal?: ServerErrorBody;
  /** The one bot a request's sign-in moves into this team, which every read here is kept to; null for any other. */
  scope?(auth: RequestAuth): string | null;
}

export function createCloudSendRoutes(deps: CloudSendRouteDeps): RouteHandler {
  const sources: CloudSendSources = {
    appVersion: deps.appVersion,
    bots: deps.bots,
    greetingOnly: (threadId, name) => {
      const tail = deps.messagesTail(threadId, 2);
      return !tail.hasMore && tail.messages.length === 1 && tail.messages[0]!.role === "bot" && Boolean(tail.messages[0]!.text?.includes(name));
    },
    inRoom: (botId) => (deps.chats?.store.groups ?? []).some((group) => !group.dm && group.memberIds.includes(botId)),
    automated: (botId) => Boolean(deps.move && automatedBot(deps.move, botId)),
    skills: deps.skills,
    picture: (avatarUrl) => botAvatarUrlSchema.safeParse(avatarUrl).success ? readAttachment(avatarUrl.slice("/api/attachments/".length))?.bytes ?? null : null,
    logins: () => deps.logins.changes(),
    secrets: () => deps.logins.listSecrets(TEAM_READER),
    onePassword: () => {
      const connectedAt = deps.logins.onePasswordConnectedAt();
      return connectedAt === null ? null : { connectedAt, grants: deps.logins.onePasswordGrants() };
    },
    settings: () => { const { profile, language } = deps.config(); return { profile, language }; },
    ...(deps.move ? { move: { items: (bots: ReadonlySet<string>, only?: BotRecord) => moveItems(deps.move!, bots, only), botParts: (bot: BotRecord) => moveBotParts(bot, partHash) } } : {}),
  };
  const move = deps.move;
  const leases = createMoveLeases();
  const scopes = createMoveScopes();
  return async (ctx) => {
    const { req, res, path, method, url, json, readBody } = ctx;
    if (path !== "/api/cloud-send" && !path.startsWith("/api/cloud-send/")) return PASS;
    const home = deps.cloudHome === true || deps.ownHome?.(ctx.auth) === true;
    const scoped = deps.scope?.(ctx.auth) ?? null;
    if (deps.refusal && !scoped) { req.resume(); return json(res, 403, deps.refusal); }
    // A move of one bot into a team reads that bot only, on both sides.
    const bot = scoped ?? (/^[\w-]{1,128}$/u.test(url.searchParams.get("bot") ?? "") ? url.searchParams.get("bot")! : undefined);
    const scopeToken = url.searchParams.get("scope");
    const scope = scopeToken === null ? undefined : scopes.get(scopeToken);
    if (scope === null) { req.resume(); return json(res, 409, { error: "This move's bots are no longer known here." }); }
    if (await moveScopeRoute(scopes, ctx)) return;
    if (deps.chats && await cloudSendChatsRoute({ ...deps.chats, ...(bot ? { bot } : {}), ...(scope ? { scope } : {}) }, ctx)) return;
    if (move && await moveKindsRoute(move, ctx)) return;
    if (move && await moveMemoryRoute({ ...move, bot: (id) => move.store.bot(id) ?? undefined }, ctx)) return;
    if (move && await moveFilesRoute({ dataDir: move.dataDir, bots: () => (bot ? move.store.bots.filter((entry) => entry.id === bot) : scope ? move.store.bots.filter((entry) => scope.has(entry.id)) : move.store.bots), owner: move.owner }, ctx)) return;
    if (move && home && await moveLeaseRoute({ leases, owner: move.owner }, ctx)) return;
    if (move && home && await arrivedRoute({ dataDir: move.dataDir, store: move.store, webhooks: move.webhooks, owner: move.owner, lineLanguage: deps.lineLanguage ?? (() => deps.config().language), ...(deps.connectionsMoved ? { stayed: deps.connectionsMoved } : {}) }, ctx)) return;
    if (move && deps.cloudHome && deps.automations && await automationsOffRoute({ automations: deps.automations, owner: move.owner }, ctx)) return;
    if (move && !deps.cloudHome && await homeRoute({ dataDir: move.dataDir, store: move.store, webhooks: move.webhooks }, ctx)) return;
    if (path === "/api/cloud-send/manifest") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.chats) return json(res, 404, { error: "not found" });
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { vault: 1, ...await cloudSendManifest({ summary: () => cloudSendSummary(sources, { move: true, leaving: !home, ...(bot ? { bot } : {}), ...(scope ? { bots: scope } : {}) }), store: deps.chats.store, dataDir: deps.chats.dataDir,
        connections: deps.connections ?? (async () => []), heads: threadHeads, ...(move ? { kinds: move, teamMemory: move.teamMemory } : {}), ...(bot ? { bot } : {}),
        attachments: url.searchParams.get("attachments") !== "0", files: url.searchParams.get("files") !== "0", ...(scope ? { scope } : {}) }) });
    }
    if (path === "/api/cloud-send/verify-secrets") {
      if (!home || !deps.connectionFingerprints) return json(res, 404, { error: "not found" });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const asked = z.object({ nonce: z.string().regex(VERIFY_NONCE) }).safeParse(await readBody(req, 4096));
      if (!asked.success) return json(res, 400, { error: "send { nonce }: at least 32 random bytes, base64url" });
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { v: 1, vault: 1, secrets: { ...loginFingerprints(asked.data.nonce, deps.logins), ...deps.connectionFingerprints(asked.data.nonce) } });
    }
    if (path !== "/api/cloud-send") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    res.setHeader("cache-control", "no-store");
    const summary = cloudSendSummary(sources, { move: url.searchParams.get("move") === "1", leaving: !home, ...(bot ? { bot } : {}), ...(scope ? { bots: scope } : {}) });
    const item = url.searchParams.get("item");
    const items = item === null ? summary.items : summary.items.filter((entry) => entry.key === item || (entry.kind === "skill" && item === `bot:${entry.bot}`));
    // `chats: 1`: this server takes chats by row. `vault: 1`: it keeps saved Vault secrets under the id they are sent with.
    return json(res, 200, { ...summary, items, vault: 1, ...(deps.chats ? { chats: 1 } : {}) });
  };
}
