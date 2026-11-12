// The Connect card in a chat, shown for a bot's request for an app and for fill_login when a page wants an emailed code.
import { connectorCardDescription, connectorCardText } from "../connector-card-text.ts";
import { connectorRequestItems } from "../connector-request-items.ts";
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { DecisionRow } from "../decision-log.ts";
import type { Store } from "../store.ts";

type Capability = { threadId: string; generation: string; connectorsFor?: string };
type Owner = { bot: { id: string; name: string; color: string; composio?: boolean; connectorScopes?: { apps: Record<string, unknown> } }; group?: unknown };

export interface ConnectorCardsDeps {
  cfg(): AppConfig;
  store: Pick<Store, "messagesFor" | "appendMessage">;
  composio: Pick<typeof Composio, "configured" | "prepareConnectionAuthConfigs" | "connectionStatus" | "toolkitCard">;
  connectorThread(botId: string, threadId: string): Owner | null;
  /** Why these apps can't be connected here, by policy or by whose they are on a Team Cloud. */
  refusal(capability: Capability, slugs: readonly string[]): string | null | undefined;
  decide(row: Omit<DecisionRow, "at">): void;
  language(threadId: string): string | undefined;
  maybeResume(threadId: string, resumeKey: string): void;
}

export type ConnectorCardAnswer = { status: 200; body: { messageIds: string[]; authConfigNote?: string; connectedNote?: string; nothingToSignIn?: boolean } } | { status: 400 | 403 | 409; body: { error: string } };

export function createConnectorCards(deps: ConnectorCardsDeps) {
  async function request(capability: Capability, input: { botId?: unknown; threadId?: unknown; resumeKey?: unknown; items?: unknown; slugs?: unknown }, requireActive: () => void): Promise<ConnectorCardAnswer> {
    const botId = String(input.botId ?? "");
    const threadId = String(input.threadId ?? "");
    const resumeKey = String(input.resumeKey ?? "");
    const items = connectorRequestItems(Array.isArray(input.items) ? input.items : Array.isArray(input.slugs) ? input.slugs : []);
    const slugs = [...new Set(items.map((item) => item.slug))];
    const owner = deps.connectorThread(botId, threadId);
    if (!owner) return { status: 403, body: { error: "conversation does not belong to this bot" } };
    if (!/^[\w-]{8,100}$/.test(resumeKey)) return { status: 400, body: { error: "invalid resume key" } };
    if (!items.length || items.length > 12) return { status: 400, body: { error: "one to twelve valid connection requests are required" } };
    const cfg = deps.cfg();
    if (!deps.composio.configured(cfg) || owner.bot.composio === false) return { status: 409, body: { error: "connected apps are not enabled for this bot" } };
    if (owner.bot.connectorScopes) {
      const outside = slugs.find((slug) => !owner.bot.connectorScopes?.apps[slug]);
      if (outside) {
        deps.decide({ threadId, botId: owner.bot.id, botName: owner.bot.name, tool: "COMPOSIO_MANAGE_CONNECTIONS", summary: outside, decision: "auto-denied", source: "connector-scope", rule: `scope:${outside}:app` });
        return { status: 403, body: { error: `${owner.bot.name} has not been given access to ${outside}; allow it under the bot's Access settings first` } };
      }
    }
    const scopedLine = deps.refusal(capability, slugs);
    if (scopedLine) return { status: 409, body: { error: scopedLine } };
    const authConfigNote = await deps.composio.prepareConnectionAuthConfigs(cfg, items);
    const connectionState: Record<string, { connected?: boolean }> = await deps.composio.connectionStatus(cfg, slugs).catch(() => ({}));
    requireActive();
    const messageIds: string[] = [];
    // Every requested app is already connected: no sign-in starts, so nothing waits on these cards and no "connected" update follows.
    const nothingToSignIn = items.every((item) => !item.alias && connectionState[item.slug]?.connected === true);
    // A card without an alias for an app that already has an account shows it connected; the bot must ask again with an alias to add another.
    const connectedNotes: string[] = [];
    for (const item of items) {
      const existing = deps.store.messagesFor(threadId).find(
        (message) => message.connector?.resumeKey === resumeKey && message.connector.slug === item.slug
          && (message.connector.alias ?? "").toLowerCase() === (item.alias ?? "").toLowerCase(),
      );
      if (existing) {
        messageIds.push(existing.id);
        continue;
      }
      const toolkit = await deps.composio.toolkitCard(cfg, item.slug);
      requireActive();
      const connected = connectionState[item.slug]?.connected === true;
      const status = item.alias ? "required" : connected ? "connected" : "required";
      if (status === "connected") {
        connectedNotes.push(`${toolkit.label} is already connected (it has an account, or needs no sign-in), so its card shows it connected and no new account was added. `
          + `To add another ${toolkit.label} account, call COMPOSIO_MANAGE_CONNECTIONS again with toolkits: [{"name": "${item.slug}", "alias": "<a short name for the new account>"}].`);
      }
      const language = deps.language(threadId);
      // The app catalog's own words, when it has some, are English; ours are in the person's language.
      const description = item.alias ? connectorCardDescription(toolkit.label, item.alias, language) : toolkit.blurb || connectorCardDescription(toolkit.label, undefined, language);
      const message = deps.store.appendMessage(threadId, {
        role: "bot",
        kind: "connector",
        text: connectorCardText(toolkit.label, item.alias, language),
        ...(owner.group ? { from: { botId: owner.bot.id, name: owner.bot.name, color: owner.bot.color } } : {}),
        connector: { slug: item.slug, label: toolkit.label, description, status, resumeKey, ...(item.alias ? { alias: item.alias } : {}), ...(nothingToSignIn ? { resumed: true } : {}) },
      });
      messageIds.push(message.id);
    }
    if (!nothingToSignIn) deps.maybeResume(threadId, resumeKey);
    const connectedNote = connectedNotes.join(" ");
    return { status: 200, body: { messageIds, ...(authConfigNote ? { authConfigNote } : {}), ...(connectedNote ? { connectedNote } : {}), ...(nothingToSignIn ? { nothingToSignIn } : {}) } };
  }
  return { request };
}

export type ConnectorCards = ReturnType<typeof createConnectorCards>;
