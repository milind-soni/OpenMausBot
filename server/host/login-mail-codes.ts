// The mailboxes fill_login may look in for one turn, and what it remembers between calls.
// Security: on a Team Cloud a Gmail or Outlook that each person connects for themselves is read only for the turn acting
// for that person in a chat that is theirs alone (acting-person.ts, team-connections-host.ts), and the bot's own app
// switches and tool grants apply as they do to its own reads. A code and a message's words stay in the server, so a
// conversation that used one has read no outside text.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { connectorAccessDecision } from "../../shared/connector-scopes.ts";
import { writeFileAtomic } from "../atomic.ts";
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import { createConnectedReads, GMAIL_FETCH_TOOL, GMAIL_MESSAGE_TOOL, OUTLOOK_LIST_TOOL, OUTLOOK_MESSAGE_TOOL, type MailApp, type MailBodySession } from "../connected-reads.ts";
import { evaluateConnectorTools } from "../connector-verdict.ts";
import { readMessage, recentInbox, type EmailGuard } from "../email/client.ts";
import type { EmailBot } from "../email/host.ts";
import type { EmailAccount } from "../email/store.ts";
import { waitForEmailCode, type CodeMailbox } from "../email-code.ts";
import type { EmailCodeAnswer, EmailCodeAsk } from "../login-fill.ts";
import type { BrokerAccess } from "../team-connections.ts";
import type { ConnectorCardAnswer } from "./connector-cards.ts";

export const MAIL_CARD_FILE = "email-code-card.json";
const LIST_LIMIT = 20;
const ACCOUNTS_PER_APP = 3;
/** A code box already on the page when fill_login is called was asked for by a step before it; this is how far back. */
const ASKED_BEFORE_CALL_MS = 120_000;
const REMEMBER_ASK_MS = 15 * 60_000;
const REMEMBER_USED_MS = 30 * 60_000;
const READS: Record<MailApp, readonly [string, string]> = { gmail: [GMAIL_FETCH_TOOL, GMAIL_MESSAGE_TOOL], outlook: [OUTLOOK_LIST_TOOL, OUTLOOK_MESSAGE_TOOL] };

type Turn = { botId: string; threadId: string; generation: string };
type Bot = EmailBot;

export interface LoginMailCodesDeps {
  dataDir: string;
  cfg(): AppConfig;
  composio: Pick<typeof Composio, "configured" | "connectedServices" | "relayMcp">;
  /** The apps each person connects for themselves here (only on a Team Cloud). */
  personApps(): readonly string[];
  /** The member this turn may use the own connections of, or null. */
  turnPerson(threadId: string, generation: string): string | null;
  appsAccess(person: string): BrokerAccess | null;
  appAllowed(slug: string): boolean;
  /** The IMAP mailboxes this bot may read. */
  imapAccounts(bot: Bot): readonly EmailAccount[];
  imapGuard: EmailGuard;
  /** A routine or automation is running this turn, so nobody is there to press a card. */
  unattended(threadId: string): boolean;
  connectCard(turn: Turn, input: { botId: string; threadId: string; items: string[]; resumeKey: string }): Promise<ConnectorCardAnswer>;
  run?: Partial<{ recentInbox: typeof recentInbox; readMessage: typeof readMessage }>;
}

export type MailCardOffer = { shown: boolean; line?: string };

function readAsked(file: string): Map<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { asked?: Record<string, number> };
    return new Map(Object.entries(parsed.asked ?? {}).filter(([, at]) => typeof at === "number"));
  } catch {
    return new Map();
  }
}

