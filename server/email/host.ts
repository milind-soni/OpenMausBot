// What server/index.ts needs from the Email connector, in one object so the host file gains next to nothing: the per-turn
// mount, the prompt part, the internal MCP handler (per-bot verdict, decision rows, what a read marks) and the Cloud health
// merge. The tools run here, in the server: the box gets a turn's capability, never the password or a way to a mail server.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { EMAIL_MCP_SERVER, EMAIL_SLUG, type EmailToolName } from "../../shared/email.ts";
import { connectorAccessDecision, describeConnectorScopes, type ConnectorScopes } from "../../shared/connector-scopes.ts";
import type { ConnectorToolGrant } from "../../shared/wire.ts";
import { connectorRefusalText, connectorScopeRefusalText, evaluateConnectorTools } from "../connector-verdict.ts";
import { appendDecision } from "../decision-log.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import { boxUploadsDir } from "../bot-box/plan.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import { EmailError, LIST_MAX, listMailboxes, listMessages, readMessage, searchMessages, sendMessage } from "./client.ts";
import { EMAIL_INSTRUCTIONS, EMAIL_NOT_CONNECTED_TEXT, EMAIL_PROMPT, EMAIL_TO_CONNECT_PROMPT } from "./instructions.ts";
import type { EmailService } from "./service.ts";
import type { EmailAccount } from "./store.ts";
import { EMAIL_TOOLS, emailError, emailText, emailToolCallProblem, isEmailRead, isEmailToolName, type EmailTool, type EmailToolResult } from "./tools.ts";

export const EMAIL_INTERNAL_MCP_PATH = "/api/internal/email/mcp";

export interface EmailBot {
  id: string;
  name: string;
  color?: string;
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: ConnectorScopes;
}

export interface EmailHostDeps {
  service: EmailService;
  dataDir: string;
  bot(id: string): EmailBot | undefined | null;
  inRoom(threadId: string): boolean;
  appendMessage(threadId: string, message: Record<string, unknown>): void;
  /** Mail is outside text: the conversation that read some is outside work from then on (server/host/outside-lineage.ts). */
  markOutside(threadId: string): void;
  /** An organisation's policy can keep this app off. */
  appAllowed?(): boolean;
  /** Calls back on what the store changes. */
  onChange?(listener: (change: { type: string; threadId?: string; botId?: string }) => void): unknown;
  /** Test seams. */
  run?: Partial<{ listMailboxes: typeof listMailboxes; listMessages: typeof listMessages; searchMessages: typeof searchMessages; readMessage: typeof readMessage; sendMessage: typeof sendMessage }>;
}

/** Whether this bot gets the Email tools at all: off with connected apps off, or with a scope or grant record that leaves it out. */
export function emailAllowedFor(bot: Pick<EmailBot, "composio" | "connectorScopes" | "connectorTools">): boolean {
  if (bot.composio === false) return false;
  if (bot.connectorScopes && !Object.hasOwn(bot.connectorScopes.apps, EMAIL_SLUG)) return false;
  if (bot.connectorTools !== undefined && !Object.hasOwn(bot.connectorTools, EMAIL_SLUG)) return false;
  return true;
}

const action = (name: string) => { const words = name.replace(/^EMAIL_/u, "").replace(/_+/gu, " ").toLowerCase(); return words ? words[0]!.toUpperCase() + words.slice(1) : name; };

type Verdict = { ok: true; rule: string } | { ok: false; text: string; rule: string };

export function emailAccess(bot: EmailBot, name: string): Verdict {
  if (!emailAllowedFor(bot)) return { ok: false, rule: `scope:${EMAIL_SLUG}:app`, text: connectorScopeRefusalText({ kind: "tools", invoked: name, names: [name] }, "app", bot.name, "Email", action(name)) };
  const verdict = evaluateConnectorTools([name], bot.connectorTools, [EMAIL_SLUG]);
  if (!verdict.allowed) return { ok: false, rule: `connectorTools.${EMAIL_SLUG}`, text: connectorRefusalText(verdict.denials) };
  const access = connectorAccessDecision(bot.connectorScopes, [{ slug: name }], [EMAIL_SLUG]);
  if (!access.ok) return { ok: false, rule: `scope:${EMAIL_SLUG}:${access.reason}`, text: connectorScopeRefusalText({ kind: "tools", invoked: name, names: [name] }, access.reason, bot.name, "Email", action(name)) };
  return { ok: true, rule: verdict.legacy ? `scope:${EMAIL_SLUG}` : verdict.rule };
}

