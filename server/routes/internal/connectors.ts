// Connected apps: the MCP relay, connection-request cards, and the shared
// credential handoff. Bodies moved verbatim from ../internal.ts; the
// dispatch chain there owns order.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import * as composio from "../../composio.ts";
import { CREDENTIAL_TARGETS, credentialIsConfigured, isCredentialTargetId, isReusableCredentialRequest, type CredentialTargetId } from "../../../shared/credential-request.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type ConnectorsCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  cfg: InternalRoutesOptions["cfg"];
  credentialDesktopHandoff: InternalRoutesOptions["credentialDesktopHandoff"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  maybeResumeConnectors: InternalRoutesOptions["maybeResumeConnectors"];
}

const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;

export async function requestCredential(ctx: ConnectorsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, cfg, credentialDesktopHandoff, connectorThread, internalCapability, internalSender, json, readInternalBody,
  } = ctx;
    const body = await readInternalBody();
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    const owner = connectorThread(from.id, fromThreadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    if (!isCredentialTargetId(body.credentialId)) {
      return json(res, 400, { error: "unsupported credential id" });
    }
    const credentialId: CredentialTargetId = body.credentialId;
    const target = CREDENTIAL_TARGETS[credentialId];
    if (credentialIsConfigured(cfg, credentialId)) {
      return json(res, 200, { alreadyConfigured: true, label: target.label });
    }
    const existing = store.activePath(fromThreadId).find((message) =>
      isReusableCredentialRequest(message, credentialId, from.id, Boolean(owner.group))
    );
    if (existing) {
      if (!existing.text?.trim()) {
        store.patchMessage(fromThreadId, existing.id, {
          text: credentialDesktopHandoff(target.label),
        });
      }
      return json(res, 200, { messageId: existing.id, label: target.label });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
    const message = store.appendMessage(fromThreadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(target.label),
      ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: credentialId,
        label: target.label,
        description: `${reason ? `${target.description} ${reason}` : target.description} ${from.name} can use it but never read it back.`,
        placeholder: target.placeholder,
        helpUrl: target.helpUrl,
        requestKey: randomUUID(),
      },
    });
    return json(res, 201, { messageId: message.id, label: target.label });
}

export async function connectorsMcp(ctx: ConnectorsCtx, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const {
    store, cfg, internalCapability, json, readInternalBody,
  } = ctx;
    const body = await readInternalBody();
    // Reading a streamed MCP body yields to ordinary settings requests.
    // Re-read the live bot immediately before relay so turning Connected
    // Apps off wins over a request that authenticated under the old value.
    const currentSender = store.bot(internalCapability.botId);
    if (!currentSender || currentSender.composio === false || !composio.configured(cfg)) {
      return json(res, 403, { error: "connected apps are not enabled for this bot" });
    }
    const upstream = await composio.relayMcp(
      cfg,
      body,
      Array.isArray(req.headers["mcp-session-id"])
        ? req.headers["mcp-session-id"][0]
        : req.headers["mcp-session-id"],
    );
    const headers: Record<string, string> = {
      "content-type": upstream.contentType,
      "cache-control": "no-store",
    };
    if (upstream.transportSessionId) headers["mcp-session-id"] = upstream.transportSessionId;
    res.writeHead(upstream.status, headers);
    res.end(Buffer.from(upstream.bytes));
    return true;
}

export async function connectorsRequest(ctx: ConnectorsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, cfg, connectorThread, maybeResumeConnectors, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
    const body = await readInternalBody();
    const botId = String(body.botId ?? "");
    const threadId = String(body.threadId ?? "");
    const resumeKey = String(body.resumeKey ?? "");
    const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.slugs) ? body.slugs : [];
    const items: { slug: string; alias?: string }[] = [];
    for (const raw of rawItems as unknown[]) {
      if (typeof raw === "string") {
        const slug = raw.trim().toLowerCase();
        if (CONNECTOR_SLUG.test(slug)) items.push({ slug });
        continue;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as { slug?: unknown; toolkit?: unknown; alias?: unknown; account?: unknown };
      const slug = typeof row.slug === "string" ? row.slug : typeof row.toolkit === "string" ? row.toolkit : undefined;
      if (!slug || !CONNECTOR_SLUG.test(slug.toLowerCase())) continue;
      const alias = composio.normalizeAccountAlias((row.alias ?? row.account) as string | undefined);
      items.push({ slug: slug.toLowerCase(), ...(alias ? { alias } : {}) });
    }
    const slugs = [...new Set(items.map((item) => item.slug))];
    const owner = connectorThread(botId, threadId);
    if (!owner) return json(res, 403, { error: "conversation does not belong to this bot" });
    if (!/^[\w-]{8,100}$/.test(resumeKey)) return json(res, 400, { error: "invalid resume key" });
    if (!items.length || items.length > 12) return json(res, 400, { error: "one to twelve valid connection requests are required" });
    if (!composio.configured(cfg) || owner.bot.composio === false) {
      return json(res, 409, { error: "connected apps are not enabled for this bot" });
    }
    const connectionState: Record<string, { connected?: boolean }> = await composio.connectionStatus(cfg, slugs).catch(() => ({}));
    requireActiveInternalCapability();
    const messageIds: string[] = [];
    for (const item of items) {
      const existing = store.messagesFor(threadId).find(
        (message) => message.connector?.resumeKey === resumeKey && message.connector.slug === item.slug
          && (message.connector.alias ?? "").toLowerCase() === (item.alias ?? "").toLowerCase(),
      );
      if (existing) {
        messageIds.push(existing.id);
        continue;
      }
      const toolkit = await composio.toolkitCard(cfg, item.slug);
      requireActiveInternalCapability();
      const connected = connectionState[item.slug]?.connected === true;
      const status = item.alias ? "required" : connected ? "connected" : "required";
      const description = item.alias
        ? `Connect ${toolkit.label} as “${item.alias}” so the bot can continue`
        : toolkit.blurb || `Connect ${toolkit.label} so the bot can continue`;
      const message = store.appendMessage(threadId, {
        role: "bot",
        kind: "connector",
        ...(owner.group ? { from: { botId: owner.bot.id, name: owner.bot.name, color: owner.bot.color } } : {}),
        connector: {
          slug: item.slug,
          label: toolkit.label,
          description,
          status,
          resumeKey,
          ...(item.alias ? { alias: item.alias } : {}),
        },
      });
      messageIds.push(message.id);
    }
    maybeResumeConnectors(botId, threadId, resumeKey);
    return json(res, 200, { messageIds });
}