export function createLoginMailCodes(deps: LoginMailCodesDeps) {
  const run = { recentInbox, readMessage, ...deps.run };
  const askedFile = join(deps.dataDir, MAIL_CARD_FILE);
  const asked = readAsked(askedFile);
  const asks = new Map<string, number>();
  const used = new Map<string, number>();

  const usedKey = (site: string, code: string) => createHash("sha256").update(`${site}\0${code}`).digest("hex");
  const forgetOld = (map: Map<string, number>, before: number) => { for (const [key, at] of map) if (at < before) map.delete(key); };
  const mayRead = (bot: Bot, app: MailApp): boolean => deps.appAllowed(app) && READS[app].every((slug) =>
    connectorAccessDecision(bot.connectorScopes, [{ slug }], [app]).ok && evaluateConnectorTools([slug], bot.connectorTools, [app]).allowed);

  function imapBox(account: EmailAccount): CodeMailbox {
    return {
      list: async (sinceMs) => (await run.recentInbox(account, deps.imapGuard, { sinceMs, limit: LIST_LIMIT })).map((mail) => ({ id: String(mail.uid), at: mail.at, from: mail.from, subject: mail.subject })),
      body: async (id) => (await run.readMessage(account, deps.imapGuard, { mailbox: "INBOX", uid: Number(id) })).text,
    };
  }

  function appBox(app: MailApp, reads: MailBodySession): CodeMailbox {
    if (app === "gmail") return { list: async (sinceMs) => (await reads.emails(sinceMs, LIST_LIMIT)).emails, body: (id) => reads.messageBody(id) };
    return { list: (sinceMs) => reads.outlookEmails(sinceMs, LIST_LIMIT), body: (id) => reads.outlookBody(id) };
  }

  async function appBoxes(turn: Turn, app: MailApp): Promise<CodeMailbox[]> {
    const cfg = deps.cfg();
    let access: BrokerAccess | undefined;
    if (deps.personApps().includes(app)) {
      const person = deps.turnPerson(turn.threadId, turn.generation);
      if (!person) return [];
      access = deps.appsAccess(person) ?? undefined;
      if (!access) return [];
    }
    const state = (await deps.composio.connectedServices(cfg, access))[app];
    if (!state?.connected) return [];
    const active = (state.accounts ?? []).filter((one) => /^active$/i.test(one.status));
    // Composio refuses a read that names no account when an app has several.
    const accounts: Array<string | undefined> = active.length > 1 ? active.slice(0, ACCOUNTS_PER_APP).map((one) => one.id) : [undefined];
    return accounts.map((account) => appBox(app, createConnectedReads({
      connected: async () => null,
      ...(account ? { accounts: async () => ({ [app]: account }) } : {}),
      relay: (payload, session, signal) => deps.composio.relayMcp(cfg, payload as never, session, undefined, signal, access),
    }).session()));
  }

  /** `unknown`: a connected-apps lookup failed, so "none connected" can't be said. */
  async function mailboxes(bot: Bot, turn: Turn): Promise<{ boxes: CodeMailbox[]; unknown: boolean }> {
    const boxes = deps.imapAccounts(bot).slice(0, ACCOUNTS_PER_APP).map(imapBox);
    let unknown = false;
    if (deps.composio.configured(deps.cfg()) && bot.composio !== false) {
      for (const app of ["gmail", "outlook"] as const) {
        if (!mayRead(bot, app)) continue;
        try { boxes.push(...await appBoxes(turn, app)); } catch { unknown = true; }
      }
    }
    return { boxes, unknown };
  }

  return {
    async find(bot: Bot, turn: Turn, ask: EmailCodeAsk, active: () => boolean): Promise<EmailCodeAnswer> {
      if (ask.via === "other") return { kind: "skip" };
      const started = ask.now();
      forgetOld(asks, started - REMEMBER_ASK_MS);
      forgetOld(used, started - REMEMBER_USED_MS);
      const key = `${turn.threadId}\0${ask.site}`;
      const askedAt = ask.askedAt ?? asks.get(key) ?? started - ASKED_BEFORE_CALL_MS;
      asks.set(key, askedAt);
      const { boxes, unknown } = await mailboxes(bot, turn);
      if (!boxes.length) return unknown ? { kind: "miss", why: "unreadable" } : ask.via === "email" ? { kind: "no-mailbox" } : { kind: "skip" };
      const found = await waitForEmailCode(boxes, {
        site: ask.site, askedAt, ...(ask.boxes > 1 ? { boxes: ask.boxes } : {}), isUsed: (code) => used.has(usedKey(ask.site, code)), active, now: ask.now, sleep: ask.sleep,
      });
      if (found.kind === "miss") return found;
      return { kind: "code", code: found.code, typed: () => { used.set(usedKey(ask.site, found.code), ask.now()); asks.delete(key); } };
    },

    /** Offers the Gmail connect card once per person, ever; a person told where to connect counts as offered. */
    async offerConnect(bot: Bot, turn: Turn): Promise<MailCardOffer> {
      if (deps.unattended(turn.threadId)) return { shown: false };
      const person = deps.turnPerson(turn.threadId, turn.generation);
      const onTeam = deps.personApps().includes("gmail");
      const who = person ?? "home";
      if (asked.has(who)) return { shown: false };
      const remember = () => {
        asked.set(who, Date.now());
        try { writeFileAtomic(askedFile, `${JSON.stringify({ v: 1, asked: Object.fromEntries(asked) })}\n`, { mode: 0o600 }); } catch (error) {
          console.warn(`email codes: could not save ${askedFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const answer = await deps.connectCard(turn, { botId: bot.id, threadId: turn.threadId, items: ["gmail"], resumeKey: randomUUID() });
      if (answer.status === 200) { remember(); return { shown: true }; }
      if (answer.status === 409 && onTeam) {
        if (person) remember();
        return { shown: false, line: answer.body.error };
      }
      return { shown: false };
    },
  };
}

export type LoginMailCodes = ReturnType<typeof createLoginMailCodes>;