export function createEmailHost(deps: EmailHostDeps) {
  const { service } = deps;
  // A message's saved attachments go with the conversation, or the bot, that asked for them.
  deps.onChange?.((change) => {
    const root = join(deps.dataDir, "box-uploads");
    const gone = (path: string) => { try { rmSync(path, { recursive: true, force: true }); } catch (error) { console.warn("Email: a saved attachment could not be removed:", error); } };
    const id = (value: string | undefined): value is string => typeof value === "string" && /^[\w-]{1,128}$/u.test(value);
    if (change.type === "bot.deleted" && id(change.botId)) gone(join(root, change.botId));
    if (change.type === "thread.deleted" && id(change.threadId)) {
      let bots: string[] = [];
      try { bots = readdirSync(root); } catch {}
      for (const bot of bots) gone(join(root, bot, change.threadId));
    }
  });
  const run = { listMailboxes, listMessages, readMessage, searchMessages, sendMessage, ...deps.run };
  const allowedHere = () => deps.appAllowed?.() ?? true;
  const mounts = (bot: EmailBot) => allowedHere() && service.mounted() && emailAllowedFor(bot);

  function account(address: unknown): EmailAccount | EmailToolResult {
    const accounts = service.store.list();
    if (!accounts.length) return emailError(EMAIL_NOT_CONNECTED_TEXT);
    if (typeof address === "string" && address) return service.store.get(address) ?? emailError(`No mailbox ${address} is connected. Connected: ${accounts.map((one) => one.address).join(", ")}.`);
    if (accounts.length > 1) return emailError(`Say which mailbox with account: ${accounts.map((one) => one.address).join(", ")}.`);
    return accounts[0]!;
  }

  async function call(name: EmailToolName, args: Record<string, any>, mailbox: EmailAccount, capability: { botId: string; threadId: string }): Promise<EmailToolResult> {
    const { guard } = service;
    const box = typeof args.mailbox === "string" && args.mailbox ? args.mailbox : "INBOX";
    const limit = Math.min(args.limit ?? 20, LIST_MAX);
    const from = mailbox.address;
    switch (name) {
      case "EMAIL_LIST_MAILBOXES": return emailText({ account: from, mailboxes: await run.listMailboxes(mailbox, guard) });
      case "EMAIL_LIST_MESSAGES": return emailText({ account: from, mailbox: box, ...await run.listMessages(mailbox, guard, { mailbox: box, limit, ...(args.before_uid ? { beforeUid: args.before_uid } : {}) }) });
      case "EMAIL_SEARCH_MESSAGES": return emailText({ account: from, mailbox: box, ...await run.searchMessages(mailbox, guard, { mailbox: box, limit, ...pick(args, ["text", "from", "to", "subject", "since", "before", "unread"]) }) });
      case "EMAIL_READ_MESSAGE": return emailText({ account: from, mailbox: box, ...await run.readMessage(mailbox, guard, { mailbox: box, uid: args.uid, ...(args.save_attachments === true ? { saveTo: boxUploadsDir(deps.dataDir, capability.botId, capability.threadId) } : {}) }) });
      case "EMAIL_SEND_MESSAGE": {
        let threading = {};
        if (args.reply_to_uid) {
          const original = await run.readMessage(mailbox, guard, { mailbox: box, uid: args.reply_to_uid });
          if (original.messageId) threading = { inReplyTo: original.messageId };
        }
        return emailText({ account: from, ...await run.sendMessage(mailbox, guard, { to: args.to, subject: args.subject, text: args.text, ...pick(args, ["cc", "bcc"]), ...threading }) });
      }
    }
  }

  return {
    mounts,
    integration(bot: EmailBot, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null {
      if (!mounts(bot)) return null;
      return { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, EMAIL_MCP_SERVER], env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("email")]: mint(), OMB_HARNESS_URL: harnessUrl } };
    },
    prompt(bot: EmailBot): string {
      if (!allowedHere() || service.status().state === "unavailable" || !emailAllowedFor(bot)) return "";
      if (!service.mounted()) return EMAIL_TO_CONNECT_PROMPT;
      const scopes = bot.connectorScopes ? { apps: { [EMAIL_SLUG]: bot.connectorScopes.apps[EMAIL_SLUG]! } } : undefined;
      const grant = bot.connectorTools?.[EMAIL_SLUG];
      const granted = grant && grant.tools !== "*" ? ` Of the email tools, this bot was granted only: ${grant.tools.join(", ")}.` : "";
      return EMAIL_PROMPT(service.store.list().map((one) => one.address)) + granted + describeConnectorScopes(scopes);
    },
    toolListing: () => (service.status().state === "unavailable" ? null : { email: EMAIL_TOOLS.map(({ name, description }) => ({ name, description })) }),

    /** The JSON-RPC entry the harness proxy reaches: tools/list (what this bot may run) and tools/call (validate, verdict, run). */
    async handle(body: unknown, capability: { botId: string; threadId: string }, assertActive: () => void): Promise<{ tools: EmailTool[]; instructions: string } | EmailToolResult> {
      const request = (body ?? {}) as { method?: unknown; params?: unknown };
      // Re-read the live bot on every call, so a permission change wins over a request authenticated under the old one.
      const verdict = (name: string): Verdict => { const bot = deps.bot(capability.botId); return bot ? emailAccess(bot, name) : { ok: false, text: "This bot no longer exists.", rule: "bot" }; };
      if (request.method === "tools/list") {
        assertActive();
        return { tools: EMAIL_TOOLS.filter((tool) => verdict(tool.name).ok), instructions: EMAIL_INSTRUCTIONS };
      }
      if (request.method !== "tools/call") throw Object.assign(new Error("unsupported email method"), { status: 400 });
      const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const problem = emailToolCallProblem(params.name, args);
      if (problem || !isEmailToolName(params.name)) return emailError(problem ?? "Unknown Email tool.");
      const name = params.name;
      assertActive();
      const allowed = verdict(name);
      const bot = deps.bot(capability.botId);
      appendDecision(deps.dataDir, { threadId: capability.threadId, botId: capability.botId, ...(bot ? { botName: bot.name } : {}), tool: name, decision: allowed.ok ? "auto-approved" : "auto-denied", source: "connector-scope", rule: allowed.rule });
      if (!allowed.ok) return emailError(allowed.text);
      const mailbox = account(args.account);
      if ("content" in mailbox) return mailbox;
      // Before anything comes back: a failure halfway must not leave mail in a conversation not marked as outside work.
      if (isEmailRead(name)) deps.markOutside(capability.threadId);
      let result: EmailToolResult;
      try {
        result = await call(name, args, mailbox, capability);
      } catch (error) {
        const failed = error instanceof EmailError ? error : new EmailError("server", "The mail server did not finish this call.");
        if (failed.code === "password") service.store.markProblem(mailbox.address, mailbox.password, "The mail server stopped accepting this password. Connect it again.");
        return emailError(failed.code === "password"
          ? `The mail server stopped accepting the password for ${mailbox.address}. Ask the person to connect it again with request_credential, credential_id email, then end this turn.`
          : failed.message);
      }
      assertActive();
      if (mailbox.problem && !result.isError) service.store.markProblem(mailbox.address, mailbox.password, mailbox.smtp ? undefined : mailbox.problem);
      if (name === "EMAIL_SEND_MESSAGE" && !result.isError) {
        deps.appendMessage(capability.threadId, {
          role: "bot", kind: "activity", tool: { name: `mcp__${EMAIL_MCP_SERVER}__${name}`, ok: true, summary: serverLine(conversationLanguage(capability.threadId), "server.email.sent", { address: mailbox.address, count: (args.to as string[]).length }) },
          ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
        });
      }
      return result;
    },

    /** Merges {email:{connected}} into the Cloud health connectors report, only while a mailbox is saved. */
    health(base: Promise<Record<string, { connected: boolean; pending?: boolean }>> | null) {
      if (!service.mounted()) return base;
      const email = { connected: service.store.list().some((one) => !one.problem) };
      return (base ?? Promise.resolve({})).then((connectors) => ({ ...connectors, email }), () => ({ email }));
    },
  };
}

export type EmailHost = ReturnType<typeof createEmailHost>;

function pick<T extends Record<string, unknown>>(source: T, names: readonly string[]): Record<string, any> {
  return Object.fromEntries(names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));
}
